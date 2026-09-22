/**
 * 统一请求层。
 *
 * 三件事只在这里做，别处不许重复：
 *   ① 注入租户 + 令牌（`/t/{tenantCode}/api/...` 前缀是服务端的硬约定）
 *   ② **401 自动重登一次**（令牌过期是必然会发生的，不该让每个页面各写一遍）
 *   ③ 把服务端的错误规整成统一的 `{ code, message }` ——
 *      后端所有错误都带 `code`，前端按 code 分支，**不解析 message 文案**
 *      （文案会改，而且中性文案是产品要求的一部分）
 */

export interface ApiError {
  code: string;
  message: string;
  status: number;
}

export class ApiFailure extends Error {
  readonly code: string;
  readonly status: number;
  constructor(e: ApiError) {
    super(e.message);
    this.name = 'ApiFailure';
    this.code = e.code;
    this.status = e.status;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  data?: unknown;
  /** 平台密钥（只有平台后台用；学生端/商户端不传） */
  platformKey?: string;
  /** 出错时不抛异常，直接把错误对象返回（用于"允许失败"的探测性请求） */
  tolerate?: boolean;
  /** 跳过 401 自动重登（登录接口本身用，否则会递归） */
  noRetry?: boolean;
}

interface SessionAccessor {
  tenantCode: () => string;
  token: () => string;
  /** 重新走一遍 wx.login + resolve，成功返回新令牌 */
  relogin: () => Promise<boolean>;
}

let session: SessionAccessor | null = null;
/** 由 session store 在初始化时注入 —— 避免 utils 反向依赖 stores 造成循环导入 */
export function bindSession(accessor: SessionAccessor): void {
  session = accessor;
}

/**
 * 商户（店主）会话 —— 与学生会话**并存但互不相干**。
 *
 * 为什么不是"登录商户就把 session 顶掉"：
 *   店主同时也是学生（他自己也在店里下单）。顶掉之后，他从商户端退回学生端
 *   就要重新走一遍 wx.login，而且两套令牌的有效期不同（商户 24h / 学生 7d）。
 *   两套并存、各走各的请求出口，才不会出现"用学生令牌去改价"这种 401。
 */
let merchantSession: SessionAccessor | null = null;
export function bindMerchantSession(accessor: SessionAccessor): void {
  merchantSession = accessor;
}

let baseUrl = '';
export function setBaseUrl(url: string): void {
  baseUrl = url.replace(/\/+$/, '');
}

/** 单飞：令牌过期时多个并发请求会同时 401，只能重登一次 */
let reloginInFlight: Promise<boolean> | null = null;

export async function request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  return requestAs<T>(path, opts, session, request);
}

/**
 * 商户端出口。与学生端共用同一套错误规整，但**令牌与重登走另一条链** ——
 * 商户端 401 要用店主身份重登，用学生的 relogin 去补只会拿到学生令牌，然后继续 401。
 */
export async function requestMerchant<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  return requestAs<T>(path, opts, merchantSession, requestMerchant);
}

async function requestAs<T>(
  path: string,
  opts: RequestOptions,
  accessor: SessionAccessor | null,
  self: (p: string, o: RequestOptions) => Promise<T>,
): Promise<T> {
  const url = buildUrl(path, accessor);
  const res = await rawRequest(url, opts, accessor);
  const status = res.statusCode ?? 0;

  if (status >= 200 && status < 300) return res.data as T;

  const err = normalizeError(res.data, status);

  // 令牌过期 → 重登一次再重试。只重试一次：无限重试会把服务端打爆，
  // 而且如果是"身份不对"，重试多少次都没用，只会让用户看到转圈。
  if (status === 401 && !opts.noRetry && accessor) {
    reloginInFlight = reloginInFlight ?? accessor.relogin().finally(() => { reloginInFlight = null; });
    const ok = await reloginInFlight;
    if (ok) return self(path, { ...opts, noRetry: true });
  }

  if (opts.tolerate) return { __error: err } as unknown as T;
  throw new ApiFailure(err);
}

function buildUrl(path: string, accessor: SessionAccessor | null): string {
  if (/^https?:\/\//.test(path)) return path;
  const p = path.startsWith('/') ? path : `/${path}`;
  // 租户前缀：/t/{tenantCode}/api/... 由服务端中间件解析（§2.2 兜底路径）
  if (p.startsWith('/t/') || p.startsWith('/api/')) return `${baseUrl}${p}`;
  const t = accessor?.tenantCode() ?? '';
  return `${baseUrl}/t/${t}/api${p}`;
}

function rawRequest(
  url: string,
  opts: RequestOptions,
  accessor: SessionAccessor | null,
): Promise<{ statusCode?: number; data?: unknown }> {
  return new Promise((resolve) => {
    const header: Record<string, string> = { 'content-type': 'application/json' };
    const token = accessor?.token();
    if (token) header.authorization = `Bearer ${token}`;
    if (opts.platformKey) header['x-platform-key'] = opts.platformKey;

    uni.request({
      url,
      method: (opts.method ?? 'GET') as never,
      data: opts.data as never,
      header,
      timeout: 12_000,
      success: (r) => resolve({ statusCode: r.statusCode, data: r.data }),
      // 网络层失败也要转成同一种错误形状 —— 否则上层要同时处理两种失败形态
      fail: (e) => resolve({ statusCode: 0, data: { code: 'NETWORK', message: e?.errMsg ?? '网络异常' } }),
    });
  });
}

function normalizeError(data: unknown, status: number): ApiError {
  const d = data as { error?: { code?: string; message?: string }; code?: string; message?: string } | undefined;
  const code = d?.error?.code ?? d?.code ?? (status === 0 ? 'NETWORK' : `HTTP_${status}`);
  const message = d?.error?.message ?? d?.message ?? defaultMessage(code, status);
  return { code, message, status };
}

function defaultMessage(code: string, status: number): string {
  if (code === 'NETWORK') return '网络不太顺，请稍后重试';
  if (status === 401) return '登录已过期，请重新进入';
  if (status === 403) return '没有权限执行该操作';
  if (status === 404) return '内容不见了';
  if (status >= 500) return '服务暂时不可用，请稍后重试';
  return '操作没有完成，请重试';
}

/** 供 UI 用：把任意异常转成人话（不解析后端文案时用） */
export function errText(e: unknown): string {
  if (e instanceof ApiFailure) return e.message;
  if (e instanceof Error) return e.message;
  return '操作没有完成，请重试';
}
