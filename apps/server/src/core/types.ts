/**
 * 领域类型 —— 服务端内部与 API 共用的形状。
 * 金额一律整数「分」；时间一律 UTC ISO 字符串。
 */

export const CENTS = {
  // 账本（D1 / D2，已定稿，不允许在别处硬编码这些数字）
  SUBSCRIPTION_FEE: 30000, // 300 元/学期
  WARN_LINE: 5000,         // 预警线 50 元
  CREDIT_LIMIT: -2000,     // 应急额度：允许透支 20 元
  MIN_TOPUP: 10000,        // 最低充值 100 元
  FEE_RATE: 0.02,          // 交易服务费 2%
} as const;

/**
 * 费率用「基点」参与运算，不用小数。
 * 原因：`amountCents * 0.02` 是浮点乘法，1005 × 0.02 = 20.099999999999998，
 * 四舍五入的结果依赖 IEEE754 舍入方向 —— 账目上不能出现"通常对、偶尔差一分"。
 * 整数基点乘法在本项目金额量级（分）内不会溢出 Number.MAX_SAFE_INTEGER。
 */
export const FEE_BP = 200;
export const BP_DENOM = 10_000;

/** 单笔订单的服务费（分）。**全系统只此一处定义**，不得在别处再算一遍 2%。 */
export function feeOfCents(amountCents: number): number {
  return Math.round((amountCents * FEE_BP) / BP_DENOM);
}

/** 到期提醒阈值（天）：15 / 7 / 3，每个阈值只提醒一次 */
export const SUBSCRIPTION_WARN_DAYS = [15, 7, 3] as const;

/** 租户状态机 */
export type TenantStatus = 'draft' | 'pipeline' | 'active' | 'suspended' | 'expired';
/** 楼栋状态：**只能停用，不能删除** */
export type BuildingStatus = 'active' | 'disabled';

export interface TenantRecord {
  id: number;
  tenantCode: string;
  appid: string | null;
  mchId: string | null;
  orgName: string;
  shopName: string;
  schoolId: number | null;
  contactName: string | null;
  contactPhone: string | null;
  logoUrl: string | null;
  region: string | null;
  status: TenantStatus;
  dbName: string;
  createdAt: string;
}

export interface SubscriptionRecord {
  tenantCode: string;
  periodStart: string | null;
  periodEnd: string | null;
  status: 'active' | 'expiring' | 'expired';
  feeCents: number;
  /** 已发过的到期提醒位（15/7/3）—— 去重靠它，否则每日任务会天天骚扰商户 */
  notifyFlags: string | null;
  lastRenewAt: string | null;
}

export interface WalletRecord {
  tenantCode: string;
  balanceCents: number;
  creditLimitCents: number;
  warnLineCents: number;
  minTopupCents: number;
  status: 'active' | 'warned' | 'blocked';
}

/* ---------------------------------------------------------------- 账本明细 */

/**
 * 余额变动类型。
 * `fee` 一天一条（汇总扣减），不是一单一 条 —— 200 笔订单跨日只产生 1 条扣费流水，
 * 但每条 fee 流水都携带 runId，可回到 settlement_run 再展开到每一笔订单。
 */
export type WalletTxnType = 'topup' | 'fee' | 'refund' | 'adjust';

export type WalletTxnSource = 'manual' | 'wxpay' | 'job' | 'system';

export interface WalletTxnRecord {
  id: number;
  tenantCode: string;
  type: WalletTxnType;
  /** 有符号：充值为正、扣费为负 */
  amountCents: number;
  /** 落账后余额快照 —— 用于对账时逐条验证流水与余额自洽 */
  balanceAfterCents: number;
  /** 每笔扣费/返还都必须能回链到具体订单（无则填 runId 汇总） */
  refOrderNo: string | null;
  runId: number | null;
  source: WalletTxnSource;
  operator: string | null;
  remark: string | null;
  createdAt: string;
}

/**
 * 平台库的订单汇总（**只存钱，不存人**，绝不含房间号/楼层）：AC-13。
 * 它同时充当「支付成功待扣记录」—— 状态 paid 就是待扣队列。
 */
export type OrderSummaryStatus = 'paid' | 'settled' | 'refunded' | 'canceled';

export interface OrderSummaryRecord {
  id: number;
  tenantCode: string;
  orderNo: string;
  amountCents: number;
  feeCents: number;
  status: OrderSummaryStatus;
  paidAt: string | null;
  buildingCode: string | null;
  settledRunId: number | null;
  settledAt: string | null;
  refundCents: number;
  refundedAt: string | null;
  createdAt: string;
}

/** 每日汇总扣减的一次执行（幂等键：runDate + tenantCode） */
export interface SettlementRunRecord {
  id: number;
  /** YYYY-MM-DD（按中国时区的自然日） */
  runDate: string;
  tenantCode: string;
  orderCount: number;
  gmvCents: number;
  feeCents: number;
  status: 'pending' | 'done' | 'failed';
  failReason: string | null;
  createdAt: string;
}

/** 账单（S7 生成，差额 ≠0 必须在后台标红） */
export interface StatementRecord {
  tenantCode: string;
  period: string;
  orderCount: number;
  gmvCents: number;
  feeDueCents: number;
  feeDeductedCents: number;
  diffCents: number;
  status: 'open' | 'ok' | 'diff';
  createdAt: string;
}

/** 待扣队列的一条（对外展示用，比 OrderSummaryRecord 窄） */
export interface ReceivableItem {
  orderNo: string;
  amountCents: number;
  feeCents: number;
  paidAt: string | null;
  buildingCode: string | null;
}

/** 账本自洽核对结果：balance 必须恒等于流水求和 */
export interface LedgerReconcile {
  tenantCode: string;
  balanceCents: number;
  txnSumCents: number;
  diffCents: number;
  txnCount: number;
  /** 待扣订单的理论服务费合计（用于和 settlement 对账） */
  pendingFeeCents: number;
  pendingOrderCount: number;
  /** 已结算订单的服务费合计 */
  settledFeeCents: number;
  settledOrderCount: number;
  ok: boolean;
}

/** 订阅到期提醒（15/7/3，每个阈值只推一次） */
export interface SubscriptionReminder {
  tenantCode: string;
  shopName: string;
  periodEnd: string;
  daysLeft: number;
  threshold: number;
  /** 中性文案（禁用词表之外的措辞） */
  title: string;
  body: string;
}

/* ---------------------------------------------------------------- 商品与库存 */

/** 商品全局状态：active 在售 / off 全局下架 */
export type ProductStatus = 'active' | 'off';
/** 商品在某栋的状态：on 已在该栋上架 / off 该栋单独下架 */
export type StockStatus = 'on' | 'off';

export interface CategoryRecord {
  id: number;
  name: string;
  sort: number;
  status: 'active' | 'off';
}

export interface ProductRecord {
  id: number;
  name: string;
  cover: string | null;
  spec: string | null;
  /** ⚠️ 价格全局统一，不按楼栋（D11）—— 换个楼栋就改价会让学生怀疑被宰 */
  priceCents: number;
  categoryId: number | null;
  status: ProductStatus;
  sort: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * SKU × 楼栋 的一格。
 * `stock` 可售 / `locked` 已下单未支付（预占）/ `sold` 已支付累计。
 * 可用量 = stock（预占时已从 stock 扣走），不是 stock − locked —— 这一点最容易写错。
 */
export interface ProductStockRecord {
  id: number;
  productId: number;
  buildingId: number;
  stock: number;
  locked: number;
  sold: number;
  status: StockStatus;
  warnStock: number | null;
  updatedAt: string;
}

/**
 * 库存流水类型。七类，缺一类都会在某个场景下"库存对不上但查不出原因"。
 */
export type StockLogType =
  | 'order_hold'      // 下单预占（stock−−, locked++）
  | 'pay_confirm'     // 支付确认（locked−−, sold++）
  | 'cancel_release'  // 取消/超时释放（locked−−, stock++）
  | 'refund_return'   // 退款回库（sold−−, stock++，仅未送达）
  | 'manual_adjust'   // 人工调整（盘点纠偏）
  | 'transfer_out'    // 调拨出
  | 'transfer_in';    // 调拨入

export interface StockLogRecord {
  id: number;
  productId: number;
  buildingId: number;
  type: StockLogType;
  /** 有符号变化量；预占记负数 */
  change: number;
  /** 变更后的可售值快照 —— 用于逐条复算库存 */
  stockAfter: number;
  refOrderNo: string | null;
  operator: string | null;
  remark: string | null;
  createdAt: string;
}

/**
 * 商品在某个楼栋的对外可见状态（前台三态）。
 * 这三态必须**分开**，把"未上架"和"售罄"混成一个会让顾客以为店里有货。
 */
export type ProductVisibility =
  | 'hidden'      // 未在该楼栋上架 / 商品全局下架 → 前台不显示（不是售罄！）
  | 'sold_out'    // 已上架但库存 0 → 显示售罄，不可加购
  | 'available';  // 可加购

export interface ProductCellView {
  buildingId: number;
  buildingCode: string;
  buildingName: string;
  /** 该格是否存在记录；不存在 = 从未在该栋上架 */
  exists: boolean;
  status: StockStatus;
  stock: number;
  locked: number;
  sold: number;
  warnStock: number | null;
  visibility: ProductVisibility;
  /** 双重编码：底色即状态（AC-11）—— 颜色由服务端给，业务代码不得自行选色 */
  tone: 'ok' | 'warn' | 'danger' | 'off';
  /** 文字角标，与底色同时出现（色盲可读） */
  badge: string;
}

export interface ProductMatrixRow {
  productId: number;
  name: string;
  spec: string | null;
  priceCents: number;
  categoryId: number | null;
  status: ProductStatus;
  sort: number;
  cells: ProductCellView[];
  /** 各栋合计，用于"全部楼栋"视图 */
  totalStock: number;
}

export interface SchoolRecord {
  id: number;
  name: string;
  region: string;
  city: string | null;
}

/** 上线流水线阶段（§5 的 12 阶段） */
export interface PipelineStageRecord {
  tenantCode: string;
  stageNo: number;
  stageName: string;
  status: 'pending' | 'doing' | 'done' | 'rejected';
  owner: PipelineOwner;
  startAt: string | null;
  doneAt: string | null;
  rejectReason: string | null;
  contactedAt: string | null;
  remark: string | null;
}

/** 责任方：renter 商户 / partner 合伙人 / platform 我方 / system 系统 */
export type PipelineOwner = 'renter' | 'partner' | 'platform' | 'system';

export interface BuildingTemplateRecord {
  id: number;
  schoolId: number;
  name: string;
  sort: number;
}

/**
 * 楼栋级配置。
 * **缺省 = 继承店铺** —— 这条规则由 ConfigResolver 统一实现，
 * 任何业务代码不得自行 fallback（否则「加配置项不改表」的铁律会被绕过）。
 */
export interface BuildingConfigOverride {
  minAmountCents?: number | null;
  deliveryFeeCents?: number | null;
  accessibleFrom?: string | null;
  accessibleTo?: string | null;
  notice?: string | null;
  // 允许商户自定义扩展键，将来新增配置项无需改表
  [key: string]: unknown;
}

export interface BuildingRecord {
  id: number;
  code: string;
  name: string;
  sort: number;
  status: BuildingStatus;
  isDefault: boolean;
  deliveryEnabled: boolean;
  minAmountCents: number | null;
  deliveryFeeCents: number | null;
  accessibleFrom: string | null;
  accessibleTo: string | null;
  notice: string | null;
  configOverride: BuildingConfigOverride | null;
  createdAt: string;
}

export interface ShopConfigRecord {
  shopName: string;
  logoUrl: string | null;
  announcement: string | null;
  themeColor: string | null;
  themeScale: Record<string, string> | null;
  themeNotice: string | null;
  minAmountCents: number;
  deliveryFeeCents: number;
  openTime: string | null;
  closeTime: string | null;
  accessibleFrom: string | null;
  accessibleTo: string | null;
  cutoffLeadMinutes: number;
  contactPhone: string | null;
  shopOpen: boolean;
}

/** 解析后的楼栋有效配置（楼栋值 ?? 店铺值） */
export interface ResolvedBuildingConfig {
  buildingId: number;
  buildingCode: string;
  buildingName: string;
  status: BuildingStatus;
  /** 默认楼栋：单楼栋商户的唯一下单入口，学生端无楼栋记忆时预选它 */
  isDefault: boolean;
  deliveryEnabled: boolean;
  minAmountCents: number;
  deliveryFeeCents: number;
  accessibleFrom: string;
  accessibleTo: string;
  /** 截单时间 = 可进入时间窗结束 − 在途时间；**永远早于窗口结束**（D14） */
  cutoffTime: string;
  notice: string | null;
  /** 每个字段的来源，用于后台「继承 / 已覆盖」标记与排障 */
  source: Record<'minAmountCents' | 'deliveryFeeCents' | 'accessibleFrom' | 'accessibleTo' | 'notice', 'building' | 'shop'>;
}

export interface TenantResolveResult {
  tenantCode: string;
  shopName: string;
  logoUrl: string | null;
  announcement: string | null;
  themeScale: Record<string, string> | null;
  shopOpen: boolean;
  /** 楼栋清单随配置下发 → 商户新增楼栋后学生端**立即看到，无需发版**（§2.2） */
  buildings: ResolvedBuildingConfig[];
  /** 单楼栋自动降级：有效楼栋 = 1 时前端隐藏全部楼栋 UI（§4.9） */
  singleBuildingMode: boolean;
  gates: {
    subscriptionValid: boolean;
    balanceOk: boolean;
    subscriptionEndsAt: string | null;
    balanceCents: number;
  };
  /** 已登录时返回用户身份摘要；纯浏览（未授权）时为 null */
  user: { id: number; nickname: string | null; avatar: string | null } | null;
  token: string;
  expiresAt: string;
  /**
   * 服务端当前时间（ISO）。**这不是"顺便返回一下"**——
   * 学生手机的时钟经常不准（改过时区、手动改过时间、系统时间漂移），
   * 而截单倒计时 / 待支付倒计时一旦基于本地时钟，就会显示错误的时间——
   * 最严重的情况是"眼看还有 20 分钟，其实已经截单"（AC-14）。
   * 前端拿它算一个固定偏移量，之后的"现在几点"一律以服务端为基准。
   */
  serverTime: string;
}

/* ============================================================================
 * 订单域
 * ==========================================================================*/

/**
 * 订单状态全集（v1）。
 *
 * 设计要点：**「待支付」和「待接单」必须是两个状态，不能合成一个 paid。**
 * 合掉会同时丢两件事：
 *   ① 超时关单只能作用于"还没付钱"的单 —— 合了就会把已付款的单也关掉；
 *   ② 库存语义不同：待支付 = locked（预占），已支付 = sold。
 *      两者在库存流水里是 `order_hold` 与 `pay_confirm` 两种迁移，混了就查不出货去哪了。
 *
 * 为什么没有 `completed`：D15 定了「商户标记已送达即完成，不做学生确认收货」。
 * 多一个与 delivered 语义重叠的状态只会让每个查询都要多写一次 `IN (...)`。
 */
export type OrderStatus =
  | 'pending_pay'      // 待支付：库存处于 locked（预占）；超时自动关闭并释放
  | 'pending_accept'   // 待接单：已付款、预占已转 sold，等商户接单
  | 'delivering'       // 配送中：商户已接单
  | 'delivered'        // 已送达 —— **v1 终态**（D15）
  | 'cancelled'        // 已取消（终态）：超时关单 / 商户拒单
  | 'refunding'        // 退款中：已发起、未到账
  | 'refunded';        // 已退款（终态）

export type PayStatus = 'unpaid' | 'paid' | 'refunded';

/** 终态 —— 到达后不再接受任何流转。`isTerminal()` 是唯一的判据出处。 */
export const TERMINAL_ORDER_STATUS = ['delivered', 'cancelled', 'refunded'] as const;

/**
 * 时间常量（唯一出处，禁止在别处硬编码）。
 *
 * ⚠️ 需求原文写的是「送达后 N 小时自动完成兜底」。工程上真正会卡死的是
 * **`delivering` 忘了点送达** —— 订单永远挂在"配送中"，学生天天来问，
 * 日报表也算不平。所以兜底作用在 `delivering` 上（超时自动置为已送达），
 * 并打 `autoCompleted` 标记以便和商户手动标记区分。已送达本身就是终态，无需再兜底。
 */
export const ORDER_TIMEOUT = {
  /** 待支付保留时长（分钟）：到点关单 + 释放预占 */
  PAY_TIMEOUT_MINUTES: 30,
  /** 配送中超过该小时数仍未标记送达 → 兜底自动置为已送达 */
  AUTO_COMPLETE_HOURS: 12,
} as const;

/** 待支付 / 已支付 / 已退款三态之外，还有"支付回调先到、订单状态还没落库"的窗口 —— 由 payTxnId 兜住 */

export interface OrderItemRecord {
  id: number;
  orderId: number;
  productId: number;
  /** 下单时的商品名快照 —— 商品改名不得改变历史订单的显示 */
  nameSnap: string;
  /** 下单时的单价快照（分）—— 改价不得改变历史订单的金额 */
  priceSnap: number;
  qty: number;
  amountCents: number;
}

export interface OrderRecord {
  id: number;
  /** 含租户短的订单号；排查时一眼定位租户 */
  orderNo: string;
  userId: number;
  /** 订单只属于一栋 —— 一个订单不可能跨楼栋（§4.5） */
  buildingId: number;
  floor: string | null;
  /** ⚠️ 房间号只存在于租户库。平台库 / 日志 / 报表 / 平台运营后台一律不得出现（铁律 6 · AC-13） */
  room: string;
  contact: string | null;
  phone: string | null;
  /** 商品小计 */
  amountCents: number;
  deliveryFeeCents: number;
  /** 实付 = 小计 + 配送费（服务端算，**绝不信客户端传来的金额**） */
  totalCents: number;
  /** 2% 交易服务费（我方收入；平台库另有汇总投影） */
  feeCents: number;
  remark: string | null;
  status: OrderStatus;
  payStatus: PayStatus;
  /** 支付平台流水号 —— 回调幂等的第二把锁（第一把是 orderNo + 当前状态） */
  payTxnId: string | null;
  paidAt: string | null;
  acceptedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  /** 客户端幂等键（防连点重复下单）：同 key 重复提交返回**同一单**，不新建 */
  clientKey: string | null;
  /** 是否由兜底任务自动置为已送达（与商户手动标记区分，便于追责） */
  autoCompleted: boolean;
  createdAt: string;
  updatedAt: string;
  items: OrderItemRecord[];
}

/** 下单入参（服务端只认这个，价格/金额一律自己算） */
export interface PlaceOrderInput {
  userId: number;
  buildingId: number;
  addressId: number | null;
  /** 客户端的幂等键；不给则退化为"每次请求都是一单" */
  clientKey: string | null;
  /** 只传 productId + qty；**不传价格** */
  lines: Array<{ productId: number; qty: number }>;
  remark: string | null;
}

/* -------------------------------------------------------------- 商户配送清单 */

/**
 * 配送清单的一行 —— 商户的**唯一主视图**（§4.13.3）。
 * 按时间排序的列表对"一趟送完整栋楼"毫无帮助，必须按空间序给出。
 * 含 `room`：这是接单商户的正当可见范围（§4.13.4 第 4 条）。
 */
export interface DeliveryListItem {
  orderNo: string;
  buildingId: number;
  buildingName: string;
  floor: string | null;
  /** 仅商户端返回；学生端任何接口都不回显他人房号 */
  room: string;
  itemSummary: string;
  itemCount: number;
  totalCents: number;
  status: OrderStatus;
  /** 与订单详情同源的展示三件套 —— 配送行里也要显示"待接单/配送中"，前端不自己映射（AC-11） */
  tone: 'ok' | 'warn' | 'danger' | 'off';
  statusText: string;
  paidAt: string | null;
  acceptedAt: string | null;
  remark: string | null;
  /** 备注不为空的行要显眼 —— 商户在楼道里扫一眼就得看见"放门口"这类要求 */
  hasRemark: boolean;
}

export interface DeliveryGroup {
  buildingId: number;
  buildingCode: string;
  buildingName: string;
  /** 待送 = pending_accept + delivering */
  pendingCount: number;
  items: DeliveryListItem[];
}

/* -------------------------------------------------------------- 用户与地址 */

export interface UserRecord {
  id: number;
  openid: string;
  unionid: string | null;
  nickname: string | null;
  avatar: string | null;
  phone: string | null;
  /** 上次选择的楼栋：本地 storage + 服务端双记忆，换设备不丢 */
  lastBuildingId: number | null;
  role: 'student' | 'owner';
  createdAt: string;
}

/**
 * 地址簿一条。
 *
 * ⚠️ 地址簿的「楼栋」**不决定订单楼栋**（订单楼栋来自当前选择），
 * 它的作用是校验：选了 2 栋却用 3 栋的地址 → 拦截（CS-10 跨楼栋）。
 * 这条如果不拦，货会送到学生根本没在的楼，是整个系统里最贵的一类错误。
 */
export interface AddressRecord {
  id: number;
  userId: number;
  buildingId: number;
  /** 可填可不填；不填则按房间号自然序排进配送动线 */
  floor: string | null;
  room: string;
  contact: string | null;
  phone: string | null;
  /** 「我自己」「帮李同学带」 */
  tag: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 学生端订单卡片（**不含** room 之外的个人信息，且金额全部为服务端算好的值） */
export interface StudentOrderView {
  orderNo: string;
  /** 「再来一单」要按这栋补货；缺了它前端就只能拿楼栋名去反查，楼栋改名即失效 */
  buildingId: number;
  buildingName: string;
  status: OrderStatus;
  /** 状态对应的语义色 —— 由服务端给（AC-11），前端不得自行选色 */
  tone: 'ok' | 'warn' | 'danger' | 'off';
  statusText: string;
  /** 中性人话；禁用词表之外的措辞（D5） */
  hint: string;
  totalCents: number;
  itemCount: number;
  /** productId 用于「再来一单」按当前货架补货；name/amountCents 是历史快照，不可被改名改价影响 */
  items: Array<{ productId: number; name: string; qty: number; amountCents: number }>;
  createdAt: string;
  /** 待支付单剩余秒数（前端只做倒计时显示，**判定仍在服务端**，AC-14） */
  payExpiresInSeconds: number | null;
  /**
   * 此刻学生可做的动作 —— **由服务端状态机给出**。
   *
   * 为什么列表也要带它：如果前端自己写 `status === 'pending_pay' ? 可支付 : 不可`，
   * 那就等于把状态机抄了第二遍。将来状态机新增一条边（比如"已送达也可申请售后"），
   * 只会改服务端，列表按钮就永远不同步了 —— 而且这种不同步不会报错，只会"按钮少了"。
   */
  actions: Array<'pay' | 'cancel'>;
}

/**
 * 商户端订单视图（M-02 / M-09）。
 *
 * 与学生端刻意分成两个视图，而不是共用一个 `OrderView` 再按角色裁剪字段：
 *   ① **房间号只在商户端出现**（AC-13）。共用一个类型就等于把"这里有没有 room"
 *      变成一个运行时问题，而漏一次就是隐私事故；
 *   ② 商户需要 `feeCents`（服务费）与 `merchantActions`，学生不需要 —— 反过来也一样
 *      （学生要 `payExpiresInSeconds`）。两份视图各自只说各自的话。
 *
 * `actions` 由状态机给出，理由与学生端那一份完全相同：前端不许猜按钮可用性。
 */
export interface MerchantOrderView {
  orderNo: string;
  buildingId: number;
  buildingName: string;
  floor: string | null;
  /** 接单商户的正当可见范围（§4.13.4 第 4 条）；平台侧任何接口都不回显 */
  room: string;
  contact: string | null;
  phone: string | null;
  status: OrderStatus;
  tone: 'ok' | 'warn' | 'danger' | 'off';
  statusText: string;
  /** 下一步该做什么 —— 商户侧的中性提示（禁用词表之外） */
  hint: string;
  amountCents: number;
  deliveryFeeCents: number;
  totalCents: number;
  /** 本单产生的 2% 服务费：退款时它要一并返还，所以商户必须看得见 */
  feeCents: number;
  itemCount: number;
  items: Array<{ productId: number; name: string; qty: number; priceCents: number; amountCents: number }>;
  remark: string | null;
  createdAt: string;
  paidAt: string | null;
  acceptedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  payStatus: PayStatus;
  /**
   * 支付流水号。商户侧要看得见它 —— 对账时"这笔钱对应哪一单"只能靠它，
   * 而学生端不需要（给他看流水号只会增加困惑）。
   */
  payTxnId: string | null;
  /** 被兜底任务自动置为已送达 —— 与商户手动标记区分，便于追责 */
  autoCompleted: boolean;
  /**
   * 此刻商户可做的动作（服务端状态机给出）。
   *
   * ⚠️ 这里**没有 `reject`**：状态机里不存在"拒单"这条边 —— 钱已收就必须原路退回，
   * 所以拒单在实现上就是 `refund_start`。多造一个语义重叠的动作，
   * 只会让"拒单"和"退款"在界面上变成两个按钮，而它们其实是一件事。
   */
  actions: Array<'accept' | 'deliver' | 'refund_start' | 'refund_done' | 'refund_reject'>;
  /** 只列真实发生过的时间点，含"预计"的东西一个都不写 */
  timeline: Array<{ label: string; at: string }>;
}

/* ============================================================================
 * 站内消息 / 订阅消息授权（CS-13）
 * ==========================================================================*/

export type NoticeType =
  | 'paid'
  | 'accepted'
  | 'delivered'
  | 'closed'
  | 'refund_done'
  | 'refund_rejected';

/**
 * 站内消息。
 *
 * 存在的理由不是"多一个功能"，而是**订阅消息的兜底**：
 * 微信订阅消息有三条限制绕不过去 ——
 *   ① 一次授权只能发一条；
 *   ② 学生可以勾选「总是保持以上选择，不再询问」后永久拒收；
 *   ③ 没认证的小程序根本没有模板。
 * 这三条加起来意味着：**任何把"订单进展"只押在订阅消息上的设计，都有人收不到**。
 * 所以状态变更同时写站内消息，推送只是"锦上添花"，不是唯一通道。
 */
export interface NoticeRecord {
  id: number;
  userId: number;
  type: NoticeType;
  title: string;
  body: string;
  orderNo: string | null;
  createdAt: string;
  readAt: string | null;
}

/**
 * 学生对某个微信订阅消息模板的一次授权结果。
 *
 * `result` 原样保存微信返回的原始值（accept / reject / ban / filter）：
 * 不要压缩成布尔 false —— "这次拒绝了"和"勾选了不再询问"是两种完全不同的处境，
 * 前者下次还能再弹，后者再弹就是打扰。
 *
 * 命名为什么不叫 SubscriptionRecord：那个名字已经被**店家的 SaaS 订阅**占用了，
 * 两个概念在代码里同名，迟早会有人写错 —— 这是"推送授权"（一次性），不是"订阅"（周期性）。
 */
export interface PushGrantRecord {
  id: number;
  userId: number;
  tmplId: string;
  result: string;
  /** 关联到哪一单（订阅消息是**按次**授权的，脱离订单就没有可发的时机） */
  orderNo: string | null;
  /** 已用于那次发送的时间。一次性授权 = 用完必须作废，否则会重复打扰 */
  consumedAt: string | null;
  createdAt: string;
}
