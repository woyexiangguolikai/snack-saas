import { parseHHmm } from './config-resolver';
import type { ResolvedBuildingConfig } from './types';

/* ============================================================================
 * 下单放行判定（§3.4 / §4.13.2）
 * ----------------------------------------------------------------------------
 * 可下单 = 订阅有效
 *        AND 余额 > -应急额度
 *        AND 店铺未手动关店
 *        AND 当前楼栋处于营业状态
 *        AND 在营业时间内
 *        AND 在宿舍可进入时间窗内
 *
 * 铁律：**时间只有一个真相源** —— 全部判定在服务端完成，前端只负责展示与倒计时
 *       （AC-14：前端本地时间判断"还能不能下单"= 不通过验收）
 * ==========================================================================*/

export const CHINA_TZ_OFFSET_MINUTES = 480; // UTC+8 —— 展示层时区，存储层一律 UTC

export type OrderGateState =
  | 'orderable'
  | 'closing_soon'        // 即将截单（剩余 < 30 分钟）→ 琥珀
  | 'closed'              // 已截单 → 灰（AC-02：绝不用红）
  | 'resting'             // 店铺休息中 = "还没开始"
  | 'building_paused'     // 本栋停用 / 今日停送 = "今天不做"
  | 'subscription_expired'
  | 'balance_blocked';

export interface OrderGateInput {
  shopOpen: boolean;
  buildingStatus: 'active' | 'disabled';
  buildingDeliveryEnabled: boolean;
  subscriptionValid: boolean;
  balanceCents: number;
  creditLimitCents: number;
  /** 营业时间 'HH:mm'，null = 不限制 */
  openTime: string | null;
  closeTime: string | null;
  /** 楼栋可进入时间窗 'HH:mm'（门禁，硬上限） */
  accessibleFrom: string;
  accessibleTo: string;
  /** 截单时间 'HH:mm' = 窗口结束 − 在途预留 */
  cutoffTime: string;
}

export interface OrderGateResult {
  orderable: boolean;
  state: OrderGateState;
  /** 语义色 key —— 直接决定 UI 颜色，业务代码不得自行选色 */
  tone: 'ok' | 'warn' | 'off' | 'danger';
  /** 中性人话文案，禁用"欠费"（D5） */
  message: string;
  /** 下次可下单时间 'HH:mm'，仅在不可下单时有值 */
  nextOpenAt: string | null;
  /** 距截单剩余分钟数，仅在 orderable / closing_soon 时有值 */
  minutesToCutoff: number | null;
}

/** 把 UTC 时刻转成中国时区的「当日分钟数」 */
export function localMinutesOf(now: Date, tzOffsetMinutes = CHINA_TZ_OFFSET_MINUTES): number {
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  return (utcMin + tzOffsetMinutes + 1440) % 1440;
}

const CLOSING_SOON_MINUTES = 30;

/**
 * 判定某个楼栋此刻能否下单。
 * 检查顺序 = 文案优先级：先回答"这家店开着吗"，再回答"这栋楼送吗"，最后回答"现在几点"。
 */
export function evaluateOrderGate(
  input: OrderGateInput,
  now: Date = new Date(),
  tzOffsetMinutes = CHINA_TZ_OFFSET_MINUTES,
): OrderGateResult {
  const nowMin = localMinutesOf(now, tzOffsetMinutes);

  // 1) 两道闸门 —— 我方服务费的开关（你唯一的收钱通道）
  if (!input.subscriptionValid) {
    return {
      orderable: false, state: 'subscription_expired', tone: 'off',
      message: '本店服务期已结束，店内商品可浏览，暂不可下单',
      nextOpenAt: null, minutesToCutoff: null,
    };
  }
  if (input.balanceCents <= input.creditLimitCents) {
    return {
      orderable: false, state: 'balance_blocked', tone: 'danger',
      message: '本店暂停承接新订单，请联系店家',
      nextOpenAt: null, minutesToCutoff: null,
    };
  }

  // 2) 店铺自己的开关
  if (!input.shopOpen) {
    return {
      orderable: false, state: 'resting', tone: 'off',
      message: '店家休息中，可以先逛逛',
      nextOpenAt: nextFrom(input, 'openTime', nowMin),
      minutesToCutoff: null,
    };
  }

  // 3) 楼栋：停用 与 今日停送 是两种"今天不做"，都用灰
  if (input.buildingStatus !== 'active') {
    return {
      orderable: false, state: 'building_paused', tone: 'off',
      message: '该楼栋已停止配送，请切换其他楼栋',
      nextOpenAt: null, minutesToCutoff: null,
    };
  }
  if (!input.buildingDeliveryEnabled) {
    return {
      orderable: false, state: 'building_paused', tone: 'off',
      message: '本栋今日已停送，明天恢复',
      nextOpenAt: input.accessibleFrom,
      minutesToCutoff: null,
    };
  }

  // 4) 营业时间（已被门禁收窄过）
  const winFrom = parseHHmm(input.accessibleFrom) ?? 0;
  const winTo = parseHHmm(input.accessibleTo) ?? 1439;
  const busFrom = parseHHmm(input.openTime) ?? winFrom;
  const busTo = parseHHmm(input.closeTime) ?? winTo;
  if (nowMin < busFrom || nowMin >= busTo) {
    return {
      orderable: false, state: 'resting', tone: 'off',
      message: nowMin < busFrom ? '还没开始营业' : '今日营业已结束',
      nextOpenAt: input.openTime ?? input.accessibleFrom,
      minutesToCutoff: null,
    };
  }

  // 5) 门禁时间窗 —— "营业到 23:30"在系统上是假配置：单能下、送不进去
  if (nowMin < winFrom) {
    return {
      orderable: false, state: 'closed', tone: 'off',
      message: '还没到可送达时间',
      nextOpenAt: input.accessibleFrom, minutesToCutoff: null,
    };
  }
  if (nowMin >= winTo) {
    return {
      orderable: false, state: 'closed', tone: 'off',
      message: '今日已截单，明天再来',
      nextOpenAt: input.accessibleFrom, minutesToCutoff: null,
    };
  }

  // 6) 截单时间（早于门禁结束，预留配送在途时间）
  const cutoff = parseHHmm(input.cutoffTime) ?? winTo;
  const minutesToCutoff = cutoff - nowMin;
  if (minutesToCutoff <= 0) {
    return {
      orderable: false, state: 'closed', tone: 'off',
      message: `今日已截单（${input.cutoffTime}），购物车会保留到明天`,
      nextOpenAt: input.accessibleFrom, minutesToCutoff: null,
    };
  }
  if (minutesToCutoff <= CLOSING_SOON_MINUTES) {
    return {
      orderable: true, state: 'closing_soon', tone: 'warn',
      message: `今日 ${input.cutoffTime} 截单，还有 ${minutesToCutoff} 分钟`,
      nextOpenAt: null, minutesToCutoff,
    };
  }

  return {
    orderable: true, state: 'orderable', tone: 'ok',
    message: `今日 ${input.cutoffTime} 截单，还有 ${minutesToCutoff} 分钟`,
    nextOpenAt: null, minutesToCutoff,
  };
}

function nextFrom(input: OrderGateInput, key: 'openTime', nowMin: number): string | null {
  const v = input[key];
  const m = parseHHmm(v);
  if (m === null) return input.accessibleFrom;
  return m > nowMin ? (v as string) : input.accessibleFrom;
}

/** 便捷入口：用已解析的楼栋配置直接判定 */
export function evaluateBuildingGate(
  cfg: ResolvedBuildingConfig,
  gates: { shopOpen: boolean; subscriptionValid: boolean; balanceCents: number; creditLimitCents: number },
  hours: { openTime: string | null; closeTime: string | null },
  now: Date = new Date(),
  tzOffsetMinutes = CHINA_TZ_OFFSET_MINUTES,
): OrderGateResult {
  return evaluateOrderGate(
    {
      shopOpen: gates.shopOpen,
      buildingStatus: cfg.status,
      buildingDeliveryEnabled: cfg.deliveryEnabled,
      subscriptionValid: gates.subscriptionValid,
      balanceCents: gates.balanceCents,
      creditLimitCents: gates.creditLimitCents,
      openTime: hours.openTime,
      closeTime: hours.closeTime,
      accessibleFrom: cfg.accessibleFrom,
      accessibleTo: cfg.accessibleTo,
      cutoffTime: cfg.cutoffTime,
    },
    now,
    tzOffsetMinutes,
  );
}
