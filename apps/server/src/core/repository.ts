import type {
  AddressRecord,
  AlertRecord,
  AppVersionRecord,
  AuditRecord,
  BuildingRecord,
  BuildingTemplateRecord,
  CategoryRecord,
  JobKind,
  JobRunRecord,
  OrderItemRecord,
  OrphanPayRecord,
  PushBatchRecord,
  PushTargetRecord,
  SecretKind,
  TenantSecretRecord,
  TenantStatus,
  TicketCategory,
  TicketRecord,
  TicketStatus,
  OrderRecord,
  OrderStatus,
  OrderSummaryRecord,
  PipelineStageRecord,
  ProductRecord,
  ProductStockRecord,
  NoticeRecord,
  NoticeType,
  PushGrantRecord,
  SchoolRecord,
  SettlementRunRecord,
  ShopConfigRecord,
  StatementRecord,
  StockLogRecord,
  StockLogType,
  SubscriptionRecord,
  TenantRecord,
  UserRecord,
  WalletRecord,
  WalletTxnRecord,
} from './types';

// 统一出口：调用方从 './core/repository' 一处即可拿到仓储接口与所需的领域类型
export type {
  AlertKind,
  AlertLevel,
  AlertRecord,
  AppVersionRecord,
  AppVersionStatus,
  AuditRecord,
  JobKind,
  JobRunRecord,
  OrphanPayRecord,
  PaidIntegrityReport,
  PipelineOwner,
  PipelineStageView,
  PlatformReconcileBoard,
  PushBatchRecord,
  PushTargetRecord,
  ReworkItem,
  SecretKind,
  SecretStatus,
  TenantPipelineView,
  TenantReconcileRow,
  TenantSecretRecord,
  TenantStatus,
  TicketCategory,
  TicketRecord,
  TicketStatus,
} from './types';

export type {
  AddressRecord,
  BuildingRecord,
  BuildingTemplateRecord,
  CategoryRecord,
  OrderItemRecord,
  OrderRecord,
  OrderStatus,
  OrderSummaryRecord,
  PipelineStageRecord,
  ProductRecord,
  ProductStockRecord,
  NoticeRecord,
  NoticeType,
  PushGrantRecord,
  SchoolRecord,
  SettlementRunRecord,
  ShopConfigRecord,
  StatementRecord,
  StockLogRecord,
  StockLogType,
  SubscriptionRecord,
  TenantRecord,
  UserRecord,
  WalletRecord,
  WalletTxnRecord,
};

/* ============================================================================
 * 仓储抽象
 * ----------------------------------------------------------------------------
 * 存在的理由不止"换数据库"：本机没有 MySQL / Docker（已验证），
 * 若业务逻辑直接绑 Prisma，本地就只剩下 `tsc` 能跑，等于**没有验证**。
 * 因此把持久化收在这两个接口后面：
 *   · MemoryRepo —— 单元测试 / 本地冒烟 / CI，可真实跑完整 HTTP 链路
 *   · PrismaRepo —— 生产（每租户独立库 + 1 平台库，D3）
 * 业务代码只依赖接口，两套实现必须行为一致。
 * ==========================================================================*/

export interface CreateTenantInput {
  tenantCode: string;
  appid: string | null;
  orgName: string;
  shopName: string;
  schoolId: number | null;
  contactName: string | null;
  contactPhone: string | null;
  region: string | null;
  dbName: string;
  /** 建租户时带出的楼栋模板 → 初始化租户库楼栋（§4.2 开通向导） */
  buildingNames: string[];
  /** 订阅有效期（学期） */
  periodStart: Date;
  periodEnd: Date;
}

export interface PlatformRepo {
  createTenant(input: CreateTenantInput): Promise<TenantRecord>;
  findTenantByCode(tenantCode: string): Promise<TenantRecord | null>;
  /** 租户识别的唯一入口：AppID → 租户（§2.2） */
  findTenantByAppId(appid: string): Promise<TenantRecord | null>;
  listTenants(): Promise<TenantRecord[]>;
  updateTenant(tenantCode: string, patch: Partial<TenantRecord>): Promise<TenantRecord>;
  getSubscription(tenantCode: string): Promise<SubscriptionRecord | null>;
  upsertSubscription(tenantCode: string, patch: Partial<SubscriptionRecord>): Promise<SubscriptionRecord>;
  getWallet(tenantCode: string): Promise<WalletRecord | null>;
  upsertWallet(tenantCode: string, patch: Partial<WalletRecord>): Promise<WalletRecord>;
  listSchools(): Promise<SchoolRecord[]>;
  upsertSchool(school: Omit<SchoolRecord, 'id'> & { id?: number }): Promise<SchoolRecord>;
  listBuildingTemplates(schoolId: number): Promise<BuildingTemplateRecord[]>;
  replaceBuildingTemplates(schoolId: number, names: string[]): Promise<void>;
  createPipeline(tenantCode: string): Promise<PipelineStageRecord[]>;
  listPipeline(tenantCode: string): Promise<PipelineStageRecord[]>;
  appendAudit(entry: { tenantCode?: string | null; actor: string; action: string; target?: string | null; detail?: string | null }): Promise<void>;

  /**
   * 网页端登录码（一次性、5 分钟有效）。
   *
   * 为什么要它：商户网页后台不能用平台密钥登录（那是平台自己的钥匙，给出去等于
   * 把整个平台交出去），也不能靠"输 openid"（谁都能猜别人的 openid）。
   * 登录码把"谁有权登录"这件事交回给**已经登录的店主本人**：
   * 他在小程序里生成一个码，在电脑上敲进去 —— 与微信网页版扫码是同一个思路。
   *
   * 落库而不是放进程内存：多台 API 实例时，进程内存的码在另一台上查不到，
   * 表现为"码明明是对的，电脑端就是登不进去"。
   */
  issueWebLoginCode(tenantCode: string, code: string, ttlSeconds: number): Promise<{ expiresAt: string }>;
  /** 消费成功返回 true；码不存在 / 已过期 / 已用过 返回 false（不区分哪一种，避免枚举） */
  consumeWebLoginCode(tenantCode: string, code: string): Promise<boolean>;

  /* -------------------------------------------------------------- 双账本 */

  /**
   * 支付成功即登记「待扣记录」（幂等：同一 orderNo 重复回调只登记一次）。
   * 不在这里扣费 —— 扣费由每日汇总任务完成，这样才能做到
   * 「一天一条扣费流水 + 可展开到每一笔订单」。
   */
  recordPaidOrder(input: {
    tenantCode: string;
    orderNo: string;
    amountCents: number;
    buildingCode?: string | null;
    paidAt?: Date;
  }): Promise<OrderSummaryRecord>;
  findOrderSummary(tenantCode: string, orderNo: string): Promise<OrderSummaryRecord | null>;
  /** 待扣队列（status='paid'）；before 用于"只结算当日之前"的边界 */
  listPendingOrders(tenantCode: string, before?: Date): Promise<OrderSummaryRecord[]>;
  markOrdersSettled(tenantCode: string, orderNos: string[], runId: number, at: Date): Promise<number>;
  /** 某个结算批次覆盖了哪些订单 —— 「明细可回链订单」的展开跳 */
  listOrdersByRun(tenantCode: string, runId: number): Promise<OrderSummaryRecord[]>;
  /** 退款落账：已结算的记 refunded 并返还服务费；未结算的直接出队 */
  markOrderRefunded(tenantCode: string, orderNo: string, refundCents: number, at: Date): Promise<OrderSummaryRecord>;
  listOrderSummaries(tenantCode: string, limit?: number): Promise<OrderSummaryRecord[]>;

  createSettlementRun(input: Omit<SettlementRunRecord, 'id' | 'createdAt'>): Promise<SettlementRunRecord>;
  findSettlementRun(tenantCode: string, runDate: string): Promise<SettlementRunRecord | null>;
  updateSettlementRun(id: number, patch: Partial<SettlementRunRecord>): Promise<SettlementRunRecord>;
  listSettlementRuns(tenantCode: string, limit?: number): Promise<SettlementRunRecord[]>;

  /** 写一条余额流水并同步更新余额快照（两件事必须一起成功） */
  appendWalletTxn(input: {
    tenantCode: string;
    type: WalletTxnRecord['type'];
    amountCents: number;
    refOrderNo?: string | null;
    runId?: number | null;
    source: WalletTxnRecord['source'];
    operator?: string | null;
    remark?: string | null;
    createdAt?: Date;
  }): Promise<WalletTxnRecord>;
  listWalletTxns(tenantCode: string, opts?: { limit?: number; type?: WalletTxnRecord['type'] }): Promise<WalletTxnRecord[]>;

  /** 每日任务需要跨租户扫（内存实现里就是遍历 tenants） */
  listExpiringSubscriptions(withinDays: number, now?: Date): Promise<SubscriptionRecord[]>;

  getStatement(tenantCode: string, period: string): Promise<StatementRecord | null>;
  upsertStatement(tenantCode: string, period: string, patch: Partial<StatementRecord>): Promise<StatementRecord>;
  listStatements(tenantCode: string): Promise<StatementRecord[]>;

  /* ------------------------------------------------- 上线流水线（S6） */

  /**
   * 改一个阶段的状态。
   * 用 `stageNo` 定位而不是 id —— 阶段是**固定 12 个**，业务语义上就该按序号找；
   * 让调用方持有内部 id 只会多一层"这个 id 是哪个阶段"的翻译。
   */
  updatePipelineStage(
    tenantCode: string,
    stageNo: number,
    patch: Partial<Pick<PipelineStageRecord, 'status' | 'owner' | 'startAt' | 'doneAt' | 'rejectReason' | 'contactedAt' | 'remark' | 'rejectedAt' | 'resubmittedAt'>>,
  ): Promise<PipelineStageRecord>;
  /** 全平台流水线（看板要一次看到所有租户卡在哪，不能按租户逐个查） */
  listAllPipeline(): Promise<PipelineStageRecord[]>;

  /** 租户状态流转：停用 / 恢复（数据保留，不删） */
  setTenantStatus(tenantCode: string, status: TenantStatus): Promise<TenantRecord>;

  /* ------------------------------------------------- 版本与推送（S6） */

  createAppVersion(input: { version: string; note?: string | null }): Promise<AppVersionRecord>;
  listAppVersions(): Promise<AppVersionRecord[]>;
  findAppVersion(id: number): Promise<AppVersionRecord | null>;
  updateAppVersion(id: number, patch: Partial<AppVersionRecord>): Promise<AppVersionRecord>;

  createPushBatch(input: Omit<PushBatchRecord, 'id' | 'createdAt' | 'finishedAt'> & { finishedAt?: string | null }): Promise<PushBatchRecord>;
  updatePushBatch(id: number, patch: Partial<PushBatchRecord>): Promise<PushBatchRecord>;
  listPushBatches(limit?: number): Promise<PushBatchRecord[]>;
  addPushTargets(inputs: Array<Omit<PushTargetRecord, 'id'>>): Promise<PushTargetRecord[]>;
  listPushTargets(opts?: { batchId?: number; tenantCode?: string }): Promise<PushTargetRecord[]>;
  updatePushTarget(id: number, patch: Partial<PushTargetRecord>): Promise<PushTargetRecord>;
  /** 某租户当前生效的版本（按最近一次成功推送算） */
  currentAppOf(tenantCode: string): Promise<PushTargetRecord | null>;

  /* ------------------------------------------------- 密钥（S6） */

  upsertSecret(input: {
    tenantCode: string;
    kind: SecretKind;
    cipher: string;
    masked: string;
    remark?: string | null;
  }): Promise<TenantSecretRecord>;
  listSecrets(tenantCode?: string): Promise<TenantSecretRecord[]>;
  markSecretInvalid(tenantCode: string, kind: SecretKind, reason: string): Promise<TenantSecretRecord | null>;

  /* ------------------------------------------------- 告警（S6） */

  /** 幂等：dedupeKey 已存在则直接返回既有那条（巡检每次跑都不会刷屏） */
  raiseAlert(input: Omit<AlertRecord, 'id' | 'createdAt' | 'ackAt' | 'ackBy'>): Promise<{ alert: AlertRecord; created: boolean }>;
  listAlerts(opts?: { open?: boolean; tenantCode?: string; limit?: number }): Promise<AlertRecord[]>;
  ackAlert(id: number, by: string): Promise<AlertRecord>;

  /* ------------------------------------------------- 工单（S6） */

  createTicket(input: { tenantCode?: string | null; title: string; category: TicketCategory; createdBy: string }): Promise<TicketRecord>;
  listTickets(opts?: { status?: TicketStatus; tenantCode?: string }): Promise<TicketRecord[]>;
  findTicket(id: number): Promise<TicketRecord | null>;
  appendTicketLog(id: number, log: { by: string; text: string }, patch?: Partial<Pick<TicketRecord, 'status' | 'assignee'>>): Promise<TicketRecord>;

  /* ------------------------------------------------- 审计（S6） */

  /** 平台审计流水（谁在什么时候动了哪个租户）—— 过渡期无 RBAC 时这是唯一的追责依据 */
  listAudits(opts?: { tenantCode?: string; limit?: number }): Promise<AuditRecord[]>;

  /* ------------------------------------------------- 边界兜底（S7） */

  /**
   * 记录一条孤儿支付（收到钱但没有订单）。
   *
   * 幂等键是 `tenantCode + txnId`：微信回调会重放，同一笔钱记三遍就变成
   * "三笔要查的账"，人工核查时会先被自己的记录误导。
   */
  appendOrphanPay(input: {
    tenantCode: string;
    orderNo: string;
    txnId: string;
    amountCents: number;
    paidAt?: string | null;
  }): Promise<{ record: OrphanPayRecord; created: boolean }>;
  listOrphanPays(opts?: { tenantCode?: string; status?: OrphanPayRecord['status']; limit?: number }): Promise<OrphanPayRecord[]>;
  resolveOrphanPay(id: number, by: string, note: string): Promise<OrphanPayRecord>;

  /** 任务运行记录（五类定时任务共用一张表 —— 「跑失败了」必须看得见） */
  appendJobRun(input: Omit<JobRunRecord, 'id'>): Promise<JobRunRecord>;
  listJobRuns(opts?: { kind?: JobKind; limit?: number }): Promise<JobRunRecord[]>;

  /* ------------------------------------------------- 学校与楼栋模板（S6） */

  deleteSchool(id: number): Promise<boolean>;

  reset(): Promise<void>;
}

/**
 * 一键配置全部楼栋的入参（§4.3 常态操作）。
 *
 * 关于「单栋编辑」与「一键配置」必须写同一处 —— 这是设计上的一个真实陷阱：
 * 若单栋编辑写楼栋列、一键配置写 config_override，那么"个别改过的楼栋"
 * 在一键配置后会看起来没生效（列优先于 override），商户会以为功能坏了。
 * 因此约定：
 *   · 已有列的已知字段（起送价 / 配送费 / 时间窗 / 提示语）→ **列是权威**，两条路径都写列
 *   · 未知字段（将来新增的配置项）→ 一律进 config_override，不用改表（铁律 5）
 * 值为 null 表示「清除覆盖、恢复继承店铺」。
 */
export interface BulkBuildingConfig {
  minAmountCents?: number | null;
  deliveryFeeCents?: number | null;
  accessibleFrom?: string | null;
  accessibleTo?: string | null;
  notice?: string | null;
  /** 清除 config_override 里的扩展键，恢复继承 */
  clearOverrideKeys?: string[];
}

export interface TenantRepo {
  listBuildings(includeDisabled?: boolean): Promise<BuildingRecord[]>;
  findBuilding(id: number): Promise<BuildingRecord | null>;
  createBuilding(input: { name: string; code?: string; sort?: number; isDefault?: boolean; configOverride?: Record<string, unknown> | null }): Promise<BuildingRecord>;
  updateBuilding(id: number, patch: Partial<BuildingRecord>): Promise<BuildingRecord>;
  /** 只停用不删除（§4.8）：有历史订单 / 库存流水引用后删除会导致订单、流水、报表全部对不上 */
  disableBuilding(id: number): Promise<BuildingRecord>;
  /** 一键配置全部楼栋（§4.3 常态操作）；buildingIds 省略时作用于全部启用楼栋 */
  applyBulkConfig(patch: BulkBuildingConfig, buildingIds?: number[]): Promise<number>;
  getShopConfig(): Promise<ShopConfigRecord>;
  saveShopConfig(patch: Partial<ShopConfigRecord>): Promise<ShopConfigRecord>;

  /* ------------------------------------------------------------ 商品与库存 */

  listCategories(): Promise<CategoryRecord[]>;
  listProducts(opts?: { includeOff?: boolean }): Promise<ProductRecord[]>;
  findProduct(id: number): Promise<ProductRecord | null>;
  createProduct(input: {
    name: string;
    spec?: string | null;
    cover?: string | null;
    priceCents: number;
    categoryId?: number | null;
    sort?: number;
    /** 建商品时可直接指定在哪些楼栋上架 —— 避免"建完还要逐栋上架"的重复劳动 */
    buildingIds?: number[];
  }): Promise<ProductRecord>;
  updateProduct(id: number, patch: Partial<ProductRecord>): Promise<ProductRecord>;

  listStocks(buildingId?: number): Promise<ProductStockRecord[]>;
  findStock(productId: number, buildingId: number): Promise<ProductStockRecord | null>;
  /** 建/改一格（**设定绝对值**）。不存在则建（= 在该栋上架） */
  upsertStock(
    productId: number,
    buildingId: number,
    patch: Partial<Pick<ProductStockRecord, 'stock' | 'status' | 'warnStock'>>,
  ): Promise<ProductStockRecord>;

  /**
   * 库存**增量迁移**原语 —— 业务层所有非条件性变动都走它。
   *
   * 语义等价于（Prisma 实现必须写成一条语句，不能先查再写）：
   *   UPDATE product_stocks
   *      SET stock = stock + ?, locked = locked + ?, sold = sold + ?
   *    WHERE product_id = ? AND building_id = ?
   * 并把同一次调用写进 stock_logs —— **改库存与记流水不可分离**，
   * 分成两次调用就迟早出现"改了没记"的格子，而对账只能靠流水。
   *
   * `minStock`：要求变更后 stock ≥ minStock（预占传 0 保证不出现负库存）。
   */
  moveStock(input: {
    productId: number;
    buildingId: number;
    /** 增量，有符号 */
    dStock?: number;
    dLocked?: number;
    dSold?: number;
    type: StockLogType;
    refOrderNo?: string | null;
    operator?: string | null;
    remark?: string | null;
    createdAt?: Date;
    /** 结果必须 ≥ 该值，否则整体不生效 */
    minStock?: number;
    /** 该格必须已存在（不存在就是"没上架"） */
    requireExists?: boolean;
  }): Promise<{ ok: boolean; reason?: 'not_found' | 'insufficient'; cell: ProductStockRecord | null; log: StockLogRecord | null }>;

  /**
   * 原子条件迁移 —— **库存不超卖的唯一保证**，`moveStock` 的带条件版本。
   *
   * 语义上严格等价于（Prisma 实现必须这么写，**不能先查再写**）：
   *   UPDATE product_stocks
   *      SET stock = stock + ?, locked = locked + ?, sold = sold + ?
   *    WHERE product_id = ? AND building_id = ? AND status = 'on'
   *      AND stock + ? >= 0            -- 结果不得为负
   * 然后看 affectedRows：1 = 成功，0 = 条件不满足。
   *
   * 与 `moveStock` 的唯一区别：`moveStock` 无条件执行 + 事后判 `minStock`，
   * 这里把条件写进 WHERE —— 因为在真库里"读-判-写"会在两语句之间被并发插队，
   * 1000 个请求会读到同一个 stock=1 然后 1000 个都成功 → 超卖。
   *
   * **内存实现因为 JS 单线程天然不会交错，所以这里只能验证条件语义**，
   * 真正的原子性由数据库行锁保证。这也是为什么它必须留在仓储层：
   * 只有仓储知道"这是一条语句"还是"两条语句"。
   */
  moveStockIf(input: {
    productId: number;
    buildingId: number;
    dStock: number;
    dLocked?: number;
    dSold?: number;
    type: StockLogType;
    refOrderNo?: string | null;
    operator?: string | null;
    remark?: string | null;
    createdAt?: Date;
    /** 格子必须存在且 status='on'（= 已上架） */
    requireOnShelf?: boolean;
  }): Promise<{ ok: boolean; reason?: 'not_on_shelf' | 'insufficient'; cell: ProductStockRecord | null; log: StockLogRecord | null }>;

  findStockByOrder(orderNo: string): Promise<StockLogRecord[]>;
  listStockLogs(opts?: { productId?: number; buildingId?: number; limit?: number }): Promise<StockLogRecord[]>;

  /* ------------------------------------------------------------ 用户与地址 */

  findUserByOpenid(openid: string): Promise<UserRecord | null>;
  findUser(id: number): Promise<UserRecord | null>;
  createUser(input: { openid: string; unionid?: string | null; nickname?: string | null; avatar?: string | null }): Promise<UserRecord>;
  updateUser(id: number, patch: Partial<UserRecord>): Promise<UserRecord>;

  listAddresses(userId: number): Promise<AddressRecord[]>;
  findAddress(userId: number, id: number): Promise<AddressRecord | null>;
  createAddress(input: Omit<AddressRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<AddressRecord>;
  updateAddress(userId: number, id: number, patch: Partial<AddressRecord>): Promise<AddressRecord>;
  deleteAddress(userId: number, id: number): Promise<void>;

  /* ---------------------------------------------------------------- 订单 */

  /**
   * 客户端幂等键命中检测 —— **防连点重复下单**。
   * 学生在地铁里连点三次"提交订单"，网络抖动下三次请求都会到服务端；
   * 没有这道检测就是三张单、三份库存、三笔服务费。
   */
  findOrderByClientKey(userId: number, clientKey: string): Promise<OrderRecord | null>;
  /** 生成订单号（含租户短前缀）。实现需保证并发下不重号。 */
  nextOrderNo(tenantCode: string): Promise<string>;
  createOrder(input: {
    orderNo: string;
    userId: number;
    buildingId: number;
    floor: string | null;
    room: string;
    contact: string | null;
    phone: string | null;
    amountCents: number;
    deliveryFeeCents: number;
    totalCents: number;
    feeCents: number;
    remark: string | null;
    clientKey: string | null;
    items: Array<{ productId: number; nameSnap: string; priceSnap: number; qty: number; amountCents: number }>;
  }): Promise<OrderRecord>;

  findOrder(orderNo: string): Promise<OrderRecord | null>;

  /**
   * 状态流转落库。**必须带上"期望的当前状态"**（`expectFrom`）：
   * 支付回调可能并发到达两次，若实现是"读出来看看再写"，两次回调会都读到
   * pending_pay 然后都往下走 —— 等价于没有幂等。
   * Prisma 实现必须写成 `UPDATE ... WHERE order_no = ? AND status = ?`
   * 并检查 affectedRows，affectedRows=0 表示"别人已经改过了"，调用方据此走幂等分支。
   */
  updateOrderStatus(input: {
    orderNo: string;
    expectFrom: OrderStatus;
    to: OrderStatus;
    patch?: Partial<Pick<OrderRecord, 'payStatus' | 'payTxnId' | 'paidAt' | 'acceptedAt' | 'deliveredAt' | 'cancelledAt' | 'cancelReason' | 'autoCompleted'>>;
  }): Promise<{ ok: boolean; order: OrderRecord | null }>;

  listOrdersByUser(userId: number, opts?: { limit?: number; statuses?: OrderStatus[] }): Promise<OrderRecord[]>;
  /**
   * 商户后台订单管理（W-07）—— 跨用户、按状态筛选、可按单号/房间号检索、真分页。
   *
   * 为什么要单独开一个而不是复用 `listOrdersByStatus`：
   *   那个方法只能"取某几个状态的全部"，没有 offset 也没有关键字。
   *   配送清单（手机端）要的正是"全取回来按楼栋分组"；而网页后台面对的是
   *   一整个学期的订单，全量取回再在浏览器里翻页，数据量一大就是卡死。
   *   两种取法都是对的，错在共用。
   */
  listOrders(opts: {
    statuses?: OrderStatus[];
    keyword?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ items: OrderRecord[]; total: number }>;
  /** 商户配送清单：按状态取全部订单（**跨用户**，商户要看的是整栋楼） */
  listOrdersByStatus(statuses: OrderStatus[], opts?: { limit?: number }): Promise<OrderRecord[]>;
  /** 超时关单扫描：pending_pay 且创建早于 before */
  listExpiredPendingPay(before: Date): Promise<OrderRecord[]>;
  /** 送达兜底扫描：delivering 且接单早于 before */
  listStuckDelivering(before: Date): Promise<OrderRecord[]>;
  /** 某学生是否有过某商品的成交（"再来一单"用；也用于商品下架后的历史入口） */
  countOrdersByUserAndProduct(userId: number, productId: number): Promise<number>;

  /* ------------------------------------------------ 站内消息 / 订阅授权 */

  addNotice(input: {
    userId: number; type: NoticeType; title: string; body: string; orderNo: string | null;
  }): Promise<NoticeRecord>;

  listNotices(userId: number, opts?: { limit?: number }): Promise<NoticeRecord[]>;

  countUnreadNotices(userId: number): Promise<number>;

  /**
   * 标记已读。`ids` 省略 = 全部标为已读。
   * 返回**本次真正被改的行数**：已读的重复标记不应返回 1，否则前端的红点
   * 会在"又点了一次"时诡异地多减一个。
   */
  markNoticesRead(userId: number, ids?: number[]): Promise<number>;

  addPushGrant(input: {
    userId: number; tmplId: string; result: string; orderNo: string | null;
  }): Promise<PushGrantRecord>;

  /**
   * 取出一条**尚未使用**的 accept 授权并当场作废（一次性授权）。
   * 找不到返回 null —— 调用方据此决定"只走站内"，不去碰微信接口。
   */
  consumePushGrant(userId: number, tmplId: string, orderNo: string | null): Promise<PushGrantRecord | null>;

  reset(): Promise<void>;
}

/** 仓储工厂：按租户取库。TenantRouter 用它解析请求上下文。 */
export interface RepoFactory {
  platform(): PlatformRepo;
  tenant(tenantCode: string): TenantRepo;
  describe(): string;
}
