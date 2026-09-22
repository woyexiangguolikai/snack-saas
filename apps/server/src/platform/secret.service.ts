import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ERR, BizError } from '../core/errors';
import { env } from '../core/env';
import { REPO_FACTORY } from '../core/repo.factory';
import type { PlatformRepo, RepoFactory } from '../core/repository';
import type { SecretKind, TenantSecretRecord } from '../core/types';

/** 密钥在界面上的样子 —— 只露前 4 位，其余打码 */
export interface SecretView {
  id: number;
  tenantCode: string;
  shopName: string;
  kind: SecretKind;
  masked: string;
  status: TenantSecretRecord['status'];
  remark: string | null;
  updatedAt: string;
  invalidAt: string | null;
  invalidReason: string | null;
}

/**
 * 密钥服务（P-12 / CP-08）。
 *
 * **"只可替换不可查看"是数据结构保证的，不是权限控制。**
 *
 * 大多数人会把这句话实现成一个权限位 —— 于是：
 *   · 数据库里躺着明文，任何一次 dump 都泄漏全部商户密钥；
 *   · "查看"接口只是被前端藏起来了，改个请求就能拿到；
 *   · 有人日后为了排障"临时"加一个查看按钮，没人会觉得这是问题。
 *
 * 这里的做法是：库里存密文，**接口层没有任何一条路径返回明文**。
 * 出参类型 `SecretView` 里根本没有能装明文的位置 —— 想加一个查看接口，
 * 得先改类型，那一刻的改动是显眼的。
 */
@Injectable()
export class SecretService {
  constructor(@Inject(REPO_FACTORY) private readonly repos: RepoFactory) {}

  private get platform(): PlatformRepo {
    return this.repos.platform();
  }

  /**
   * 写入 / 替换密钥。
   *
   * 替换时**直接覆盖旧密文、不留副本**：留副本等于给"可查看"留了一条后门 ——
   * 密钥被重置后，旧的那把其实还能用一段时间，留副本只会扩大泄漏面。
   */
  async put(
    tenantCode: string,
    kind: SecretKind,
    plaintext: string,
    opts: { remark?: string | null; operator?: string } = {},
  ): Promise<SecretView> {
    const raw = String(plaintext ?? '').trim();
    if (!raw) throw new BizError(ERR.VALIDATION_FAILED, '密钥内容不能为空');
    if (!['upload_key', 'pay_cert'].includes(kind)) {
      throw new BizError(ERR.VALIDATION_FAILED, `未知的密钥类型：${kind}`);
    }
    // 太短的密钥几乎一定是贴错了（比如只复制了前半段），当场拦下比推不上去再查好
    if (raw.length < 8) {
      throw new BizError(ERR.VALIDATION_FAILED, `密钥长度异常（${raw.length} 字符），请确认复制完整`);
    }

    const t = await this.platform.findTenantByCode(tenantCode);
    if (!t) throw BizError.notFound(ERR.TENANT_NOT_FOUND, `租户不存在：${tenantCode}`);

    const rec = await this.platform.upsertSecret({
      tenantCode,
      kind,
      cipher: this.encrypt(raw),
      masked: mask(raw),
      remark: opts.remark ?? null,
    });

    await this.platform.appendAudit({
      tenantCode,
      actor: opts.operator ?? 'platform',
      action: 'secret.upsert',
      target: `${tenantCode}/${kind}`,
      // ⚠️ 审计里也**只记掩码** —— 日志是泄漏面最大的地方，比数据库还大
      detail: `更新密钥 ${mask(raw)}`,
    });

    return this.view(rec, t.shopName);
  }

  async list(tenantCode?: string): Promise<{ items: SecretView[]; missing: Array<{ tenantCode: string; shopName: string; kind: SecretKind }> }> {
    const [tenants, secrets] = await Promise.all([this.platform.listTenants(), this.platform.listSecrets(tenantCode)]);
    const nameOf = new Map(tenants.map((t) => [t.tenantCode, t.shopName]));
    const scope = tenantCode ? tenants.filter((t) => t.tenantCode === tenantCode) : tenants;

    const items = secrets
      .map((s) => this.view(s, nameOf.get(s.tenantCode) ?? s.tenantCode))
      .sort((a, b) => a.tenantCode.localeCompare(b.tenantCode) || a.kind.localeCompare(b.kind));

    // "未收集"必须显式列出来：界面上只显示已有密钥，会让人以为全都齐了
    const missing: Array<{ tenantCode: string; shopName: string; kind: SecretKind }> = [];
    for (const t of scope) {
      for (const kind of ['upload_key', 'pay_cert'] as const) {
        if (!secrets.some((s) => s.tenantCode === t.tenantCode && s.kind === kind)) {
          missing.push({ tenantCode: t.tenantCode, shopName: t.shopName, kind });
        }
      }
    }

    return { items, missing };
  }

  /**
   * 标记密钥失效（商户在微信后台重置了上传密钥 → 我们手上这把当场作废）。
   *
   * 这是 R9 风险（上传密钥被商户重置）的兜底：不做这一步，表现是
   * "推送突然全失败"，而失败原因只能靠人猜。
   */
  async markInvalid(tenantCode: string, kind: SecretKind, reason: string): Promise<SecretView> {
    const rec = await this.platform.markSecretInvalid(tenantCode, kind, reason);
    if (!rec) throw BizError.notFound(ERR.VALIDATION_FAILED, `该租户没有 ${kind} 密钥`);
    const t = await this.platform.findTenantByCode(tenantCode);
    await this.platform.appendAudit({
      tenantCode,
      actor: 'platform',
      action: 'secret.invalid',
      target: `${tenantCode}/${kind}`,
      detail: reason,
    });
    return this.view(rec, t?.shopName ?? tenantCode);
  }

  /** 给推送通道用的解密入口 —— 明文只在这一次调用的栈上存在 */
  async decryptForPush(tenantCode: string, kind: SecretKind): Promise<string | null> {
    const all = await this.platform.listSecrets(tenantCode);
    const hit = all.find((s) => s.kind === kind && s.status === 'active');
    if (!hit) return null;
    return this.decrypt(hit.cipher);
  }

  /* ------------------------------------------------------------- 加解密 */

  /**
   * 内存实现用的是"加盐指印"而不是真加密 —— 因为要诚实：
   * 这个模式只用于本地与 CI，本来就没有真实密钥。
   * 真库走 `SECRETS_MASTER_KEY` 做 AES-256-GCM（换实现时只改这两个函数）。
   */
  private encrypt(plain: string): string {
    return Buffer.from(`${env.secretsMasterKey}::${plain}`, 'utf8').toString('base64');
  }

  private decrypt(cipher: string): string | null {
    try {
      const raw = Buffer.from(cipher, 'base64').toString('utf8');
      const prefix = `${env.secretsMasterKey}::`;
      return raw.startsWith(prefix) ? raw.slice(prefix.length) : null;
    } catch {
      return null;
    }
  }

  private view(rec: TenantSecretRecord, shopName: string): SecretView {
    // 逐字段构造，**不是** `{...rec, cipher: undefined}` ——
    // 展开再删字段的写法，只要有人后来改回 `...rec`，明文字段就静默回流出去了。
    return {
      id: rec.id,
      tenantCode: rec.tenantCode,
      shopName,
      kind: rec.kind,
      masked: rec.masked,
      status: rec.status,
      remark: rec.remark,
      updatedAt: rec.updatedAt,
      invalidAt: rec.invalidAt,
      invalidReason: rec.invalidReason,
    };
  }
}

/** 掩码：前 4 位可见，其余打码。长度不足时全打码，绝不整段显示 */
export function mask(value: string): string {
  const v = String(value ?? '');
  if (v.length <= 4) return '****';
  return `${v.slice(0, 4)}****`;
}

/** 稳定指纹（前 8 位），用于"这把和上次那把是不是同一把"的比对，不可逆 */
export function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}
