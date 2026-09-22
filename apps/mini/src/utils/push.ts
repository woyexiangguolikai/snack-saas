/**
 * 微信订阅消息授权（CS-13 的**增强**通道）。
 *
 * ⚠️ 先说清楚这不是主通道：站内消息才是。理由写在
 * `apps/server/src/core/types.ts` 的 NoticeRecord 注释里 ——
 * 一次授权只发一条、学生可以永久拒收、未认证小程序没有模板资格，
 * 三条加起来意味着**一定有人收不到推送**，所以订单进展必须落站内消息。
 *
 * 反过来，这里的模板 ID 依赖"已认证的小程序 + 后台申请到的模板"，
 * 现在还没拿到 AppID，所以 VITE_SUB_TMPL_* 默认是空的：
 *   · 空    → 完全不弹窗（弹了一个没配过模板的授权框只会报错）
 *   · 非空  → 走正常授权流程，并把结果上报服务端存起来
 * 等 AppID 与模板 ID 到位，只改环境变量，不改代码。
 */
import { currentAppId } from './appid';

function envOf(): Record<string, string> {
  return (import.meta as unknown as { env?: Record<string, string> }).env ?? {};
}

/** 只申请最关键的两个模板 —— 过量申请会一次性消耗掉学生的授权额度 */
export interface PushTemplate {
  key: 'delivered' | 'accepted';
  tmplId: string;
}

export function pushTemplates(): PushTemplate[] {
  const env = envOf();
  const out: PushTemplate[] = [];
  if (env.VITE_SUB_TMPL_DELIVERED) out.push({ key: 'delivered', tmplId: env.VITE_SUB_TMPL_DELIVERED });
  if (env.VITE_SUB_TMPL_ACCEPTED) out.push({ key: 'accepted', tmplId: env.VITE_SUB_TMPL_ACCEPTED });
  return out;
}

/** 是否处于"已经配过模板、可以弹授权"的状态 */
export function pushAvailable(): boolean {
  return pushTemplates().length > 0;
}

/**
 * 弹一次授权并把结果回给服务端。
 *
 * 三条工程约定：
 *  ① **失败一律静默**：这是锦上添花的东西，绝不能让学生觉得"下单出问题了"。
 *  ② **在被拒绝时不重试**：学生点过一次"取消"，同一单不再打扰第二次；
 *     微信自己也限频，连续弹会被判定为骚扰。
 *  ③ result 原样上报（accept / reject / ban / filter），服务端要区分
 *     "这次拒绝了"和"以后都别问了"这两种完全不同的处境。
 */
export function requestPushGrant(): Promise<Array<{ tmplId: string; result: string }> | null> {
  const list = pushTemplates();
  if (!list.length) return Promise.resolve(null);

  return new Promise((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (uni as unknown as { requestSubscribeMessage?: (o: unknown) => void }).requestSubscribeMessage;
    if (typeof api !== 'function') {
      resolve(null);
      return;
    }
    api({
      tmplIds: list.map((t) => t.tmplId),
      success: (r: Record<string, string>) => {
        // 微信返回：{ [tmplId]: 'accept' | 'reject' | 'ban' | 'filter', errMsg }
        resolve(list.map((t) => ({ tmplId: t.tmplId, result: r[t.tmplId] ?? 'reject' })));
      },
      fail: () => resolve(null),
    });
  });
}

/**
 * 一个便于排查的自述串：库只想知道"为什么没弹授权"。
 * 不能因为要排障就在生产日志里打模板 ID 全文。
 */
export function pushSelfCheck(): string {
  if (currentAppId()) return pushAvailable() ? '就绪' : '未配置模板 ID';
  return '未取到 AppID';
}
