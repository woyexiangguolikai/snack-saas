import { request } from './request';

/* ============================================================================
 * 学生端 API 层（唯一出口）
 * ----------------------------------------------------------------------------
 * 三条纪律，都是为了"不要出现第二个真相源"：
 *
 * ① **类型照抄服务端出参**，前端不重新定义业务字段。
 *    尤其是 `tone` / `statusText` / `hint` —— 状态的颜色与文案都由服务端给（AC-11、D5）。
 *    前端自己写一份 status→颜色 的映射，就等于把状态机抄了第二遍，
 *    将来新增一个状态时必然只改一边。
 *
 * ② **金额只进不出**：这一层拿到的都是"分"，前端不做任何加减。
 *    购物车小计是唯一的例外（明细求和用于展示），它不参与下单 ——
 *    下单金额以服务端算的 `order.totalCents` 为准。
 *
 * ③ **判定不进前端**：能不能下单、能不能取消，问 `gate` 与 `order.actions`。
 *    前端不许用 `new Date()` 自己算"现在能不能下单"（AC-14）。
 * ==========================================================================*/

/* ------------------------------------------------------------------ 店铺 */

export interface Category {
  id: number;
  name: string;
  sort: number;
}

/** 商品在某栋的可售视图 —— `visibility` 是服务端算的，前端不得自行判断售罄 */
export interface StorefrontItem {
  productId: number;
  name: string;
  spec: string | null;
  cover: string | null;
  priceCents: number;
  categoryId: number | null;
  visibility: 'available' | 'sold_out';
  /** 可加购上限 = 当前可售（预占已从 stock 扣走） */
  availableQty: number;
}

export interface OrderGate {
  orderable: boolean;
  /** 取值与服务端 OrderGateState 一一对应，**不要在这里加"前端自己的状态"** */
  state:
    | 'orderable'
    | 'closing_soon'         // 即将截单（剩余 < 30 分钟）→ 琥珀
    | 'closed'               // 已截单 → 灰（AC-02：绝不用红）
    | 'resting'              // 店铺休息中 = "还没开始"
    | 'building_paused'      // 本栋停用 / 今日停送 = "今天不做"
    | 'subscription_expired'
    | 'balance_blocked';
  tone: 'ok' | 'warn' | 'off' | 'danger';
  message: string;
  /**
   * 短标题与恢复时间由服务端拆开下发（AC-02 / §6.4）。
   *
   * 为什么不让前端从 message 里截：三种"今天做不了"必须**共用同一张模板**，
   * 差别只在标题与恢复时间。如果只有一整句话，前端就只能拿它当标题，
   * 于是恢复时间被埋进句子、三张牌长得各不相同 —— 一致性当场失效。
   */
  title: string;
  recovery: string | null;
  nextOpenAt: string | null;
  minutesToCutoff: number | null;
}

export const api = {
  categories(): Promise<{ items: Category[] }> {
    return request('/catalog/categories');
  },

  /** 该栋商品列表：hidden 由服务端过滤，前端拿到的一定是可展示的 */
  storefront(buildingId: number, opts: { categoryId?: number; keyword?: string } = {}) {
    const q: string[] = [`buildingId=${buildingId}`];
    if (opts.categoryId) q.push(`categoryId=${opts.categoryId}`);
    if (opts.keyword) q.push(`keyword=${encodeURIComponent(opts.keyword)}`);
    return request<{ items: StorefrontItem[] }>(`/catalog/storefront?${q.join('&')}`);
  },

  /** 此刻能不能下单（**服务端判定**，AC-14） */
  gate(buildingId: number): Promise<OrderGate> {
    return request(`/config/gate?buildingId=${buildingId}`);
  },

  /* ---------------------------------------------------------------- 订单 */

  placeOrder(body: {
    buildingId: number;
    addressId: number;
    items: Array<{ productId: number; qty: number }>;
    remark?: string | null;
    /** 幂等键：同一次"提交"重试必须是同一个 key，否则会下出两单 */
    clientKey: string;
  }): Promise<{ order: StudentOrder; duplicated: boolean }> {
    return request('/orders', { method: 'POST', data: body });
  },

  /**
   * 我的订单。分区定义与计数都在服务端 —— 前端不按 status 自己分组。
   */
  orders(status: 'ongoing' | 'done' | 'all' = 'all'): Promise<{
    items: StudentOrder[];
    counts: { ongoing: number; done: number; all: number };
  }> {
    return request(`/orders?status=${status}`);
  },

  orderDetail(orderNo: string): Promise<
    StudentOrder & {
      room: string;
      remark: string | null;
      /** 真实发生过的节点（**不含"预计"**——猜出来的时间会被当成承诺） */
      timeline: Array<{ label: string; at: string }>;
      merchantActions: StudentAction[];
    }
  > {
    return request(`/orders/${orderNo}`);
  },

  cancelOrder(orderNo: string, reason?: string) {
    return request<{ order: unknown }>(`/orders/${orderNo}/cancel`, { method: 'POST', data: { reason } });
  },

  /* ------------------------------------------- 站内消息（推送的兜底通道） */

  /** 列表与未读数一次拿全 —— 分两次请求会让红点比列表晚一拍 */
  notices(limit = 50): Promise<{ items: Notice[]; unread: number }> {
    return request(`/notices?limit=${limit}`);
  },

  unreadCount(): Promise<{ unread: number }> {
    return request('/notices/unread');
  },

  /** 返回**本次真正标为已读的行数**：重复标记是 0，前端据此精确扣减红点 */
  markRead(ids?: number[]): Promise<{ marked: number }> {
    return request('/notices/read', { method: 'PATCH', data: ids ? { ids } : {} });
  },

  /**
   * 上报 wx.requestSubscribeMessage 的授权结果。
   * 上报失败**静默吞掉** —— 这只是增强通道，不能因为它让学生觉得下单出问题了。
   */
  reportSubscriptions(orderNo: string | null, grants: Array<{ tmplId: string; result: string }>) {
    return request<{ recorded: number }>('/subscriptions', {
      method: 'POST', data: { orderNo, grants }, tolerate: true,
    });
  },

  /**
   * 发起支付。**未配置商户号时也是 200**（configured:false）——
   * 那是正常的中间状态，不是错误，前端要显示"订单已保留"而不是错误页。
   */
  payInfo(orderNo: string): Promise<{
    configured: boolean;
    orderNo: string;
    totalCents: number;
    payExpiresInSeconds: number | null;
    hint: string;
    payParams: Record<string, string> | null;
    /** 是否开放模拟支付 —— **由服务端决定**，前端不自己判断环境 */
    devSimulateAvailable: boolean;
  }> {
    return request(`/orders/${orderNo}/pay`, { method: 'POST' });
  },

  /** 开发用：模拟支付成功（服务端默认在生产关闭）。返回 { order, idempotent } */
  simulatePay(orderNo: string): Promise<{ order: unknown; idempotent: boolean }> {
    return request(`/orders/${orderNo}/pay/simulate`, { method: 'POST' });
  },

  /* ---------------------------------------------------------------- 地址 */

  addresses(): Promise<{ items: Address[] }> {
    return request('/addresses');
  },

  createAddress(body: AddressInput): Promise<{ address: Address }> {
    return request('/addresses', { method: 'POST', data: body });
  },

  updateAddress(id: number, body: Partial<AddressInput>): Promise<{ address: Address }> {
    return request(`/addresses/${id}`, { method: 'PATCH', data: body });
  },

  deleteAddress(id: number): Promise<{ deleted: number }> {
    return request(`/addresses/${id}`, { method: 'DELETE' });
  },
};

/* ------------------------------------------------------------------ 类型 */

/**
 * 学生端动作全集。
 * `pay` / `cancel` 是学生能做的；其余是商户侧动作（详情接口会带上，仅用于排查）。
 * 按钮显示什么**完全由服务端 actions 决定** —— 前端不自己按 status 推。
 */
export type StudentAction =
  | 'pay'
  | 'cancel'
  | 'accept'
  | 'deliver'
  | 'refund_start'
  | 'refund_done'
  | 'refund_reject';

export interface StudentOrder {
  orderNo: string;
  /** 「再来一单」要按这栋补货；只拿楼栋名反查的话，楼栋改名就会失效 */
  buildingId: number;
  buildingName: string;
  status: 'pending_pay' | 'pending_accept' | 'delivering' | 'delivered' | 'cancelled' | 'refunding' | 'refunded';
  tone: 'ok' | 'warn' | 'danger' | 'off';
  statusText: string;
  hint: string;
  totalCents: number;
  itemCount: number;
  items: Array<{ productId: number; name: string; qty: number; amountCents: number }>;
  createdAt: string;
  /** 待支付剩余秒数（服务端基准值，本地只做衰减） */
  payExpiresInSeconds: number | null;
  /** 此刻可做的动作 —— 服务端状态机的输出 */
  actions: StudentAction[];
}

export interface Address {
  id: number;
  userId: number;
  buildingId: number;
  floor: string | null;
  room: string;
  contact: string | null;
  phone: string | null;
  tag: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * 站内消息。**只有 types 由服务端给** —— 前端据此选图标与字体色，
 * 不在这里再定义一次"哪种消息该是什么色"，那会让两套配色各自漂移。
 */
export interface Notice {
  id: number;
  type: 'paid' | 'accepted' | 'delivered' | 'closed' | 'refund_done' | 'refund_rejected';
  title: string;
  body: string;
  /** 附带订单号：点消息要能跳到那一单 */
  orderNo: string | null;
  createdAt: string;
  /** null = 未读 */
  readAt: string | null;
}

export interface AddressInput {
  buildingId: number;
  floor?: string | null;
  room: string;
  contact?: string | null;
  phone?: string | null;
  tag?: string | null;
  isDefault?: boolean;
}

/**
 * 幂等键生成：`时间戳-随机`。
 * 为什么不用订单号：订单号由服务端生成，而下单**之前**就需要这个 key。
 * 为什么不用自增计数：小程序冷启动会丢内存，计数归零后可能与历史 key 撞车。
 */
export function newClientKey(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
