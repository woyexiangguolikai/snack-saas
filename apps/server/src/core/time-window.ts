import { parseHHmm } from './config-resolver';
// copy.ts 是**叶子模块**（零 import），所以"核心层引账本层的文案"不会形成循环，
// 换来的是"学生端脱敏话术只有一个出处"——比分层洁癖值钱。
import { COPY } from '../ledger/copy';
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

/* ----------------------------------------------------------------------------
 * 业务日 / 业务月
 *
 * "今天"是一个**业务概念**，不是 UTC 概念：存储层一律 UTC，而对商户来说
 * "今天送了几单、收了多少钱"问的是北京时间的那一天。
 *
 * 这里必须是唯一实现。此前 `bizDate` 只存在于 LedgerService（私有静态）、
 * 冒烟脚本里又各写了一份匿名函数 —— 三份口径一致纯属巧合。
 * 一旦有人改了一处（比如改成用 UTC 直接切日），"账期"与"配送日报"就会
 * 各说各话，而两个数字看起来都合理，很难被发现。
 * -------------------------------------------------------------------------- */

/** 中国时区的自然日 YYYY-MM-DD */
export function bizDayOf(at: Date | string | number = new Date(), tzOffsetMinutes = CHINA_TZ_OFFSET_MINUTES): string {
  return new Date(new Date(at).getTime() + tzOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** 中国时区的自然月 YYYY-MM（账期口径） */
export function bizMonthOf(at: Date | string | number = new Date(), tzOffsetMinutes = CHINA_TZ_OFFSET_MINUTES): string {
  return bizDayOf(at, tzOffsetMinutes).slice(0, 7);
}

/** 某个业务日的起点（UTC 时刻）—— 用于把"当日"变成一条可比较的边界 */
export function bizDayStartOf(at: Date | string | number = new Date(), tzOffsetMinutes = CHINA_TZ_OFFSET_MINUTES): Date {
  const local = new Date(new Date(at).getTime() + tzOffsetMinutes * 60_000);
  const midnightUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return new Date(midnightUtc - tzOffsetMinutes * 60_000);
}

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
  /**
   * 短标题（不带句号）。
   *
   * 为什么要把标题从 message 里拆出来：§6.4 / AC-02 要求三种"今天做不了"
   * （休息中 / 本栋停送 / 已截单）**共用同一张模板、同一种灰色，差别只在
   * 图标、标题、恢复时间**。如果只有一整句话，前端就只能把它当标题用，
   * 于是恢复时间被埋进句子里、三张牌长得各不相同 —— AC-02 当场失效。
   */
  title: string;
  /** 「什么时候能再来」的独立一句，没有就给 null（不承诺 = 不撒谎） */
  recovery: string | null;
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
  //
  // ⚠️ 这两条是**商户的经营状况**，学生不欠我们钱、也替店家充不了值，
  //    所以对外（student）一律只说"暂未营业"，与"店家休息中"同色同措辞。
  //    内部 state 仍然区分（商户端与运维要靠它排障），但 message 不可区分 ——
  //    只要能区分，"这家店快开不下去了"就会顺着界面传出去（§6.5 / AC-13）。
  if (!input.subscriptionValid) {
    return {
      orderable: false, state: 'subscription_expired', tone: 'off',
      message: COPY.studentShopResting,
      title: COPY.studentShopRestingTitle,
      recovery: null,
      nextOpenAt: null, minutesToCutoff: null,
    };
  }
  if (input.balanceCents <= input.creditLimitCents) {
    return {
      orderable: false, state: 'balance_blocked', tone: 'danger',
      message: COPY.studentShopResting,
      title: COPY.studentShopRestingTitle,
      recovery: null,
      nextOpenAt: null, minutesToCutoff: null,
    };
  }

  // 2) 店铺自己的开关
  if (!input.shopOpen) {
    const next = nextFrom(input, 'openTime', nowMin);
    return {
      orderable: false, state: 'resting', tone: 'off',
      message: '店家休息中，可以先逛逛',
      title: '店家休息中',
      recovery: whenNext(next, input.openTime, nowMin, '开始接单'),
      nextOpenAt: next,
      minutesToCutoff: null,
    };
  }

  // 3) 楼栋：停用 与 今日停送 是两种"今天不做"，都用灰
  if (input.buildingStatus !== 'active') {
    return {
      orderable: false, state: 'building_paused', tone: 'off',
      // §6.2：停用 = 这家店不在这栋楼做生意了（历史订单保留），所以没有"明天恢复"。
      // 与「今日停送」共用灰色牌面，但文案必须能区分 —— 说错会让学生白等一天。
      message: '该楼栋已停送，请切换其他楼栋下单',
      title: '该楼栋已停送',
      // 不给恢复时间：停用是"这家店不在这栋做了"，承诺"明天恢复"就是撒谎
      recovery: null,
      nextOpenAt: null, minutesToCutoff: null,
    };
  }
  if (!input.buildingDeliveryEnabled) {
    return {
      orderable: false, state: 'building_paused', tone: 'off',
      message: '本栋今日已停送，明天恢复',
      title: '本栋今日已停送',
      recovery: `明天 ${input.accessibleFrom} 恢复`,
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
    const before = nowMin < busFrom;
    const next = input.openTime ?? input.accessibleFrom;
    return {
      orderable: false, state: 'resting', tone: 'off',
      message: before ? '还没开始营业' : '今日营业已结束',
      title: before ? '店家还没开始营业' : '今天营业结束了',
      recovery: before ? `${next} 开始接单` : `明天 ${next} 开始接单`,
      nextOpenAt: next,
      minutesToCutoff: null,
    };
  }

  // 5) 门禁时间窗 —— "营业到 23:30"在系统上是假配置：单能下、送不进去
  if (nowMin < winFrom) {
    return {
      orderable: false, state: 'closed', tone: 'off',
      message: '还没到可送达时间',
      title: '还没到可送达时间',
      recovery: `${input.accessibleFrom} 开始送`,
      nextOpenAt: input.accessibleFrom, minutesToCutoff: null,
    };
  }
  if (nowMin >= winTo) {
    return {
      orderable: false, state: 'closed', tone: 'off',
      message: '今日已截单，明天再来',
      title: '今天送到这儿了',
      recovery: `明天 ${input.accessibleFrom} 可再次下单`,
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
      title: '今天送到这儿了',
      recovery: `明天 ${input.accessibleFrom} 可再次下单`,
      nextOpenAt: input.accessibleFrom, minutesToCutoff: null,
    };
  }
  if (minutesToCutoff <= CLOSING_SOON_MINUTES) {
    return {
      orderable: true, state: 'closing_soon', tone: 'warn',
      message: `今日 ${input.cutoffTime} 截单，还有 ${minutesToCutoff} 分钟`,
      title: '即将截单',
      recovery: `还有 ${minutesToCutoff} 分钟，请尽快下单`,
      nextOpenAt: null, minutesToCutoff,
    };
  }

  return {
    orderable: true, state: 'orderable', tone: 'ok',
    message: `今日 ${input.cutoffTime} 截单，还有 ${minutesToCutoff} 分钟`,
    title: '现在可以下单',
    recovery: `${input.cutoffTime} 截单 · 还有 ${minutesToCutoff} 分钟`,
    nextOpenAt: null, minutesToCutoff,
  };
}

/**
 * 「下次什么时候可以」的一句话。
 *
 * 只说 '08:00 开始接单' 是不够的：现在是 09:00 时它读起来像"这时候才开始"，
 * 明天看又是另一个意思。所以时间点能落在今天就说"今天"，否则说"明天"。
 */
function whenNext(next: string | null, todayTime: string | null, nowMin: number, verb: string): string | null {
  if (!next) return null;
  const m = parseHHmm(next);
  if (m === null) return `${next} ${verb}`;
  const isToday = todayTime === next && m > nowMin;
  return `${isToday ? '今天' : '明天'} ${next} ${verb}`;
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
