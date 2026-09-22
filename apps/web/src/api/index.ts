/**
 * 网页后台的接口层。
 *
 * 租户号在 URL 里（`/t/{tenantCode}/api/...`）而不是在令牌里解析，
 * 所以每个方法都要显式带上它 —— 这和服务端 `tenantOf()` 的作用域断言是同一件事的两端。
 */
import { request, type RequestOptions } from './http';
import type {
  BillingView,
  Category,
  ConfigView,
  DeliveryGroup,
  MatrixView,
  MerchantOrder,
  MerchantOrderList,
  OwnerSession,
  Product,
  ReconcileView,
  ResolvedBuilding,
  Statement,
  StockLog,
  TimeWindowPreview,
} from './types';

/** 当前操作的租户号，由 session 注入。所有 /t/ 路径都从这里取值 */
let tenantCode = '';
export function setTenant(code: string): void {
  tenantCode = code;
}
export function currentTenant(): string {
  return tenantCode;
}

const T = (p: string) => `/t/${tenantCode}/api${p}`;

const get = <T>(p: string, query?: RequestOptions['query']) => request<T>(p, { method: 'GET', query });
const post = <T>(p: string, body?: unknown) => request<T>(p, { method: 'POST', body });
const patch = <T>(p: string, body?: unknown) => request<T>(p, { method: 'PATCH', body });

/* ------------------------------------------------------------------ 登录 */

export const api = {
  /** 用小程序生成的 6 位登录码换店主令牌（码本身即凭据，不需要平台密钥） */
  webLogin(tenantCode: string, code: string): Promise<OwnerSession> {
    return post<OwnerSession>('/api/tenant/merchant/web-login', { tenantCode, code });
  },

  /* ---------------------------------------------------------------- 配置 */

  config(): Promise<ConfigView> {
    return get<ConfigView>(T('/config'));
  },

  saveConfig(body: Record<string, unknown>) {
    return post(T('/config'), body);
  },

  /* ---------------------------------------------------------------- 楼栋 */

  buildings(): Promise<{ items: ResolvedBuilding[] }> {
    return get<{ items: ResolvedBuilding[] }>(T('/buildings'));
  },

  createBuilding(body: { name: string; sort?: number }) {
    return post(T('/buildings'), body);
  },

  updateBuilding(id: number, body: Record<string, unknown>) {
    return patch(T(`/buildings/${id}`), body);
  },

  disableBuilding(id: number) {
    return post(T(`/buildings/${id}/disable`));
  },

  /* -------------------------------------------------------------- 时间窗 */

  timeWindowPreview(query: { accessibleFrom?: string; accessibleTo?: string; leadMinutes?: number }) {
    return get<TimeWindowPreview>(T('/time-window/preview'), {
      accessibleFrom: query.accessibleFrom,
      accessibleTo: query.accessibleTo,
      leadMinutes: query.leadMinutes,
    });
  },

  timeWindowBulk(body: Record<string, unknown>): Promise<{ affected: number }> {
    return post<{ affected: number }>(T('/time-window/bulk'), body);
  },

  /* ---------------------------------------------------------------- 商品 */

  categories(): Promise<{ items: Category[] }> {
    return get<{ items: Category[] }>(T('/catalog/categories'));
  },

  products(includeOff = true): Promise<{ items: Product[] }> {
    return get<{ items: Product[] }>(T('/catalog/products'), { includeOff: includeOff ? '1' : '0' });
  },

  createProduct(body: Record<string, unknown>) {
    return post<{ product: Product }>(T('/catalog/products'), body);
  },

  updateProduct(id: number, body: Record<string, unknown>) {
    return patch<{ product: Product }>(T(`/catalog/products/${id}`), body);
  },

  setProductStatus(id: number, status: 'active' | 'off') {
    return post<{ product: Product }>(T(`/catalog/products/${id}/status`), { status });
  },

  /* ---------------------------------------------------------------- 库存 */

  matrix(includeOff = false): Promise<MatrixView> {
    return get<MatrixView>(T('/catalog/matrix'), { includeOff: includeOff ? '1' : '0' });
  },

  /**
   * 网页端改库存 —— 走 `stocks/adjust`（理由必填）。
   *
   * 与手机端的 `stocks/quick-set` 刻意分成两个接口：网页端一次往往动几十格、
   * 影响面大，月底对账时必须能回答"谁为什么改的"；手机端是高频小幅当场可逆，
   * 每次弹理由只会让它变成没人用的功能。
   */
  adjustStock(body: {
    productId: number;
    buildingId: number;
    stock: number;
    reason: string;
    operator: string;
  }) {
    return post(T('/catalog/stocks/adjust'), body);
  },

  transferStock(body: {
    productId: number;
    fromBuildingId: number;
    toBuildingId: number;
    qty: number;
    operator: string;
  }) {
    return post(T('/catalog/stocks/transfer'), body);
  },

  /** 同步上架 —— 只改上下架，不动库存数值（AC-10：两个"同步"必须分开） */
  syncPublish(body: { productId: number; targetBuildingIds?: number[]; status: 'on' | 'off' }) {
    return post(T('/catalog/sync/publish'), body);
  },

  /** 同步库存 —— 只改数值，不动上下架 */
  syncStock(body: {
    productId: number;
    fromBuildingId: number;
    targetBuildingIds?: number[];
    mode?: 'value' | 'delta';
  }) {
    return post(T('/catalog/sync/stock'), body);
  },

  stockLogs(query: { productId?: number; buildingId?: number; limit?: number }) {
    return get<{ items: StockLog[] }>(T('/catalog/stock-logs'), {
      productId: query.productId,
      buildingId: query.buildingId,
      limit: query.limit,
    });
  },

  stockReconcile(buildingId?: number) {
    return get<ReconcileView>(T('/catalog/stock-reconcile'), { buildingId });
  },

  /* ---------------------------------------------------------------- 订单 */

  orders(query: { status?: string; keyword?: string; limit?: number; offset?: number }) {
    return get<MerchantOrderList>(T('/merchant/orders'), {
      status: query.status,
      keyword: query.keyword,
      limit: query.limit,
      offset: query.offset,
    });
  },

  orderDetail(orderNo: string) {
    return get<{ order: MerchantOrder }>(T(`/merchant/orders/${orderNo}`));
  },

  orderAction(orderNo: string, action: 'accept' | 'deliver' | 'refund/start' | 'refund/reject') {
    return post(T(`/merchant/orders/${orderNo}/${action}`));
  },

  refundDone(orderNo: string, refundCents: number) {
    return post(T(`/merchant/orders/${orderNo}/refund/done`), { refundCents });
  },

  rejectOrder(orderNo: string, reason: string) {
    return post(T(`/merchant/orders/${orderNo}/reject`), { reason });
  },

  delivery(includeDelivered = true) {
    return get<{ groups: DeliveryGroup[]; totalPending: number }>(T('/merchant/orders/delivery'), {
      includeDelivered: includeDelivered ? '1' : '0',
    });
  },

  /* ---------------------------------------------------------------- 账单 */

  billing(txnLimit = 50) {
    return get<BillingView>(T('/billing'), { txnLimit });
  },

  billingTxns(type?: string, limit = 100) {
    return get<{ items: BillingView['txns'] }>(T('/billing/txns'), { type, limit });
  },

  billingRuns() {
    return get<{ items: BillingView['runs'] }>(T('/billing/runs'));
  },

  billingRunDetail(runId: number) {
    return get<{ orders: Array<{ orderNo: string; totalCents: number; feeCents: number; createdAt: string }> }>(
      T(`/billing/runs/${runId}`),
    );
  },

  /** 账期账单列表与单个账期查询分成两个方法 ——
   *  合成一个"有参数返回单条、没参数返回列表"的函数，调用方每次都要做类型收窄 */
  statements(): Promise<{ items: Statement[] }> {
    return get<{ items: Statement[] }>(T('/billing/statements'));
  },

  statementOf(period: string): Promise<{ statement: Statement }> {
    return get<{ statement: Statement }>(T('/billing/statements'), { period });
  },
};
