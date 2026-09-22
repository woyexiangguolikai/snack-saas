export * from './theme';

/** 语义色 —— 每个色只有一个含义。这是整套状态语言的锚。 */
export const SEMANTIC = {
  /** 需要人立刻动手 */
  danger: { fg: '#C42B1C', bg: '#FCEDEA' },
  /** 即将需要动手，但现在还来得及 */
  warn: { fg: '#B45309', bg: '#FDF3E3' },
  /** 已闭环，无需任何动作 */
  ok: { fg: '#15803D', bg: '#EAF6EE' },
  /** 纯告知，不需要动作 */
  info: { fg: '#1D5FA8', bg: '#EAF1FA' },
  /** 不可用，但不危险 */
  off: { fg: '#6B6560', bg: '#F2F0EB' },
} as const;

/**
 * 状态 → 语义色 的唯一映射表。
 * 超出「允许出现的位置」即违规。特别地：
 *   已截单 / 本栋停送 / 休息中 / 未覆盖 一律 off（灰），不得用红或橙 —— AC-02
 */
export const STATUS_TONE = {
  // 订单
  pending_pay: 'off',        // 待付款（学生自己的动作，不催）
  pending_accept: 'danger',  // 待接单 —— 需要商户立刻动手
  delivering: 'info',        // 配送中 —— 纯进度告知
  delivered: 'ok',           // 已送达 —— 已闭环
  cancelled: 'off',
  refunded: 'off',
  // 时间窗（AC-02：截单是每天发生、次日自动恢复的正常节律，用红会稀释真正的红）
  orderable: 'ok',
  closing_soon: 'warn',      // 即将截单（剩余 < 30 分钟）
  closed: 'off',             // 已截单
  // 店铺 / 楼栋
  open: 'ok',
  resting: 'off',            // 休息中 = "还没开始"，不是错误
  delivery_off: 'off',       // 本栋停送 = "今天不做"，不是错误
  building_paused: 'off',
  not_covered: 'off',        // 楼栋未覆盖
  // 账本
  balance_low: 'warn',       // 余额 ≤ 预警线 50
  balance_blocked: 'danger', // 余额归零触及应急额度 —— 停单
  subscription_expiring: 'warn', // 订阅剩余 ≤ 7 天
  subscription_expired: 'off',
  // 库存格（AC-11：底色即状态 + 文字角标，双重编码，不依赖单一颜色）
  stock_normal: 'ok',
  stock_low: 'warn',
  stock_out: 'danger',
  // 平台
  pipeline_blocked: 'warn',  // 流水线卡点 = 正常流程，不用红
  pipeline_rejected: 'warn', // 审核驳回 = 琥珀，不用红
  push_failed: 'danger',
  reconcile_diff: 'danger',  // 对账差额 —— 必须标红
} as const;

export type StatusKey = keyof typeof STATUS_TONE;
export type Tone = keyof typeof SEMANTIC;

export function toneOf(status: StatusKey): Tone {
  return STATUS_TONE[status] as Tone;
}
