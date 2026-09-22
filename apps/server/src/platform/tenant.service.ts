import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { guardThemeColor } from '@snack/tokens';
import { cutoffOf, narrowBusinessHours, resolveBuildingConfig } from '../core/config-resolver';
import { ERR, BizError } from '../core/errors';
import { currentContext } from '../core/logger';
import { issueToken } from '../core/jwt';
import { env } from '../core/env';
import { REPO_FACTORY } from '../core/repo.factory';
import type { PlatformRepo, RepoFactory } from '../core/repository';
import type { BulkBuildingConfig } from '../core/repository';
import { evaluateBuildingGate } from '../core/time-window';
import { CENTS } from '../core/types';
import type { ResolvedBuildingConfig, TenantRecord, TenantResolveResult, UserRecord } from '../core/types';
import { WechatService } from '../auth/wechat.service';

/** 网页端登录码的有效期：够从手机走到电脑前输完，不够留到明天 */
const WEB_LOGIN_CODE_TTL_SECONDS = 300;
/** 限流窗口与上限：10 分钟内最多 5 次错误尝试 */
const WEB_LOGIN_ATTEMPT_WINDOW_MS = 10 * 60_000;
const WEB_LOGIN_ATTEMPT_MAX = 5;
/** 租户 → 最近的错误尝试时间戳（单机内存；多实例部署需换成 Redis） */
const webLoginAttempts = new Map<string, number[]>();

/** 学期周期：秋季 9/1–次年 1/31；春季 2/1–7/31。到期日必须避开假期 */
export function semesterPeriod(at: Date = new Date()): { start: Date; end: Date } {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth() + 1;
  if (m >= 8) return { start: new Date(Date.UTC(y, 8, 1)), end: new Date(Date.UTC(y + 1, 0, 31)) };
  if (m === 1) return { start: new Date(Date.UTC(y - 1, 8, 1)), end: new Date(Date.UTC(y, 0, 31)) };
  return { start: new Date(Date.UTC(y, 1, 1)), end: new Date(Date.UTC(y, 6, 31)) };
}

/** 订阅剩余天数（平台租户列表必须与余额同屏显示，否则谁要被停单你看不见） */
export function daysLeft(periodEnd: string | null, now = new Date()): number | null {
  if (!periodEnd) return null;
  return Math.ceil((new Date(periodEnd).getTime() - now.getTime()) / 86_400_000);
}

export interface CreateTenantDto {
  shopName: string;
  orgName: string;
  appid?: string | null;
  schoolId?: number | null;
  contactName?: string | null;
  contactPhone?: string | null;
  region?: string | null;
  /** 勾选负责的楼栋（可改名）；不传则用学校模板全量 */
  buildingNames?: string[];
  tenantCode?: string;
}

@Injectable()
export class TenantService {
  constructor(
    @Inject(REPO_FACTORY) private readonly repos: RepoFactory,
    private readonly wechat: WechatService,
  ) {}

  private get platform(): PlatformRepo {
    return this.repos.platform();
  }

  /** 学校字典 + 楼栋模板（建租户向导的输入） */
  async listSchools() {
    const schools = await this.platform.listSchools();
    return Promise.all(
      schools.map(async (s) => ({
        ...s,
        buildingTemplates: (await this.platform.listBuildingTemplates(s.id)).map((t) => t.name),
      })),
    );
  }

  /**
   * 一键建租户（§5 第 8 阶段，系统自动完成）
   * 建库 → 初始化 → 带出学校楼栋模板 → 订阅账本与余额账本开户 → 生成 12 阶段流水线
   */
  async createTenant(dto: CreateTenantDto): Promise<{ tenant: TenantRecord; buildings: ResolvedBuildingConfig[] }> {
    const shopName = String(dto.shopName ?? '').trim();
    const orgName = String(dto.orgName ?? '').trim();
    if (!shopName) throw new BizError(ERR.VALIDATION_FAILED, '店铺名不能为空');
    if (!orgName) throw new BizError(ERR.VALIDATION_FAILED, '机构名（执照主体）不能为空');

    const tenantCode = dto.tenantCode?.trim() || (await this.nextTenantCode());

    let buildingNames = dto.buildingNames?.map((n) => String(n).trim()).filter(Boolean) ?? [];
    if (!buildingNames.length && dto.schoolId) {
      // 未勾选时带出学校模板全量 —— 商户可再改名 / 排序 / 删减
      buildingNames = (await this.platform.listBuildingTemplates(dto.schoolId)).map((t) => t.name);
    }

    const period = semesterPeriod();
    const tenant = await this.platform.createTenant({
      tenantCode,
      appid: dto.appid?.trim() || null,
      orgName,
      shopName,
      schoolId: dto.schoolId ?? null,
      contactName: dto.contactName ?? null,
      contactPhone: dto.contactPhone ?? null,
      region: dto.region ?? '广西',
      dbName: `snack_${tenantCode}`,
      buildingNames,
      periodStart: period.start,
      periodEnd: period.end,
    });

    await this.platform.appendAudit({
      tenantCode,
      actor: 'platform',
      action: 'tenant.create',
      target: tenantCode,
      detail: `建库 ${tenant.dbName}，带出楼栋 ${buildingNames.length} 个`,
    });

    const tenantRepo = this.repos.tenant(tenantCode);
    const shop = await tenantRepo.getShopConfig();
    const buildings = await this.resolveBuildings(tenantCode);
    void shop;
    return { tenant, buildings };
  }

  private async nextTenantCode(): Promise<string> {
    const all = await this.platform.listTenants();
    const max = all
      .map((t) => Number((/^t(\d{6})$/.exec(t.tenantCode) ?? [])[1] ?? 0))
      .reduce((a, b) => Math.max(a, b), 0);
    return `t${String(max + 1).padStart(6, '0')}`;
  }

  /** 平台租户列表：**两个账本状态必须同屏**（订阅剩余天数 + 余额） */
  async listTenantsWithGates() {
    const tenants = await this.platform.listTenants();
    return Promise.all(
      tenants.map(async (t) => {
        const sub = await this.platform.getSubscription(t.tenantCode);
        const wallet = await this.platform.getWallet(t.tenantCode);
        const left = daysLeft(sub?.periodEnd ?? null);
        const balance = wallet?.balanceCents ?? 0;
        const limit = wallet?.creditLimitCents ?? CENTS.CREDIT_LIMIT;
        const buildings = await this.repos.tenant(t.tenantCode).listBuildings(true);
        return {
          tenantCode: t.tenantCode,
          shopName: t.shopName,
          orgName: t.orgName,
          appid: t.appid,
          status: t.status,
          dbName: t.dbName,
          buildingCount: buildings.filter((b) => b.status === 'active').length,
          gates: {
            subscriptionEndsAt: sub?.periodEnd ?? null,
            subscriptionDaysLeft: left,
            subscriptionValid: sub ? new Date(sub.periodEnd ?? 0).getTime() > Date.now() : false,
            subscriptionTone: left === null ? 'off' : left <= 0 ? 'danger' : left <= 7 ? 'warn' : 'ok',
            balanceCents: balance,
            warnLineCents: wallet?.warnLineCents ?? CENTS.WARN_LINE,
            balanceTone: balance <= limit ? 'danger' : balance <= (wallet?.warnLineCents ?? CENTS.WARN_LINE) ? 'warn' : 'ok',
          },
        };
      }),
    );
  }

  /** 租户解析：小程序启动的第一跳（§2.2） */
  /**
   * 租户识别 +（可选）登录。
   *
   * 不传登录参数时只签发**浏览令牌**（载荷无 sub）；带上 `code` 或 dev 下的 `openid`
   * 才会在租户库里建立学生身份，并签发带 userId 的令牌。
   */
  async resolveByAppId(
    appidRaw: string,
    login: { code?: string; openid?: string; nickname?: string; avatar?: string } = {},
  ): Promise<TenantResolveResult> {
    const appid = String(appidRaw ?? '').trim();
    if (!appid) throw new BizError(ERR.VALIDATION_FAILED, '缺少 appid');

    const tenant = await this.platform.findTenantByAppId(appid);
    // AppID 未匹配 → 前端渲染「店铺未开通」页；**绝不白屏**
    if (!tenant) {
      throw BizError.notFound(ERR.TENANT_NOT_FOUND, '店铺未开通');
    }
    if (tenant.status === 'suspended') {
      throw BizError.forbidden(ERR.TENANT_SUSPENDED, '本店暂停服务');
    }

    const tenantRepo = this.repos.tenant(tenant.tenantCode);
    const shop = await tenantRepo.getShopConfig();
    const sub = await this.platform.getSubscription(tenant.tenantCode);
    const wallet = await this.platform.getWallet(tenant.tenantCode);
    const subscriptionValid = !!sub?.periodEnd && new Date(sub.periodEnd).getTime() > Date.now();

    const all = await tenantRepo.listBuildings(false);
    const buildings = all.map((b) => resolveBuildingConfig(b, shop));

    // ---- 登录（可选）-------------------------------------------------------
    // 不传 code / openid 时仍然签发 token：此时只有"浏览权限"（载荷里没有 sub），
    // 下单 / 地址 / 我的订单这些接口会因为拿不到 userId 而拒绝（requireUserId）。
    // 这个设计让"先看再登录"成为可能，而不是一进小程序就弹授权。
    const user = await this.loginUser(tenant.tenantCode, login);

    const { token, expiresAt } = issueToken(
      {
        tenantCode: tenant.tenantCode,
        role: 'student',
        // 只有真正完成登录才写 sub —— 它是"这个令牌代表谁"的唯一凭据
        ...(user ? { sub: user.id } : {}),
      },
      env.jwtSecret,
    );

    void cutoffOf(shop.accessibleTo ?? '22:30', shop.cutoffLeadMinutes);
    narrowBusinessHours(shop.openTime, shop.closeTime, shop.accessibleFrom ?? '06:30', shop.accessibleTo ?? '22:30');

    return {
      tenantCode: tenant.tenantCode,
      shopName: tenant.shopName,
      logoUrl: shop.logoUrl,
      announcement: shop.announcement,
      /**
       * 客服电话。**故意下发给学生**（AC-13 的例外，且是唯一例外）：
       * 它是店家自己填的"对外联系电话"，学生遇到"本栋没上架""楼栋不在覆盖范围"
       * 这类**只能由店家回答**的问题时，必须有直达的出路。
       * 没有它，这些空态就只能写"请联系店家"而给不出一个能点的东西 ——
       * 那等于把问题推给用户。房间号、顾客手机号绝不在此列。
       */
      contactPhone: shop.contactPhone,
      themeScale: shop.themeScale,
      shopOpen: shop.shopOpen,
      buildings,
      // 单楼栋自动降级：有效楼栋 = 1 时前端隐藏全部楼栋 UI（§4.9）
      singleBuildingMode: buildings.length <= 1,
      gates: {
        subscriptionValid,
        balanceOk: (wallet?.balanceCents ?? 0) > (wallet?.creditLimitCents ?? CENTS.CREDIT_LIMIT),
        subscriptionEndsAt: sub?.periodEnd ?? null,
        balanceCents: wallet?.balanceCents ?? 0,
      },
      user: user ? { id: user.id, nickname: user.nickname, avatar: user.avatar } : null,
      token,
      expiresAt,
      // 服务端时间基准（AC-14）：前端据此算出偏移量，避免用学生的本地时钟算倒计时
      serverTime: new Date().toISOString(),
    };
  }

  /**
   * 建立学生身份。
   *
   * 两条路径，**生产只允许第一条**：
   *   ① `code` → code2session → openid（微信保证"这个 code 确实是这个用户点的授权"）
   *   ② `openid` 直传 → 仅本地/测试（打开它等于任何人可以冒充任何人）
   *
   * 用户落在**该租户库**里：openid 是租户维度的，同一学生换一家店就是另一条记录 ——
   * 这样商户整库导出时拿到的是"自己的顾客"，而不是一份跨店的全站用户表。
   */
  private async loginUser(
    tenantCode: string,
    login: { code?: string; openid?: string; nickname?: string; avatar?: string },
  ): Promise<UserRecord | null> {
    const repo = this.repos.tenant(tenantCode);
    const identity = await this.openidOf(login);
    if (!identity) return null;
    return repo.createUser({
      openid: identity.openid,
      unionid: identity.unionid,
      nickname: login.nickname ?? null,
      avatar: login.avatar ?? null,
    });
  }

  /**
   * 取得微信身份标识 —— 学生登录与商户登录**共用这一条路径**。
   *
   * 抽出来不是为了省几行，而是因为"身份从哪来"必须只有一个答案：
   * 商户端若另写一份 code2session，就会出现"同一个人在两端 openid 不同"这种
   * 几乎不可能排查的故障（表现为：店主在学生端能下单，在商户端却不是店主）。
   */
  private async openidOf(
    login: { code?: string; openid?: string },
  ): Promise<{ openid: string; unionid: string | null } | null> {
    // ⚠️ code2session **只能调用一次**：微信的 code 一次性，用第二次会报 code been used。
    // 所以这里一次把 openid + unionid 都取回来，调用方不许为了拿 unionid 再调一遍。
    if (login.code) {
      const s = await this.wechat.code2session(login.code);
      return { openid: s.openid, unionid: s.unionid ?? null };
    }

    if (login.openid) {
      if (!env.wechat.allowInsecureOpenid) {
        throw new BizError(
          ERR.LOGIN_REQUIRED,
          '生产环境必须走 wx.login 授权登录（WECHAT_ALLOW_INSECURE_OPENID 已关闭）',
        );
      }
      return { openid: String(login.openid), unionid: null };
    }
    return null;
  }

  /**
   * 商户登录（CM-01）：微信授权 → 校验是不是本店店主 → 签发店主令牌。
   *
   * 为什么单独一个接口，而不是给 resolve 加一个 `role` 参数：
   *   ① **失败语义不同**：学生登录失败重试即可；不是店主时重试多少次都没用，
   *      必须给一句「当前仅店主可登录」并把人退回学生端；
   *   ② **令牌不同**：店主令牌 role=owner、有效期更短（操作的是钱和货），
   *      混在一个接口里就要靠入参分支签发不同令牌 —— 那是把权限判断藏进参数。
   *
   * v1 是单管理员（D10）：店主身份由平台运营预先绑定，见
   * `POST /api/platform/merchant/owner`。
   */
  async loginMerchant(
    appidRaw: string,
    login: { code?: string; openid?: string; nickname?: string; avatar?: string },
  ): Promise<{
    tenantCode: string;
    shopName: string;
    token: string;
    expiresAt: string;
    role: 'owner';
    nickname: string | null;
  }> {
    const appid = String(appidRaw ?? '').trim();
    if (!appid) throw new BizError(ERR.VALIDATION_FAILED, '缺少 appid');

    const tenant = await this.platform.findTenantByAppId(appid);
    if (!tenant) throw BizError.notFound(ERR.TENANT_NOT_FOUND, '店铺未开通');
    if (tenant.status === 'suspended') throw BizError.forbidden(ERR.TENANT_SUSPENDED, '本店暂停服务');

    const identity = await this.openidOf(login);
    if (!identity) throw BizError.unauthorized(ERR.LOGIN_REQUIRED, '未取得微信身份，请重试');

    const repo = this.repos.tenant(tenant.tenantCode);
    const user = await repo.findUserByOpenid(identity.openid);
    // 不是店主就是不是店主 —— 不建用户、不降级、不给"游客版商户端"
    if (!user || user.role !== 'owner') {
      throw BizError.forbidden(ERR.NOT_MERCHANT, '当前仅店主可登录');
    }

    const { token, expiresAt } = issueToken(
      { tenantCode: tenant.tenantCode, role: 'owner', sub: user.id },
      env.jwtSecret,
      // 商户端动的是钱和货，会话比学生端短
      24 * 3600,
    );
    return {
      tenantCode: tenant.tenantCode,
      shopName: tenant.shopName,
      token,
      expiresAt,
      role: 'owner',
      nickname: user.nickname,
    };
  }

  /**
   * 绑定店主（平台运营动作，平台密钥保护）。
   *
   * 这一步之所以存在：店主身份**不能靠"第一个登录的人就是店主"**来产生 ——
   * 那等于任何一个学生先进商户端就拿到了定价权。
   * 必须由运营在后台显式指定，且可替换（换店长 / 店员离职）。
   */
  async bindOwner(tenantCodeRaw: string, openid: string, nickname?: string | null): Promise<{ userId: number; nickname: string | null }> {
    const tenantCode = String(tenantCodeRaw ?? '').trim();
    if (!tenantCode) throw new BizError(ERR.VALIDATION_FAILED, '缺少 tenantCode');
    if (!openid) throw new BizError(ERR.VALIDATION_FAILED, '缺少 openid');

    const tenant = await this.platform.findTenantByCode(tenantCode);
    if (!tenant) throw BizError.notFound(ERR.TENANT_NOT_FOUND, `租户不存在：${tenantCode}`);

    const repo = this.repos.tenant(tenantCode);
    const exist = await repo.findUserByOpenid(openid);
    if (exist) {
      const updated = await repo.updateUser(exist.id, { role: 'owner', nickname: nickname ?? exist.nickname });
      return { userId: updated.id, nickname: updated.nickname };
    }
    const created = await repo.createUser({ openid, nickname: nickname ?? null, avatar: null });
    const owner = await repo.updateUser(created.id, { role: 'owner' });
    return { userId: owner.id, nickname: owner.nickname };
  }

  /**
   * 网页端登录码：**由已经登录的店主本人在小程序里生成**。
   *
   * 为什么不做一个"网页端输密码登录"：那需要先有一套账号体系（注册、找回、改密、
   * RBAC、审计），而 v1 明确把账号体系放到上线前替换（与 PLATFORM_ADMIN_KEY 一起）。
   * 在账号体系到位之前，登录码是**更强**而不是更弱的方案 ——
   * 它把"证明我是店主"这一步交给了已经验证过的微信身份，而不是新造一个密码。
   */
  async issueWebLoginCode(tenantCode: string): Promise<{ code: string; expiresAt: string }> {
    const code = String(randomInt(100000, 1000000));
    const { expiresAt } = await this.platform.issueWebLoginCode(tenantCode, code, WEB_LOGIN_CODE_TTL_SECONDS);
    return { code, expiresAt };
  }

  /** 网页端用码换店主令牌。限流按租户计数，防止在线撞码 */
  async redeemWebLoginCode(
    tenantCodeRaw: string,
    codeRaw: string,
  ): Promise<{ tenantCode: string; shopName: string; token: string; expiresAt: string; role: 'owner' }> {
    const tenantCode = String(tenantCodeRaw ?? '').trim();
    const code = String(codeRaw ?? '').trim();
    if (!tenantCode) throw new BizError(ERR.VALIDATION_FAILED, '缺少租户编号');
    if (!/^\d{6}$/.test(code)) throw new BizError(ERR.VALIDATION_FAILED, '登录码是 6 位数字');

    // 限流：6 位码的空间只有 100 万，**不限流就等于允许在线撞码**。
    // 这是内存计数 —— 多实例部署时每个实例各计一份，等于放宽 N 倍，
    // 届时应换成 Redis 计数（与 S6 的推送/任务队列一起做）。
    const attempts = webLoginAttempts.get(tenantCode) ?? [];
    const recent = attempts.filter((t) => t > Date.now() - WEB_LOGIN_ATTEMPT_WINDOW_MS);
    if (recent.length >= WEB_LOGIN_ATTEMPT_MAX) {
      throw BizError.forbidden(ERR.VALIDATION_FAILED, '尝试次数过多，请重新生成登录码');
    }

    const tenant = await this.platform.findTenantByCode(tenantCode);
    if (!tenant) throw BizError.notFound(ERR.TENANT_NOT_FOUND, '店铺不存在');
    if (tenant.status === 'suspended') throw BizError.forbidden(ERR.TENANT_SUSPENDED, '本店暂停服务');

    const ok = await this.platform.consumeWebLoginCode(tenantCode, code);
    if (!ok) {
      recent.push(Date.now());
      webLoginAttempts.set(tenantCode, recent);
      // 不区分"码不存在 / 已过期 / 已用过" —— 区分了就等于帮撞码的人缩小范围
      throw BizError.forbidden(ERR.LOGIN_REQUIRED, '登录码不正确或已失效，请重新生成');
    }
    webLoginAttempts.delete(tenantCode);

    const { token, expiresAt } = issueToken({ tenantCode, role: 'owner' }, env.jwtSecret, 24 * 3600);
    return { tenantCode, shopName: tenant.shopName, token, expiresAt, role: 'owner' };
  }

  /** 一键配置全部楼栋：一条命令覆盖所有启用楼栋（§4.3） */
  async bulkConfigBuildings(tenantCode: string, patch: BulkBuildingConfig) {
    return this.repos.tenant(tenantCode).applyBulkConfig(patch);
  }

  /** 主题色入库：必须过对比度护栏（AC-06），不允许"提交什么就用什么" */
  async setThemeColor(tenantCode: string, submittedHex: string) {
    const guard = guardThemeColor(submittedHex);
    await this.repos.tenant(tenantCode).saveShopConfig({
      themeColor: submittedHex.toUpperCase(),
      themeScale: guard.scale as unknown as Record<string, string>,
      themeNotice: guard.notice,
    });
    return guard;
  }

  /** 解析租户全部启用楼栋的有效配置（含截单时间与来源标记） */
  async resolveBuildings(tenantCode: string): Promise<ResolvedBuildingConfig[]> {
    const repo = this.repos.tenant(tenantCode);
    const shop = await repo.getShopConfig();
    const buildings = await repo.listBuildings(false);
    return buildings.map((b) => resolveBuildingConfig(b, shop));
  }

  /** 供学生端展示：该楼栋此刻能不能下单 */
  async orderGateOf(tenantCode: string, buildingId: number, now = new Date()) {
    const repo = this.repos.tenant(tenantCode);
    const shop = await repo.getShopConfig();
    const building = await repo.findBuilding(buildingId);
    if (!building) throw BizError.notFound(ERR.BUILDING_NOT_FOUND, `楼栋不存在：${buildingId}`);
    const sub = await this.platform.getSubscription(tenantCode);
    const wallet = await this.platform.getWallet(tenantCode);
    const cfg = resolveBuildingConfig(building, shop);
    const ctx = currentContext();
    void ctx;
    return evaluateBuildingGate(
      cfg,
      {
        shopOpen: shop.shopOpen,
        subscriptionValid: !!sub?.periodEnd && new Date(sub.periodEnd).getTime() > now.getTime(),
        balanceCents: wallet?.balanceCents ?? 0,
        creditLimitCents: wallet?.creditLimitCents ?? CENTS.CREDIT_LIMIT,
      },
      { openTime: shop.openTime, closeTime: shop.closeTime },
      now,
    );
  }
}
