/**
 * 取当前运行环境的小程序 AppID。
 *
 * **AppID 是"这套代码属于哪家店"的唯一入口**（§2.2 单域名 + AppID 换租户）。
 * 服务端拿它去查租户：查不到 → 前端渲染「店铺未开通」页，**绝不白屏**。
 *
 * ⚠️ AppSecret **绝不能出现在前端**。它只在服务端用于 code2session，
 *    见 `apps/server/src/auth/wechat.service.ts`。
 *    前端拿到 AppSecret 的人可以冒充你所有租户的小程序身份。
 *
 * 两端取值方式不同：
 *   · 小程序 —— `uni.getAccountInfoSync()` 由微信注入真实 AppID（代码里写死也没用，真机以这里为准）
 *   · H5    —— 没有这个 API，用构建期注入的 `VITE_APPID`（本地联调用）
 */
export function currentAppId(): string {
  // 小程序端：以微信注入的为准，不要用 manifest 里那个（可能是占位值）
  try {
    const info = uni.getAccountInfoSync?.();
    const id = info?.miniProgram?.appId;
    if (id) return id;
  } catch {
    // H5 或旧基础库没有这个 API —— 落到下面的兜底
  }

  const env = (import.meta as unknown as { env?: Record<string, string> }).env ?? {};
  return env.VITE_APPID ?? '';
}

/** H5 本地联调时没配 VITE_APPID 的自检提示（不抛错，交给上层决定怎么展示） */
export function appIdHint(): string | null {
  return currentAppId() ? null : '未取到 AppID：H5 本地联调请在 .env.local 里设置 VITE_APPID';
}
