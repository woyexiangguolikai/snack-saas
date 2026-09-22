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

export interface MerchantBuilding {
  buildingId: number;
  buildingCode: string;
  buildingName: string;
  status: string;
  deliveryEnabled: boolean;
  minAmountCents: number;
  deliveryFeeCents: number;
  accessibleFrom: string;
  accessibleTo: string;
  cutoffTime: string;
  notice: string | null;
  todayOrderCount?: number;
}

export interface BillingView {
  wallet: { balanceCents: number; warnLineCents: number; creditLimitCents: number };
  subscription: { periodStart: string | null; periodEnd: string | null; status: string; daysLeft: number | null };
  txns: Array<{
    id: number; type: string; amountCents: number; balanceAfter: number;
    refOrderNo: string | null; remark: string | null; createdAt: string;
  }>;
}

export const mapi = {
  /* ------------------------------------------------------------ 配送清单 */

  delivery(includeDelivered = false): Promise<{ groups: MerchantDeliveryGroup[]; totalPending: number }> {
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

  buildings(): Promise<{ items: MerchantBuilding[] }> {
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
};
