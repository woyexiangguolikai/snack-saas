import { requestMerchant } from './request';

/* ============================================================================
 * 商户端 API 层（唯一出口）
 * ----------------------------------------------------------------------------
 * 与学生端 `utils/api.ts` 分成两个文件，不是因为"端不同"，
 * 而是因为**两端看到的同一件东西根本不是一回事**：
 *   · 订单：学生看"到哪了"，商户看"该我做什么"（还带房间号，要送货）；
 *   · 商品：学生看"能不能买"，商户看"各栋还剩多少"。
 * 硬凑一个 api.ts，就会为了兼容两边给字段加一堆 `?`，然后每个调用点都要判空。
 *
 * 纪律与学生端那份完全相同：
 *   ① 类型照抄服务端出参，前端不重新定义业务字段；
 *   ② 金额只进不出（单位：分）；
 *   ③ 判定不进前端 —— 按钮可用性一律读服务端给的 `actions`。
 * ==========================================================================*/

export interface MerchantDeliveryItem {
  orderNo: string;
  buildingId: number;
  buildingName: string;
  floor: string | null;
  room: string;
  itemSummary: string;
  itemCount: number;
  totalCents: number;
  status: string;
  tone: 'ok' | 'warn' | 'danger' | 'off';
  statusText: string;
  paidAt: string | null;
  acceptedAt: string | null;
  remark: string | null;
  hasRemark: boolean;
}

export interface MerchantDeliveryGroup {
  buildingId: number;
  buildingCode: string;
  buildingName: string;
  pendingCount: number;
  items: MerchantDeliveryItem[];
}

export interface MerchantOrderView {
  orderNo: string;
  buildingId: number;
  buildingName: string;
  floor: string | null;
  room: string;
  contact: string | null;
  phone: string | null;
  status: string;
  tone: 'ok' | 'warn' | 'danger' | 'off';
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

export interface MerchantProduct {
  id: number;
  name: string;
  cover: string | null;
  spec: string | null;
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
  status: 'on' | 'off';
  stock: number;
  locked: number;
  sold: number;
  warnStock: number | null;
  visibility: 'hidden' | 'sold_out' | 'available';
  /** 底色即状态 —— 颜色由服务端给，前端不选色（AC-11） */
  tone: 'ok' | 'warn' | 'danger' | 'off';
  /** 文字角标，与底色同时出现（色盲可读） */
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

/** 楼栋后台行：原始记录 + 解析后的有效配置（含每个字段是"继承店铺"还是"本栋覆盖"） */
export interface MerchantBuilding {
  id: number;
  code: string;
  name: string;
  status: 'active' | 'disabled';
  sort: number;
  resolved: {
    buildingId: number;
    buildingCode: string;
    buildingName: string;
    status: 'active' | 'disabled';
    isDefault: boolean;
    /** 今日停送：可逆，库存保留 */
    deliveryEnabled: boolean;
    minAmountCents: number;
    deliveryFeeCents: number;
    accessibleFrom: string;
    accessibleTo: string;
    cutoffTime: string;
    notice: string | null;
    source: Record<string, 'building' | 'shop'>;
  };
}

/** 账单首页 —— 字段照抄 `LedgerService.billingView`，含服务端算好的 tone 与中性文案 */
export interface BillingView {
  wallet: {
    balanceCents: number;
    warnLineCents: number;
    creditLimitCents: number;
    /** 余额语义色 —— 由服务端给（AC-11），前端不自己分档 */
    tone: 'ok' | 'warn' | 'danger';
    /** 标题/正文与 tone 配套下发：预警说"建议充值"，触底说"充值后立即恢复接单"（§5.4-7） */
    noticeTitle: string;
    noticeBody: string;
    walletName: string;
  };
  subscription: {
    periodStart: string | null;
    periodEnd: string | null;
    status: string;
    daysLeft: number | null;
    /** 中性标题：正常是「服务期还有 N 天」，到期是「本学期服务期已结束」（§5.4-8） */
    noticeTitle: string;
    /** 到期中性文案（禁用词表之外） */
    notice: string;
    subscriptionName: string;
  } | null;
  /** 待结算（已支付但还没扣服务费的订单）—— 每笔都能回链到订单号 */
  pending: {
    items: Array<{ orderNo: string; amountCents: number; feeCents: number; paidAt: string | null; buildingCode: string | null }>;
    totalFeeCents: number;
    orderCount: number;
  };
  txns: Array<{
    id: number;
    type: 'topup' | 'fee' | 'refund' | 'adjust';
    /** 有符号：充值为正、扣费为负 */
    amountCents: number;
    balanceAfterCents: number;
    refOrderNo: string | null;
    source: string;
    remark: string | null;
    createdAt: string;
  }>;
  /** 每日汇总批次 */
  runs: Array<{
    id: number;
    runDate: string;
    orderCount: number;
    gmvCents: number;
    feeCents: number;
    status: 'pending' | 'done' | 'failed';
  }>;
}

export const mapi = {
  /* ------------------------------------------------------------ 配送清单 */

  delivery(includeDelivered = false): Promise<{
    groups: MerchantDeliveryGroup[];
    totalPending: number;
    /** 今日配送日报：与 groups 同源同刻返回，用于"送完了"这个好消息型空态 */
    today: { day: string; deliveredCount: number; deliveredCents: number };
  }> {
    return requestMerchant(`/merchant/orders/delivery${includeDelivered ? '?includeDelivered=true' : ''}`);
  },

  orderDetail(orderNo: string): Promise<{ order: MerchantOrderView }> {
    return requestMerchant(`/merchant/orders/${orderNo}`);
  },

  accept(orderNo: string): Promise<{ order: MerchantOrderView }> {
    return requestMerchant(`/merchant/orders/${orderNo}/accept`, { method: 'POST' });
  },

  deliver(orderNo: string): Promise<{ order: MerchantOrderView }> {
    return requestMerchant(`/merchant/orders/${orderNo}/deliver`, { method: 'POST' });
  },

  /** 批量送达：逐单独立成败，一单非法不会让整批回滚（服务端保证） */
  deliverBatch(orderNos: string[]): Promise<{ done: string[]; failed: Array<{ orderNo: string; reason: string }> }> {
    return requestMerchant('/merchant/orders/deliver-batch', { method: 'POST', data: { orderNos } });
  },

  refundStart(orderNo: string): Promise<{ order: MerchantOrderView }> {
    return requestMerchant(`/merchant/orders/${orderNo}/refund/start`, { method: 'POST' });
  },

  refundDone(orderNo: string, refundCents: number): Promise<unknown> {
    return requestMerchant(`/merchant/orders/${orderNo}/refund/done`, { method: 'POST', data: { refundCents } });
  },

  refundReject(orderNo: string): Promise<{ order: MerchantOrderView }> {
    return requestMerchant(`/merchant/orders/${orderNo}/refund/reject`, { method: 'POST' });
  },

  /* --------------------------------------------------------------- 商品 */

  products(includeOff = true): Promise<{ items: MerchantProduct[] }> {
    return requestMerchant(`/catalog/products${includeOff ? '?includeOff=1' : ''}`);
  },

  setProductStatus(productId: number, status: 'active' | 'off'): Promise<{ product: MerchantProduct }> {
    return requestMerchant(`/catalog/products/${productId}/status`, { method: 'POST', data: { status } });
  },

  /* --------------------------------------------------------------- 库存 */

  matrix(includeOff = false): Promise<{ rows: MatrixRow[] }> {
    return requestMerchant(`/catalog/matrix${includeOff ? '?includeOff=1' : ''}`);
  },

  /** 手机端快改：点格直接改，理由由服务端固定（流水中留痕） */
  quickSet(productId: number, buildingId: number, stock: number): Promise<{ cell: MatrixCell }> {
    return requestMerchant('/catalog/stocks/quick-set', {
      method: 'POST',
      data: { productId, buildingId, stock },
    });
  },

  /* --------------------------------------------------------------- 楼栋 */

  buildings(): Promise<{ buildings: MerchantBuilding[]; singleBuildingMode: boolean }> {
    return requestMerchant('/buildings');
  },

  /** 停送 / 恢复：deliveryEnabled 是可逆的轻操作；停用不可逆，走 disable */
  updateBuilding(
    id: number,
    patch: Partial<{ name: string; deliveryEnabled: boolean; minAmountCents: number; deliveryFeeCents: number; notice: string | null }>,
  ): Promise<unknown> {
    return requestMerchant(`/buildings/${id}`, { method: 'PATCH', data: patch });
  },

  disableBuilding(id: number): Promise<unknown> {
    return requestMerchant(`/buildings/${id}/disable`, { method: 'POST' });
  },

  createBuilding(name: string): Promise<unknown> {
    return requestMerchant('/buildings', { method: 'POST', data: { name } });
  },

  /* ---------------------------------------------------------- 店铺配置 */

  config(): Promise<{
    shop: {
      shopName: string; logoUrl: string | null; announcement: string | null; contactPhone: string | null;
      shopOpen: boolean; openTime: string | null; closeTime: string | null;
      accessibleFrom: string | null; accessibleTo: string | null; cutoffLeadMinutes: number;
      minAmountCents: number; deliveryFeeCents: number;
      /** 主题色被护栏加深过时的说明 —— 不回显它，商户会以为"我选的色没生效" */
      themeNotice: string | null;
    };
    singleBuildingMode: boolean;
  }> {
    return requestMerchant('/config');
  },

  saveConfig(patch: Record<string, unknown>): Promise<{ saved: Record<string, unknown>; cutoffTime: string }> {
    return requestMerchant('/config', { method: 'POST', data: patch });
  },

  /* --------------------------------------------------------------- 账本 */

  billing(txnLimit = 50): Promise<BillingView> {
    return requestMerchant(`/billing?txnLimit=${txnLimit}`);
  },

  billingTxns(type?: string, limit = 100): Promise<{ items: BillingView['txns'] }> {
    const q = new URLSearchParams();
    q.set('limit', String(limit));
    if (type) q.set('type', type);
    return requestMerchant(`/billing/txns?${q.toString()}`);
  },

  /* --------------------------------------------------- 网页后台登录码 */

  /**
   * 生成网页后台登录码（6 位 · 5 分钟 · 一次性）。
   *
   * 这是网页后台唯一的登录入口，也是**这条链路的最后一环**：
   * 店主在这里证明"我是店主"（微信身份已验证过），网页端拿码换令牌。
   * 在账号体系到位之前，它比"网页端另设一个密码"更强 —— 不新增一处可被撞的凭据。
   */
  webLoginCode(): Promise<{ code: string; expiresAt: string; ttlSeconds: number }> {
    return requestMerchant('/merchant/session/web-login-code', { method: 'POST' });
  },
};
