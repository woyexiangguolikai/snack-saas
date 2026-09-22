/**
 * 网页后台用到的出参类型。
 *
 * 刻意**不**直接 import 服务端的 core/types：那是服务端的内部契约，
 * 网页端只声明自己真正消费的字段。好处是服务端加字段不会让网页端产生
 * "类型没同步"的假警报；代价是两边可能漂移 —— 由冒烟测试兜住（真实的 HTTP 往返）。
 */

export type Tone = 'ok' | 'warn' | 'danger' | 'off' | 'info';
export type OrderStatus =
  | 'pending_pay'
  | 'pending_accept'
  | 'delivering'
  | 'delivered'
  | 'cancelled'
  | 'refunding'
  | 'refunded';

/* ------------------------------------------------------------------ 会话 */

export interface OwnerSession {
  tenantCode: string;
  shopName: string;
  token: string;
  expiresAt: string;
  role: 'owner';
}

/* ------------------------------------------------------------------ 配置 */

export interface ShopConfig {
  shopName: string;
  announcement: string | null;
  contactPhone: string | null;
  shopOpen: boolean;
  openTime: string | null;
  closeTime: string | null;
  minAmountCents: number;
  deliveryFeeCents: number;
  accessibleFrom: string | null;
  accessibleTo: string | null;
  cutoffLeadMinutes: number;
  themeNotice: string | null;
}

export interface ResolvedBuilding {
  buildingId: number;
  buildingCode: string;
  buildingName: string;
  status: string;
  deliveryEnabled: boolean;
  minAmountCents: number;
  deliveryFeeCents: number;
  accessibleFrom: string | null;
  accessibleTo: string | null;
  cutoffTime: string;
  notice: string | null;
  source: string;
}

export interface ConfigView {
  tenantCode: string;
  shop: ShopConfig;
  buildings: ResolvedBuilding[];
  singleBuildingMode: boolean;
  gates: {
    subscriptionValid: boolean;
    subscriptionEndsAt: string | null;
    balanceOk: boolean;
    balanceCents: number;
  };
  serverTime: string;
}

export interface TimeWindowPreview {
  accessibleFrom: string;
  accessibleTo: string;
  leadMinutes: number;
  cutoffTime: string;
  layers: {
    gate: { from: string; to: string };
    business: { from: string; to: string };
    orderable: { from: string; to: string };
  };
  businessHoursNarrowed: boolean;
  narrowedNotice: string | null;
  currentGate: { allowed: boolean; reason?: string | null; message?: string | null };
}

/* ------------------------------------------------------------------ 商品 */

export interface Category {
  id: number;
  name: string;
  sort: number;
}

export interface Product {
  id: number;
  name: string;
  spec: string | null;
  cover: string | null;
  priceCents: number;
  categoryId: number | null;
  status: 'active' | 'off';
  sort: number;
}

export interface MatrixCell {
  buildingId: number;
  buildingCode: string;
  buildingName: string;
  exists: boolean;
  status: string;
  stock: number;
  locked: number;
  sold: number;
  warnStock: number | null;
  visibility: string;
  /** 双重编码之一：底色由服务端给（AC-11），前端不自己选色 */
  tone: Tone;
  /** 双重编码之二：文字角标，色盲可读 */
  badge: string;
}

export interface MatrixRow {
  productId: number;
  name: string;
  spec: string | null;
  priceCents: number;
  categoryId: number | null;
  status: string;
  sort: number;
  cells: MatrixCell[];
  totalStock: number;
}

export interface MatrixView {
  buildings: Array<{ id: number; code: string; name: string; status: string }>;
  rows: MatrixRow[];
}

export interface StockLog {
  id: number;
  productId: number;
  buildingId: number;
  type: string;
  change: number;
  stockAfter: number;
  refOrderNo: string | null;
  operator: string | null;
  remark: string | null;
  createdAt: string;
}

export interface ReconcileView {
  rows: Array<{
    productId: number;
    buildingId: number;
    expected: number;
    actual: number;
    diff: number;
  }>;
  diffTotal: number;
}

/* ------------------------------------------------------------------ 订单 */

export interface MerchantOrder {
  orderNo: string;
  buildingId: number;
  buildingName: string;
  floor: string | null;
  room: string;
  contact: string | null;
  phone: string | null;
  status: OrderStatus;
  tone: Tone;
  statusText: string;
  hint: string;
  amountCents: number;
  deliveryFeeCents: number;
  totalCents: number;
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
  payStatus: string;
  payTxnId: string | null;
  autoCompleted: boolean;
  actions: Array<'accept' | 'deliver' | 'refund_start' | 'refund_done' | 'refund_reject'>;
  timeline: Array<{ label: string; at: string }>;
}

export interface MerchantOrderList {
  items: MerchantOrder[];
  total: number;
  counts: Record<string, number>;
}

export interface DeliveryItem {
  orderNo: string;
  buildingId: number;
  buildingName: string;
  floor: string | null;
  room: string;
  itemSummary: string;
  itemCount: number;
  totalCents: number;
  status: OrderStatus;
  tone: Tone;
  statusText: string;
  paidAt: string | null;
  acceptedAt: string | null;
  remark: string | null;
  hasRemark: boolean;
}

export interface DeliveryGroup {
  buildingId: number;
  buildingCode: string;
  buildingName: string;
  pendingCount: number;
  items: DeliveryItem[];
}

/* ------------------------------------------------------------------ 账单 */

export interface WalletTxn {
  id: number;
  type: string;
  amountCents: number;
  balanceAfter: number;
  refOrderNo: string | null;
  remark: string | null;
  createdAt: string;
}

export interface BillingView {
  /** tone / 文案都由服务端给 —— 账本措辞必须中性（禁用词表在服务端），前端不得自行造句 */
  wallet: {
    balanceCents: number;
    warnLineCents: number;
    creditLimitCents: number;
    tone: Tone;
    /** 与 tone 配套下发：预警说"建议充值"，触底说"充值后立即恢复接单"（§5.4-7） */
    noticeTitle: string;
    noticeBody: string;
    walletName: string;
  };
  subscription: {
    periodStart: string | null;
    periodEnd: string | null;
    status: string;
    daysLeft: number | null;
    subscriptionName?: string;
    /** 中性标题：正常是「服务期还有 N 天」，到期是「本学期服务期已结束」（§5.4-8） */
    noticeTitle?: string;
    notice?: string | null;
  } | null;
  txns: WalletTxn[];
  pending: { items: Array<{ orderNo: string; amountCents: number }>; totalCents: number };
  runs: Array<{ id: number; periodStart: string; periodEnd: string; orderCount: number; feeCents: number }>;
}

export interface Statement {
  period: string;
  orderCount: number;
  grossCents: number;
  feeCents: number;
  netCents: number;
}
