import type { OrderStatus, PayStatus } from '../core/types';

/* ============================================================================
 * 订单状态机（§4.13 / D15）
 * ----------------------------------------------------------------------------
 * 写成**一张穷举转移表**而不是散落的 if：
 *   · 合法转移一眼看全，评审时能直接对表；
 *   · 非法转移是被"查不到"拒绝的 —— 新增一个状态时，忘记补的边会自动变成
 *     "拒绝"，而不是被某个 if 的 else 分支悄悄放过去。
 * 表里没有的 (状态, 动作) 组合一律拒绝，没有例外。
 *
 * 两条不变量（不是约定，是表结构保证的）：
 *   ① **钱已收就不能直接取消** —— `cancel` 只在 payStatus='unpaid' 时合法。
 *      已付款要终止只有一条路：refund_start → refund_done → refunded。
 *      （"取消一笔已付款订单"如果不去动钱，账上就会凭空多出这笔 GMV 的服务费。）
 *   ② **库存语义与状态一一对应**：
 *      pending_pay = locked（预占）／pending_accept 起 = sold。
 *      所以 pay 与 cancel 是唯一会动库存的两个转移，别处不许碰库存。
 * ==========================================================================*/

export type OrderAction =
  | 'pay'            // 支付成功（来自支付回调）
  | 'cancel'         // 取消（超时关单 / 学生主动取消）—— 仅未支付
  | 'accept'         // 商户接单
  | 'deliver'        // 商户标记送达
  | 'refund_start'   // 发起退款（商户拒单 / 售后）
  | 'refund_done'    // 退款到账
  | 'refund_reject'; // 退款驳回 → 回到退款前的状态

/**
 * 转移表：`TABLE[action][from] = to`。
 *
 * `deliver` 允许从 `pending_accept` 直达（跳过"接单"）：
 * 商户取了货就上楼，强制两步只是让人多点一次，而这一跳不破坏任何不变量
 *（钱已收、库存已是 sold、房间号已确定）。少一个必经状态 ≠ 少一个保证。
 */
const TABLE: Record<OrderAction, Partial<Record<OrderStatus, OrderStatus>>> = {
  pay: { pending_pay: 'pending_accept' },
  cancel: { pending_pay: 'cancelled' },
  accept: { pending_accept: 'delivering' },
  deliver: { pending_accept: 'delivered', delivering: 'delivered' },
  refund_start: { pending_accept: 'refunding', delivering: 'refunding', delivered: 'refunding' },
  refund_done: { refunding: 'refunded' },
  // 驳回的目标不是固定值，由 resolveRefundReject() 按时间戳倒推；这里占位为 delivering，
  // 实际返回值以 resolveRefundReject 为准（见下方 transition() 的分支）
  refund_reject: { refunding: 'delivering' },
};

export interface TransitionContext {
  payStatus: PayStatus;
  acceptedAt: string | null;
  deliveredAt: string | null;
}

export interface TransitionFail {
  ok: false;
  /** 机器可判别的原因，前端按它选文案，不解析 message */
  reason: 'illegal_transition' | 'already_paid' | 'not_paid' | 'settled';
  message: string;
  from: OrderStatus;
  action: OrderAction;
}

export type TransitionResult = { ok: true; to: OrderStatus } | TransitionFail;

/** 流程终态：不再需要任何人推进（但已送达仍可进入售后走退款） */
const SETTLED: readonly OrderStatus[] = ['delivered', 'cancelled', 'refunded'];
/** 完全终态：不存在任何出边 */
const ABSOLUTE_FINAL: readonly OrderStatus[] = ['cancelled', 'refunded'];

export function isSettled(status: OrderStatus): boolean {
  return SETTLED.includes(status);
}

export function isAbsoluteFinal(status: OrderStatus): boolean {
  return ABSOLUTE_FINAL.includes(status);
}

/**
 * 退款被驳回后回到哪个状态 —— 从时间戳倒推，不额外存字段。
 * 存一个 `statusBeforeRefund` 字段看起来更直白，但它是**冗余状态**：
 * 一旦和 deliveredAt/acceptedAt 不一致，就会成为"到底该信哪个"的长期 bug 源。
 */
export function resolveRefundReject(ctx: TransitionContext): OrderStatus {
  if (ctx.deliveredAt) return 'delivered';
  if (ctx.acceptedAt) return 'delivering';
  return 'pending_accept';
}

export function transition(
  from: OrderStatus,
  action: OrderAction,
  ctx: TransitionContext,
): TransitionResult {
  // 守卫先于查表：这些拒绝理由比"表里没有"更具体，也就更有用
  if (action === 'pay' && ctx.payStatus === 'paid') {
    return {
      ok: false, reason: 'already_paid', from, action,
      message: '该订单已支付，无需重复支付',
    };
  }
  if (action === 'pay' && ctx.payStatus === 'refunded') {
    return {
      ok: false, reason: 'settled', from, action,
      message: '该订单已退款，不能再次支付',
    };
  }
  if (action === 'cancel' && ctx.payStatus !== 'unpaid') {
    return {
      ok: false, reason: 'not_paid', from, action,
      message: '该订单已收款，请走退款流程（取消只适用于尚未支付的订单）',
    };
  }
  if (action === 'refund_start' && ctx.payStatus !== 'paid') {
    return {
      ok: false, reason: 'not_paid', from, action,
      message: '该订单尚未收款，不存在可退的款项',
    };
  }

  const to = TABLE[action][from];
  if (!to) {
    return {
      ok: false, reason: 'illegal_transition', from, action,
      message: illegalMessage(from, action),
    };
  }

  if (action === 'refund_reject') {
    return { ok: true, to: resolveRefundReject(ctx) };
  }
  return { ok: true, to };
}

/** 只回答"能不能"，不关心为什么 —— 用于批量操作前的预筛 */
export function canTransition(
  from: OrderStatus,
  action: OrderAction,
  ctx: TransitionContext,
): boolean {
  return transition(from, action, ctx).ok;
}

/** 枚举某状态下所有合法动作 —— 前端按它决定按钮的可用性，避免"点了才报错" */
export function allowedActions(from: OrderStatus, ctx: TransitionContext): OrderAction[] {
  return (Object.keys(TABLE) as OrderAction[]).filter((a) => canTransition(from, a, ctx));
}

const STATUS_TEXT: Record<OrderStatus, string> = {
  pending_pay: '待支付',
  pending_accept: '待接单',
  delivering: '配送中',
  delivered: '已送达',
  cancelled: '已取消',
  refunding: '退款中',
  refunded: '已退款',
};

export function statusText(status: OrderStatus): string {
  return STATUS_TEXT[status];
}

/** 状态对应的语义色 key —— 服务端给色，前端不选色（AC-11）；"已取消"用灰不用红（AC-02） */
const STATUS_TONE: Record<OrderStatus, 'ok' | 'warn' | 'danger' | 'off'> = {
  pending_pay: 'warn',
  pending_accept: 'ok',
  delivering: 'ok',
  delivered: 'off',
  cancelled: 'off',
  refunding: 'warn',
  refunded: 'off',
};

export function statusTone(status: OrderStatus): 'ok' | 'warn' | 'danger' | 'off' {
  return STATUS_TONE[status];
}

function illegalMessage(from: OrderStatus, action: OrderAction): string {
  const act: Record<OrderAction, string> = {
    pay: '支付',
    cancel: '取消',
    accept: '接单',
    deliver: '标记送达',
    refund_start: '发起退款',
    refund_done: '确认退款到账',
    refund_reject: '驳回退款',
  };
  return `「${STATUS_TEXT[from]}」状态下不能${act[action]}`;
}
