/**
 * 网页后台的 HTTP 层。
 *
 * 三条与小程序端一致的纪律：
 *   ① 错误统一形状：业务错误与网络失败都收敛成 ApiFailure，页面只处理一种失败；
 *   ② 401 只重试一次：令牌过期重登一次再试，无限重试会把服务端打爆，
 *      而且"码已失效"重试多少次都没用，只会让用户看着转圈；
 *   ③ 基址默认同源：产物里不写死域名，换环境只改 Nginx。
 *
 * 另外这一层还负责**上报网络事实**（成功/网络类失败）给全局网络横幅：
 * 只有请求层知道真实发生过几次失败，页面层只能猜。
 */
import { netReporter } from '@/composables/useNetStatus';

/** 留空 = 同源相对路径（生产由 Nginx 反代 /api 与 /t 到服务端） */
const BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');

export class ApiFailure extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ApiFailure';
    this.code = code;
    this.status = status;
  }
}

interface ErrBody {
  error?: { code?: string; message?: string };
  message?: string;
}

/** 由 session 注入取令牌的函数 —— 避免 api 层反向依赖 store 造成循环导入 */
let tokenOf: () => string = () => '';
let onUnauthorized: (() => void) | null = null;
/** 平台密钥（平台后台专用）。与店主令牌**互斥使用**，绝不混在一个请求里 */
let platformKeyOf: () => string = () => '';

export function bindAuth(opts: { token: () => string; onUnauthorized?: () => void }): void {
  tokenOf = opts.token;
  onUnauthorized = opts.onUnauthorized ?? null;
}

/**
 * 平台密钥的注入点。
 *
 * ⚠️ 过渡方案：上线前必须换成账号体系 + RBAC。
 * 现在这样设计的唯一目的是**让两套身份在代码里就分得开** ——
 * 店主令牌与平台密钥各自有一个注入点、各自挂在不同的请求头上，
 * 于是"某个平台页不小心用了店主令牌"这件事在代码上是写不出来的。
 */
export function bindPlatformKey(fn: () => string): void {
  platformKeyOf = fn;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /** 走平台密钥而非店主令牌 */
  platform?: boolean;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const qs = opts.query
    ? Object.entries(opts.query)
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&')
    : '';
  const url = `${BASE}${path}${qs ? `?${qs}` : ''}`;

  // 显式声明类型：三元 + 展开会让 TS 推出 `authorization?: undefined` 这类联合，
  // 而它 assign 不进 HeadersInit —— 报出来的错会指向 fetch 而不是这行，很难找
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.platform) {
    const key = platformKeyOf();
    if (key) headers['x-platform-key'] = key;
  } else {
    const token = tokenOf();
    if (token) headers.authorization = `Bearer ${token}`;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    // 网络层失败也要转成同一种错误形状 —— 否则每个页面都要同时处理两种失败
    netReporter.failure();
    throw new ApiFailure('NETWORK', '连不上服务器，请检查网络后重新加载', 0);
  }
  // 只要有响应就算网络通（哪怕是 500）—— 横幅说的是"网络"，不是"服务端对不对"
  netReporter.success();

  const text = await res.text();
  const data: unknown = text ? safeJson(text) : null;

  if (res.ok) return (data ?? {}) as T;

  // 平台侧 401/403 = 密钥不对。**不触发店主会话的登出** ——
  // 两套身份混在一个 onUnauthorized 回调里，会让"平台密钥填错"把人踢出商户后台
  if (!opts.platform && res.status === 401 && onUnauthorized) onUnauthorized();

  const body = (data ?? {}) as ErrBody;
  throw new ApiFailure(
    body.error?.code ?? 'UNKNOWN',
    // 兜底话必须带上一句"还能做什么"。只写「请求失败」的话，运营只能来问我们。
    body.error?.message ?? body.message ?? `服务器没有返回结果（状态 ${res.status}），可以重新加载试试`,
    res.status,
  );
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
