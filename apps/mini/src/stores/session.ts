import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { currentAppId } from '../utils/appid';
import { ApiFailure, bindSession, request, setBaseUrl } from '../utils/request';
import { useThemeStore } from './theme';

/* ============================================================================
 * 会话与租户识别（§2.2）
 * ----------------------------------------------------------------------------
 * 三条硬约束，都是"宁可多点一次，也不要白屏"：
 *
 * ① **启动不阻塞首屏**：onLaunch 只从本地存储恢复令牌，不发任何网络请求。
 *    小程序 onLaunch 里的请求会拖慢首屏，而且一旦失败，用户看到的是白屏 ——
 *    而"白屏"是我们明确列为不可接受的失败形态。
 *
 * ② **不在启动时弹授权**：微信要求 `wx.login` 才能拿 code，而"getUserProfile"
 *    这类授权必须由用户手势触发。所以启动只拿**浏览令牌**（载荷无 userId），
 *    等到真正要下单 / 进"我的"时再 `ensureLogin()`。
 *
 * ③ **AppID 未匹配 → 「店铺未开通」，不是错误页**：`notFound` 是一个
 *    有专门页面的**业务状态**，不是异常。这是租户体系最容易被忽略的一条：
 *    一个没在你这里开店的 AppID 扫进来，看到的是"网络错误"会很困惑。
 * ==========================================================================*/

export interface ResolvedBuilding {
  buildingId: number;
  buildingCode: string;
  buildingName: string;
  status: 'active' | 'disabled';
  isDefault: boolean;
  deliveryEnabled: boolean;
  minAmountCents: number;
  deliveryFeeCents: number;
  accessibleFrom: string;
  accessibleTo: string;
  cutoffTime: string;
  notice: string | null;
  source: Record<string, 'building' | 'shop'>;
}

export interface SessionUser {
  id: number;
  nickname: string | null;
  avatar: string | null;
}

interface Persisted {
  tenantCode: string;
  token: string;
  expiresAt: string;
  user: SessionUser | null;
  /**
   * 店名也一起落盘。这不是多余的：
   * 下次启动时首屏能**立刻**用缓存渲染出正确的店名，
   * 而不是先出现一个空标题再"跳"成真名 —— 小程序里这种跳动很显廉价。
   * 楼栋记忆同理（学生几乎总在同一栋楼下单）。
   */
  shopName?: string;
  lastBuildingId?: number | null;
}

const STORAGE_KEY = 'snack.session';

/** 服务端未显式配置时用它 —— 本地开发指向本机服务 */
const DEFAULT_BASE = 'http://127.0.0.1:3000';

export const useSessionStore = defineStore('session', () => {
  const theme = useThemeStore();

  const tenantCode = ref('');
  const token = ref('');
  const expiresAt = ref('');
  const user = ref<SessionUser | null>(null);

  const shopName = ref('');
  const logoUrl = ref('');
  const announcement = ref<string | null>(null);
  const buildings = ref<ResolvedBuilding[]>([]);
  const singleBuildingMode = ref(false);
  const shopOpen = ref(true);
  const gates = ref({ subscriptionValid: true, balanceOk: true, subscriptionEndsAt: null as string | null, balanceCents: 0 });

  /** 已完成过一次 resolve（无论是否登录） */
  const resolved = ref(false);
  /** AppID 未匹配 —— 有专门的「店铺未开通」页面 */
  const notFound = ref(false);
  const suspended = ref(false);
  const lastError = ref<{ code: string; message: string } | null>(null);

  /**
   * 服务端时间 − 本地时间（毫秒）。
   * 设备时钟不准是很常见的（尤其学生的手机），而截单倒计时、待支付倒计时
   * 一旦基于本地时钟就会显示错误的时间。所以**判定用服务端、显示也用服务端偏移**
   * —— 前端只负责让秒数平滑地跳，不负责回答"现在几点"（AC-14）。
   */
  const serverTimeOffsetMs = ref(0);
  /**
   * 未读消息数（红点）。
   *
   * 刻意做成**可本地增减**，而不是每次都去服务端问：
   * 为一个红点数字发一轮请求，会让「我的」页的进入成本变高一倍。
   * 反正未读数允许短暂不准 —— 消息页进出一次就会校准。
   */
  const unread = ref(0);

  function setUnread(n: number): void {
    unread.value = Math.max(0, n);
  }

  /** 已知"多了几条"时直接累加，省掉一次往返 */
  function bumpUnread(by = 1): void {
    unread.value += Math.max(0, by);
  }

  const loggedIn = computed(() => !!user.value);
  const currentBuilding = computed(
    () => buildings.value.find((b) => b.buildingId === lastBuildingId.value) ?? buildings.value.find((b) => b.isDefault) ?? buildings.value[0] ?? null,
  );
  const lastBuildingId = ref<number | null>(null);

  /** 服务端时间 */
  function now(): number {
    return Date.now() + serverTimeOffsetMs.value;
  }

  /* ------------------------------------------------------------ 持久化 */

  function persist(): void {
    if (!tenantCode.value || !token.value) return;
    uni.setStorageSync(STORAGE_KEY, {
      tenantCode: tenantCode.value, token: token.value,
      expiresAt: expiresAt.value, user: user.value,
      shopName: shopName.value,
      lastBuildingId: lastBuildingId.value,
    } satisfies Persisted);
  }

  function restore(): boolean {
    try {
      const raw = uni.getStorageSync(STORAGE_KEY) as Persisted | '' | null;
      if (!raw || typeof raw !== 'object' || !raw.token) return false;
      // 本地先判一次过期：省掉一次注定 401 的请求（服务端仍会再判一次，这是第二道）
      if (raw.expiresAt && new Date(raw.expiresAt).getTime() < Date.now() + 60_000) return false;
      tenantCode.value = raw.tenantCode;
      token.value = raw.token;
      expiresAt.value = raw.expiresAt;
      user.value = raw.user ?? null;
      // 首屏即时渲染用：拿到旧值先显示，后台 resolve 回来再覆盖
      shopName.value = raw.shopName ?? '';
      lastBuildingId.value = raw.lastBuildingId ?? readLastBuildingId();
      return true;
    } catch {
      return false;
    }
  }

  function clear(): void {
    tenantCode.value = '';
    token.value = '';
    expiresAt.value = '';
    user.value = null;
    resolved.value = false;
    uni.removeStorageSync(STORAGE_KEY);
  }

  /* ------------------------------------------------------------ resolve */

  /** 进行中的 resolve —— 多个页面同时触发时只发一次请求 */
  let inFlight: Promise<boolean> | null = null;

  async function doResolve(login?: { code?: string; openid?: string; nickname?: string; avatar?: string }): Promise<boolean> {
    const appid = currentAppId();
    try {
      const r = await request<{
        tenantCode: string; shopName: string; logoUrl: string | null; announcement: string | null;
        themeScale: Record<string, string> | null; shopOpen: boolean;
        buildings: ResolvedBuilding[]; singleBuildingMode: boolean;
        gates: typeof gates.value;
        user: SessionUser | null;
        token: string; expiresAt: string; serverTime?: string;
      }>('/api/tenant/resolve', {
        method: 'POST',
        data: { appid, ...(login ?? {}) },
        // 登录接口自己不能用"401 自动重登"逻辑，否则会递归
        noRetry: true,
      });

      tenantCode.value = r.tenantCode;
      token.value = r.token;
      expiresAt.value = r.expiresAt;
      user.value = r.user ?? null;
      shopName.value = r.shopName;
      logoUrl.value = r.logoUrl ?? '';
      announcement.value = r.announcement;
      buildings.value = r.buildings ?? [];
      singleBuildingMode.value = !!r.singleBuildingMode;
      shopOpen.value = !!r.shopOpen;
      gates.value = r.gates;
      notFound.value = false;
      suspended.value = false;
      lastError.value = null;
      resolved.value = true;

      if (r.serverTime) {
        serverTimeOffsetMs.value = new Date(r.serverTime).getTime() - Date.now();
      }
      if (!lastBuildingId.value || !buildings.value.some((b) => b.buildingId === lastBuildingId.value)) {
        lastBuildingId.value = buildings.value.find((b) => b.isDefault)?.buildingId ?? buildings.value[0]?.buildingId ?? null;
      }

      // 换肤：服务端已过护栏，前端只负责塞进 CSS 变量
      if (r.themeScale) theme.applyTenantTheme(r.themeScale, r.tenantCode);
      persist();
      return true;
    } catch (e) {
      const err = e instanceof ApiFailure ? e : null;
      const code = err?.code ?? 'NETWORK';
      lastError.value = { code, message: err?.message ?? '店铺信息加载失败' };
      // 租户未开通是**业务状态**，走专门页面；其它错误保留重试入口
      notFound.value = code === 'TENANT_NOT_FOUND';
      suspended.value = code === 'TENANT_SUSPENDED';
      resolved.value = false;
      clear();
      return false;
    }
  }

  /** 首次进入或令牌失效后重新识别租户（不登录，只拿浏览令牌） */
  async function ensureResolved(): Promise<boolean> {
    if (resolved.value && tenantCode.value && token.value) return true;
    inFlight = inFlight ?? doResolve().finally(() => { inFlight = null; });
    return inFlight;
  }

  /* ------------------------------------------------------------ 登录 */

  /**
   * 走 wx.login 拿 code → 服务端 code2session → 建立学生身份。
   * 必须在用户手势里调用（微信的要求），不要放在 onLaunch。
   */
  async function login(): Promise<boolean> {
    const code = await wxCode();
    if (!code) {
      lastError.value = { code: 'LOGIN_CANCELLED', message: '未获取到微信登录凭证，请重试' };
      return false;
    }
    const ok = await doResolve({ code });
    if (!ok) return false;
    // 服务端未配置 AppID/AppSecret 时，resolve 会返回 WECHAT_NOT_CONFIGURED，
    // 这里保留 user=null，调用方据此提示"服务端未配置"，而不是静默失败
    return !!user.value;
  }

  /** 需要登录才能做的操作（下单 / 地址 / 我的订单）先过这一道 */
  async function ensureLogin(): Promise<boolean> {
    if (user.value) return true;
    // 先确保有浏览令牌（登录也要带 appid），再走登录
    await ensureResolved();
    return login();
  }

  /** 401 后的自动重登：原来是登录态就重新登录，否则只刷新浏览令牌 */
  async function relogin(): Promise<boolean> {
    const wasLoggedIn = !!user.value;
    clear();
    const ok = await doResolve();
    if (!ok) return false;
    return wasLoggedIn ? login() : true;
  }

  function logout(): void {
    clear();
  }

  /* ------------------------------------------------------------ 绑定到请求层 */

  setBaseUrl(baseUrlFromEnv());
  bindSession({
    tenantCode: () => tenantCode.value,
    token: () => token.value,
    relogin,
  });

  return {
    tenantCode, token, expiresAt, user,
    shopName, logoUrl, announcement, buildings, singleBuildingMode, shopOpen, gates,
    resolved, notFound, suspended, lastError, serverTimeOffsetMs, unread,
    loggedIn, currentBuilding, lastBuildingId,
    ensureResolved, login, ensureLogin, relogin, logout, clear, restore, now, setUnread, bumpUnread,
    setLastBuilding(id: number) {
      lastBuildingId.value = id;
      // 上次选择的楼栋存本地：换设备后服务端那份会兜底（双记忆）
      uni.setStorageSync('snack.lastBuildingId', id);
    },
  };
});

/** H5 本地联调指向本机服务；小程序端必须用已备案域名（开发工具里可勾"不校验域名"） */
function baseUrlFromEnv(): string {
  const env = (import.meta as unknown as { env?: Record<string, string> }).env ?? {};
  const url = env.VITE_API_BASE ?? DEFAULT_BASE;
  warnIfLoopback(url, !!env.PROD, env.VITE_API_BASE);
  return url;
}

/**
 * 兜底地址守卫：把「本机地址被打进包」这件事从**静默**变成**刺耳**。
 *
 * 为什么值得单独写一段：`VITE_API_BASE` 没配时会静默落到 `http://127.0.0.1:3000`，
 * 构建全绿、类型检查全绿、产物看着也正常 —— 只有真机上才炸成"网络异常"，
 * 而且排查方向会先往域名备案 / https 上跑，绕一大圈才回到"包里的地址是本机"。
 * 这里不能 throw（`build:mp` + 本机服务 + 开发者工具是**合法**的日常流程），
 * 只能把话说清楚；发布前的硬卡口在 `npm run check:build -- --release`。
 */
function warnIfLoopback(url: string, isProd: boolean, configured: string | undefined): void {
  const loopback = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(url);
  if (!loopback) return;
  const why = configured ? '' : '（VITE_API_BASE 未配置，用的是内置兜底值）';
  const head = isProd ? '[API 地址] 发布构建里出现本机地址' : '[API 地址] 当前指向本机服务';
  // eslint-disable-next-line no-console
  console.error(
    `${head}${why}：${url}\n` +
      '  · 开发者工具能连（请求由工具进程发出），真机 / 体验版 / 正式版**一定连不上**；\n' +
      '  · 发布前把 VITE_API_BASE 改成 https + 已备案域名，并跑 `npm run check:build -- --release` 卡口。',
  );
}

/** 从上次的楼栋记忆里取值（由 store 外部在恢复会话后调用） */
export function readLastBuildingId(): number | null {
  try {
    const v = uni.getStorageSync('snack.lastBuildingId');
    return typeof v === 'number' && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/** wx.login 的 Promise 包装 —— 拿不到 code 时返回 null，由调用方决定怎么提示 */
export function wxCode(): Promise<string | null> {
  return new Promise((resolve) => {
    uni.login({
      provider: 'weixin',
      success: (r) => resolve(r?.code ?? null),
      // H5 端没有 wx.login —— 本地联调时用 openid 直传（服务端仅在非生产放开）
      fail: () => resolve(devOpenid()),
    });
  });
}

/**
 * H5 本地联调的登录兜底：用固定 openid 直传。
 * **服务端只在非生产环境接受它**（WECHAT_ALLOW_INSECURE_OPENID），
 * 生产环境会返回 LOGIN_REQUIRED。
 */
function devOpenid(): string | null {
  const env = (import.meta as unknown as { env?: Record<string, string> }).env ?? {};
  return env.VITE_DEV_OPENID ?? null;
}
