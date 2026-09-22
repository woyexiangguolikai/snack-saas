import { Inject, Injectable } from '@nestjs/common';
import { ERR, BizError } from '../core/errors';
import { env } from '../core/env';
import { REPO_FACTORY } from '../core/repo.factory';
import type { PlatformRepo, RepoFactory } from '../core/repository';
import type { AppVersionRecord, PushTargetRecord, TenantRecord } from '../core/types';

/* ============================================================================
 * DeployProvider —— 把"往 N 个 AppID 推一个版本"这件事抽象出来
 * ----------------------------------------------------------------------------
 * 为什么必须有这层抽象（而不是直接调 miniprogram-ci）：
 *   ① 灰度推送的**编排逻辑**（选版本 → 选租户 → 排除名单 → 分批 → 回滚）
 *      与"用什么工具推"是两件独立的事，混在一起就变成"没有上传密钥就一行都测不了"；
 *   ② 本机/CI 没有上传密钥、没有 IP 白名单，也**必须能验证编排是对的**；
 *   ③ 将来换工具（miniprogram-ci → 微信开放平台接口）时，只换一个实现。
 * ==========================================================================*/

export interface DeployPushInput {
  appid: string;
  version: string;
  /** 商户的代码上传密钥（明文，仅在内存中存在这一次） */
  uploadKey: string | null;
}

export interface DeployPushResult {
  ok: boolean;
  /** 失败原因，必须是**人能照着做**的话（缺密钥 / IP 未白名单 / 版本不存在） */
  error?: string;
}

export interface DeployProvider {
  readonly name: string;
  push(input: DeployPushInput): Promise<DeployPushResult>;
}

/**
 * Mock 推送器：不联网，只校验"编排该管的事"。
 *
 * 刻意保留两种**可预期的失败**，否则"推送失败"这条分支永远没被跑过：
 *   · AppID 为空 / 形状不对（`wx` + 16 位）→ 失败；
 *   · 没有上传密钥 → 失败（真机上这也是最常见的一种）。
 */
export class MockDeployProvider implements DeployProvider {
  readonly name = 'mock';

  async push(input: DeployPushInput): Promise<DeployPushResult> {
    if (!input.appid) return { ok: false, error: '该租户还没绑定 AppID —— 先去第 3 阶段补齐' };
    if (!/^wx[0-9a-f]{16}$/.test(input.appid)) {
      return { ok: false, error: `AppID 形状不对（应为 wx + 16 位十六进制）：${input.appid}` };
    }
    if (!input.uploadKey) {
      return { ok: false, error: '缺少代码上传密钥 —— 第 7 阶段未完成（只有小程序管理员能生成）' };
    }
    if (/fail/i.test(input.appid)) return { ok: false, error: '微信侧返回 41002：版本号已被占用' };
    return { ok: true };
  }
}

/**
 * 真实推送器：**故意不实现**。
 *
 * 这里必须抛错而不是"先返回成功占位"。一个静默返回成功的推送器意味着
 * 平台看板上 20 家全绿、实际一家都没推上去 —— 而这类错误要到商户投诉
 * "怎么还是老版本"时才被发现，那时已经过了几周。
 */
export class MiniprogramCiProvider implements DeployProvider {
  readonly name = 'miniprogram-ci';

  async push(): Promise<DeployPushResult> {
    throw new BizError(
      ERR.VALIDATION_FAILED,
      '真实推送通道未接线：需要 miniprogram-ci + 各租户的代码上传密钥 + 服务器出口 IP 白名单（§2.4.1 第 7 阶段）',
    );
  }
}

/** 灰度最多几家 —— 写死在这里，是因为"先 1–2 家"是纪律，不是可选项 */
export const GRAY_MAX_TENANTS = 2;

export interface PushRequest {
  versionId: number;
  tenantCodes: string[];
  /** 排除名单：灰度验证未过的、商户自己要求暂停的 */
  exclude?: string[];
  kind: 'gray' | 'batch';
  operator: string;
  /** batch 必须显式确认"灰度已验证" —— 防的是"图省事直接全量" */
  confirmedGrayPassed?: boolean;
}

@Injectable()
export class DeployService {
  private provider: DeployProvider;

  constructor(@Inject(REPO_FACTORY) private readonly repos: RepoFactory) {
    // 生产环境绝不静默降级到 mock —— 那等于"以为在推送，其实什么都没发生"
    this.provider = env.nodeEnv === 'production' ? new MiniprogramCiProvider() : new MockDeployProvider();
  }

  private get platform(): PlatformRepo {
    return this.repos.platform();
  }

  get providerName(): string {
    return this.provider.name;
  }

  /* ------------------------------------------------------------- 版本 */

  async createVersion(version: string, note?: string | null): Promise<AppVersionRecord> {
    const v = String(version ?? '').trim();
    if (!/^\d+\.\d+\.\d+$/.test(v)) {
      throw new BizError(ERR.VALIDATION_FAILED, `版本号应为 x.y.z 形式，收到：${version}`);
    }
    const rec = await this.platform.createAppVersion({ version: v, note: note ?? null });
    await this.platform.appendAudit({ actor: 'platform', action: 'version.create', target: v, detail: note ?? null });
    return rec;
  }

  async listVersions(): Promise<AppVersionRecord[]> {
    return this.platform.listAppVersions();
  }

  /**
   * 商户在微信后台提审 / 发布后回填状态。
   *
   * 为什么平台不自动感知：推动权在商户手上，平台**没有**这个接口的读取权限。
   * 与其做一个"假装能自动同步"的功能，不如明确让人回填 —— 至少数字是真的。
   */
  async markSubmitted(tenantCode: string, version: string): Promise<PushTargetRecord> {
    const t = await this.targetOf(tenantCode, version);
    const now = new Date().toISOString();
    const updated = await this.platform.updatePushTarget(t.id, { submitted: true, submittedAt: t.submittedAt ?? now });
    await this.refreshVersionCounters(t.batchId);
    return updated;
  }

  async markPublished(tenantCode: string, version: string): Promise<PushTargetRecord> {
    const t = await this.targetOf(tenantCode, version);
    const now = new Date().toISOString();
    const updated = await this.platform.updatePushTarget(t.id, {
      submitted: true,
      submittedAt: t.submittedAt ?? now,
      published: true,
      publishedAt: t.publishedAt ?? now,
    });
    await this.refreshVersionCounters(t.batchId);
    return updated;
  }

  /* ------------------------------------------------------------- 推送 */

  /**
   * 灰度 / 批量推送。
   *
   * 两条纪律是**硬拦**而不是提示：
   *   ① 灰度最多 2 家；
   *   ② 批量推送前必须有一次成功的灰度（且该批次全部成功）。
   * 为什么是硬拦：这两条唯一的作用就是防"一个 bug 让 N 家同时挂"。
   * 做成"确认框"的话，那个框在第三次点击时就会变成肌肉记忆，等于没有。
   */
  async push(req: PushRequest): Promise<{
    batch: Awaited<ReturnType<PlatformRepo['createPushBatch']>>;
    targets: PushTargetRecord[];
    skipped: string[];
  }> {
    const version = await this.platform.findAppVersion(req.versionId);
    if (!version) throw BizError.notFound(ERR.VALIDATION_FAILED, `版本不存在：${req.versionId}`);

    const exclude = new Set((req.exclude ?? []).map((c) => c.trim()).filter(Boolean));
    const wanted = [...new Set(req.tenantCodes.map((c) => c.trim()).filter(Boolean))];
    if (!wanted.length) throw new BizError(ERR.VALIDATION_FAILED, '请至少选择一个租户');

    const all = await this.platform.listTenants();
    const byCode = new Map<string, TenantRecord>(all.map((t) => [t.tenantCode, t]));

    const targets: TenantRecord[] = [];
    const skipped: string[] = [];
    for (const code of wanted) {
      const t = byCode.get(code);
      if (!t) {
        skipped.push(`${code}（租户不存在）`);
        continue;
      }
      if (exclude.has(code)) {
        skipped.push(`${code}（在排除名单内）`);
        continue;
      }
      if (t.status === 'suspended') {
        // 停用中的租户推上去也没人用，还会把"推送失败"的统计搞脏
        skipped.push(`${code}（已停用）`);
        continue;
      }
      if (t.status !== 'active') {
        skipped.push(`${code}（尚未走到第 12 阶段）`);
        continue;
      }
      targets.push(t);
    }

    if (!targets.length) {
      throw new BizError(ERR.VALIDATION_FAILED, `没有可推送的租户。跳过原因：${skipped.join('；') || '未选择'}`);
    }

    if (req.kind === 'gray' && targets.length > GRAY_MAX_TENANTS) {
      throw new BizError(
        ERR.VALIDATION_FAILED,
        `灰度推送最多 ${GRAY_MAX_TENANTS} 家（当前 ${targets.length} 家）。灰度验证通过后再用批量推送 —— 否则一个 bug 会让 ${targets.length} 家同时挂`,
      );
    }

    if (req.kind === 'batch' && !req.confirmedGrayPassed) {
      const gray = await this.grayStateOf(version.id);
      if (!gray.passed) {
        throw new BizError(
          ERR.VALIDATION_FAILED,
          `批量推送前必须先灰度：${gray.reason}。若已确认灰度无问题，请在界面上勾选「灰度已验证」`,
        );
      }
    }

    const batch = await this.platform.createPushBatch({
      versionId: version.id,
      version: version.version,
      kind: req.kind,
      excluded: [...exclude],
      totalTargets: targets.length,
      succeeded: 0,
      failed: 0,
      status: 'running',
      operator: req.operator,
    });

    const created = await this.platform.addPushTargets(
      targets.map((t) => ({
        batchId: batch.id,
        tenantCode: t.tenantCode,
        appid: t.appid ?? '',
        version: version.version,
        ok: false,
        error: null as string | null,
        submitted: false,
        published: false,
        pushedAt: null as string | null,
        submittedAt: null as string | null,
        publishedAt: null as string | null,
      })),
    );

    let ok = 0;
    let failed = 0;
    for (const target of created) {
      const key = await this.uploadKeyOf(target.tenantCode);
      let res: DeployPushResult;
      try {
        res = await this.provider.push({
          appid: target.appid,
          version: version.version,
          uploadKey: key,
        });
      } catch (e) {
        // 推送通道整体不可用（如真实通道未接线）时**不能中断整批**：
        // 已经推上去的要如实记账，否则回滚时不知道回滚哪些
        res = { ok: false, error: e instanceof Error ? e.message : '推送通道异常' };
      }
      if (res.ok) {
        ok += 1;
        await this.platform.updatePushTarget(target.id, { ok: true, error: null, pushedAt: new Date().toISOString() });
      } else {
        failed += 1;
        await this.platform.updatePushTarget(target.id, { ok: false, error: res.error ?? '未知失败' });
      }
    }

    const final = await this.platform.updatePushBatch(batch.id, {
      succeeded: ok,
      failed,
      status: failed === 0 ? 'done' : ok === 0 ? 'partial' : 'partial',
      finishedAt: new Date().toISOString(),
    });

    await this.refreshVersionCounters(batch.id);
    await this.platform.appendAudit({
      actor: req.operator,
      action: req.kind === 'gray' ? 'deploy.gray' : 'deploy.batch',
      target: version.version,
      detail: `目标 ${targets.length} 家，成功 ${ok}，失败 ${failed}${skipped.length ? `，跳过 ${skipped.length}` : ''}`,
    });

    return {
      batch: final,
      targets: await this.platform.listPushTargets({ batchId: batch.id }),
      skipped,
    };
  }

  /** 灰度状态：是否已经推过、是否全部成功 —— 批量推送的放行依据 */
  async grayStateOf(versionId: number): Promise<{ passed: boolean; reason: string }> {
    const batches = (await this.platform.listPushBatches(200)).filter((b) => b.versionId === versionId && b.kind === 'gray');
    if (!batches.length) return { passed: false, reason: '该版本还没有灰度记录' };
    const targets = await this.platform.listPushTargets();
    const grayTargets = targets.filter((t) => batches.some((b) => b.id === t.batchId));
    const failed = grayTargets.filter((t) => !t.ok);
    if (failed.length) {
      return { passed: false, reason: `灰度有 ${failed.length} 家失败（${failed.map((f) => f.tenantCode).join('、')}），先解决再全量` };
    }
    return { passed: true, reason: `灰度 ${grayTargets.length} 家全部成功` };
  }

  /**
   * 回滚：把上一版重新推给这一批的租户。
   *
   * 回滚**不撤销**推送过的版本（微信侧做不到"退回到旧版本"），
   * 只能"把旧版本再推一次"。所以它是一条普通推送，kind='rollback'，
   * 单独记一批 —— 这样看板上能看出"这家被回滚过"，而不是凭空多了一次推送。
   */
  async rollback(batchId: number, operator: string, previousVersionId: number): Promise<{ batchId: number; targets: PushTargetRecord[] }> {
    const origin = (await this.platform.listPushBatches(200)).find((b) => b.id === batchId);
    if (!origin) throw BizError.notFound(ERR.VALIDATION_FAILED, `推送批次不存在：${batchId}`);
    const version = await this.platform.findAppVersion(previousVersionId);
    if (!version) throw BizError.notFound(ERR.VALIDATION_FAILED, `版本不存在：${previousVersionId}`);

    const originTargets = await this.platform.listPushTargets({ batchId });
    const codes = originTargets.filter((t) => t.ok).map((t) => t.tenantCode);
    if (!codes.length) throw new BizError(ERR.VALIDATION_FAILED, '该批次没有成功推送过的租户，无需回滚');

    const res = await this.push({
      versionId: version.id,
      tenantCodes: codes,
      kind: 'batch',
      operator,
      confirmedGrayPassed: true,
    });
    await this.platform.updatePushBatch(res.batch.id, { kind: 'rollback' });
    await this.platform.updatePushBatch(batchId, { status: 'rolled_back' });
    await this.platform.appendAudit({
      actor: operator,
      action: 'deploy.rollback',
      target: version.version,
      detail: `回滚批次 #${batchId}，涉及 ${codes.length} 家`,
    });
    return { batchId: res.batch.id, targets: res.targets };
  }

  /* ------------------------------------------------------------- 看板 */

  /**
   * 版本与发布看板（P-06）。
   *
   * 三类筛选对应平台**唯一能做的三件事**：
   *   · stale         还停在旧版本 → 该推
   *   · unsubmitted   推了但没提审 → 该催（推动权在商户）
   *   · failed        推送失败     → 该修
   * 平台不能替商户提审发布，所以看板的价值全在"该找谁"这件事上。
   */
  async board(filter: 'all' | 'stale' | 'unsubmitted' | 'failed' = 'all'): Promise<{
    latestVersion: string | null;
    stats: { total: number; onLatest: number; stale: number; unsubmitted: number; failed: number; neverPushed: number };
    items: Array<{
      tenantCode: string;
      shopName: string;
      appid: string | null;
      currentVersion: string | null;
      latestVersion: string | null;
      pushedAt: string | null;
      submitted: boolean;
      published: boolean;
      failed: boolean;
      error: string | null;
      category: 'on_latest' | 'stale' | 'unsubmitted' | 'failed' | 'never_pushed';
    }>;
    provider: string;
    filters: Record<'all' | 'stale' | 'unsubmitted' | 'failed', number>;
  }> {
    const [tenants, versions, targets, batches] = await Promise.all([
      this.platform.listTenants(),
      this.platform.listAppVersions(),
      this.platform.listPushTargets(),
      this.platform.listPushBatches(500),
    ]);
    const latest = this.pickLatest(versions, targets, batches);

    // 每个租户只取**最近一条**目标记录：看板回答的是"这家现在怎么样"，
    // 把历史全列出来会让人根本找不到要处理的那一行
    const latestByTenant = new Map<string, PushTargetRecord>();
    for (const t of targets) {
      const cur = latestByTenant.get(t.tenantCode);
      if (!cur || t.id > cur.id) latestByTenant.set(t.tenantCode, t);
    }

    const items = tenants.map((t) => {
      const hit = latestByTenant.get(t.tenantCode) ?? null;

      let category: 'on_latest' | 'stale' | 'unsubmitted' | 'failed' | 'never_pushed';
      if (!hit) category = 'never_pushed';
      else if (!hit.ok) category = 'failed';
      else if (!hit.submitted) category = 'unsubmitted';
      else if (latest && hit.version !== latest.version) category = 'stale';
      else category = 'on_latest';

      return {
        tenantCode: t.tenantCode,
        shopName: t.shopName,
        appid: t.appid,
        currentVersion: hit?.version ?? null,
        latestVersion: latest?.version ?? null,
        pushedAt: hit?.pushedAt ?? null,
        submitted: hit?.submitted ?? false,
        published: hit?.published ?? false,
        failed: hit ? !hit.ok : false,
        error: hit?.error ?? null,
        category,
      };
    });

    const staleOnly = items.filter((i) => i.category === 'stale').length;
    const neverPushed = items.filter((i) => i.category === 'never_pushed').length;

    const counts = {
      all: items.length,
      // 「还停在旧版本」这一筛把"从没推过"也算进来 —— 对操作的人而言，
      // 这两种处境要做的事是同一件（该推了）；分成两个 Chip 只会让人漏掉一种
      stale: staleOnly + neverPushed,
      unsubmitted: items.filter((i) => i.category === 'unsubmitted').length,
      failed: items.filter((i) => i.category === 'failed').length,
    };

    const filtered =
      filter === 'all'
        ? items
        : filter === 'stale'
          ? items.filter((i) => i.category === 'stale' || i.category === 'never_pushed')
          : items.filter((i) => i.category === filter);

    return {
      latestVersion: latest?.version ?? null,
      stats: {
        total: items.length,
        onLatest: items.filter((i) => i.category === 'on_latest').length,
        // 注意这里用 staleOnly 而不是 counts.stale：统计卡里"停在旧版本"与"从没推过"
        // 是**两张卡**，两张卡都取 counts.stale 的话，五张卡之和会大于总数（重复计数）
        stale: staleOnly,
        unsubmitted: counts.unsubmitted,
        failed: counts.failed,
        neverPushed,
      },
      items: filtered,
      provider: this.providerName,
      filters: counts,
    };
  }

  /** 单租户版本状态（P-02 用） */
  async ofTenant(tenantCode: string): Promise<{
    currentVersion: string | null;
    pushedAt: string | null;
    submitted: boolean;
    published: boolean;
    error: string | null;
    history: PushTargetRecord[];
  }> {
    const targets = await this.platform.listPushTargets({ tenantCode });
    const latest = targets.reduce<PushTargetRecord | null>((a, b) => (!a || b.id > a.id ? b : a), null);
    return {
      currentVersion: latest?.version ?? null,
      pushedAt: latest?.pushedAt ?? null,
      submitted: latest?.submitted ?? false,
      published: latest?.published ?? false,
      error: latest?.error ?? null,
      history: targets.sort((a, b) => b.id - a.id).slice(0, 20),
    };
  }

  async listBatches(limit = 30): Promise<{
    items: Array<Awaited<ReturnType<PlatformRepo['createPushBatch']>> & { targetRows: PushTargetRecord[] }>;
  }> {
    const batches = await this.platform.listPushBatches(limit);
    const targets = await this.platform.listPushTargets();
    return {
      items: batches.map((b) => ({ ...b, targetRows: targets.filter((t) => t.batchId === b.id) })),
    };
  }

  /**
   * 「最新版本」= 该版本号最大的、**至少成功推过一次**、且**不是只被用作回滚目标**的版本。
   *
   * 三条限制都不是凑数的，它们各自对应一个会出错的直觉：
   *   · 按"创建时间最新"取 → 回滚时临时建的旧版本号（0.0.9）会变成"最新版"，
   *     于是看板上所有租户都显示"停在旧版本"，而其实大家正是被回滚到了它上面；
   *   · 不要求"推成功过" → 一个刚建好、还没推上去的版本会让所有租户瞬间变成"旧版本"，
   *     于是满屏红字，看久了没人看；
   *   · 不排除回滚目标 → 上面第一条那个 0.0.9 又会通过"推成功过"的检查。
   */
  private pickLatest(
    versions: AppVersionRecord[],
    targets: PushTargetRecord[],
    batches: Array<{ id: number; versionId: number; kind: string }>,
  ): AppVersionRecord | null {
    const rollbackOnly = new Set(batches.filter((b) => b.kind === 'rollback').map((b) => b.versionId));
    const okBatches = new Set(targets.filter((t) => t.ok).map((t) => t.batchId));
    const pushedVersionIds = new Set(batches.filter((b) => okBatches.has(b.id)).map((b) => b.versionId));

    const candidates = versions.filter(
      (v) => v.status !== 'failed' && pushedVersionIds.has(v.id) && !rollbackOnly.has(v.id),
    );
    if (!candidates.length) return null;
    return candidates.reduce((a, b) => (compareVersion(b.version, a.version) > 0 ? b : a));
  }

  /* ------------------------------------------------------------- 内部 */

  private async targetOf(tenantCode: string, version: string): Promise<PushTargetRecord> {
    const targets = await this.platform.listPushTargets({ tenantCode });
    const hit = targets.filter((t) => t.version === version).reduce<PushTargetRecord | null>((a, b) => (!a || b.id > a.id ? b : a), null);
    if (!hit) throw BizError.notFound(ERR.VALIDATION_FAILED, `该租户没有 ${version} 的推送记录：${tenantCode}`);
    return hit;
  }

  private async uploadKeyOf(tenantCode: string): Promise<string | null> {
    const secrets = await this.platform.listSecrets(tenantCode);
    const key = secrets.find((s) => s.kind === 'upload_key' && s.status === 'active');
    // 内存实现里 cipher 就是 base64；真库走 SECRETS_MASTER_KEY 解密。
    // 明文只在这一刻存在于内存，不落日志、不进响应。
    return key ? key.cipher : null;
  }

  /** 批次推送完后刷新版本的两个计数（看板的统计卡靠它们） */
  private async refreshVersionCounters(batchId: number): Promise<void> {
    const batches = await this.platform.listPushBatches(500);
    const batch = batches.find((b) => b.id === batchId);
    if (!batch) return;
    const all = await this.platform.listPushTargets();
    const ofVersion = all.filter((t) => t.version === batch.version);
    await this.platform.updateAppVersion(batch.versionId, {
      pushedCount: new Set(ofVersion.filter((t) => t.ok).map((t) => t.tenantCode)).size,
      publishedCount: new Set(ofVersion.filter((t) => t.published).map((t) => t.tenantCode)).size,
      status: ofVersion.some((t) => t.published)
        ? 'published'
        : ofVersion.some((t) => t.submitted)
          ? 'submitted'
          : ofVersion.some((t) => t.ok)
            ? 'pushed'
            : ofVersion.length && ofVersion.every((t) => !t.ok)
              ? 'failed'
              : 'draft',
    });
  }
}

/** 语义化版本比较：x.y.z 逐段比数字，避免 "0.10.0" < "0.9.0" 的字符串排序坑 */
export function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number(n) || 0);
  const pb = b.split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}
