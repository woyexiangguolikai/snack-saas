import { ERR, BizError } from './errors';
import { PIPELINE_STAGES } from './pipeline-stages';
import type {
  AddressRecord,
  AlertRecord,
  AppVersionRecord,
  AuditRecord,
  BuildingRecord,
  BuildingTemplateRecord,
  BulkBuildingConfig,
  CategoryRecord,
  CreateTenantInput,
  JobKind,
  JobRunRecord,
  OrderItemRecord,
  OrderRecord,
  OrderStatus,
  OrderSummaryRecord,
  OrphanPayRecord,
  NoticeRecord,
  NoticeType,
  PipelineStageRecord,
  PlatformRepo,
  ProductRecord,
  ProductStockRecord,
  PushBatchRecord,
  PushGrantRecord,
  PushTargetRecord,
  RepoFactory,
  SchoolRecord,
  SecretKind,
  SettlementRunRecord,
  StatementRecord,
  StockLogRecord,
  StockLogType,
  SubscriptionRecord,
  TenantRepo,
  TenantRecord,
  TenantSecretRecord,
  TenantStatus,
  TicketCategory,
  TicketRecord,
  TicketStatus,
  UserRecord,
  WalletRecord,
  WalletTxnRecord,
} from './repository';
import { CENTS, feeOfCents } from './types';
import type { ShopConfigRecord } from './types';

/* ============================================================================
 * 内存仓储 —— 单元测试 / 本地冒烟 / CI
 * 行为必须与 PrismaRepo 完全一致；任何行为差异都算 bug。
 * ==========================================================================*/

export function defaultShopConfig(shopName: string, contactPhone: string | null = null): ShopConfigRecord {
  return {
    shopName,
    logoUrl: null,
    announcement: null,
    themeColor: null,
    themeScale: null,
    themeNotice: null,
    minAmountCents: 1000,   // 默认起送 10 元
    deliveryFeeCents: 100,  // 默认配送费 1 元
    openTime: '08:00',
    closeTime: '22:30',
    accessibleFrom: '06:30', // 门禁默认窗口（§4.13.2）
    accessibleTo: '22:30',
    cutoffLeadMinutes: 30,   // 预留配送在途时间 → 截单 22:00
    /**
     * 对外客服电话。建库时用**入驻时登记的联系电话**预填。
     *
     * 为什么不能留 null 等商户自己来填：
     *   新店刚上线时，学生端那几个"只有店家能回答"的空态（本栋没上架、
     *   楼栋不在覆盖范围）就已经存在了。电话为 null 时那些空态只能退化
     *   成"复制店名"，而学生第一次进店恰恰最可能撞上这些空态。
     *   用入驻电话预填，等于把"联系店家"这条出路默认打开；
     *   商户随时可以在设置页改掉或清空 —— 清空后我们**如实回到 null**，
     *   不做"偷偷用入驻电话兜底"这种事，否则商户永远关不掉对外电话。
     *
     * 单一真相源：学生看到的电话 = 商户库里的这一格。
     * 平台库里那份 `tenant.contactPhone` 是平台侧联络人电话，两者互不覆盖。
     */
    contactPhone,
    shopOpen: true,
  };
}

/** 新店的默认分类 —— 空分类会让商户第一步就卡住（建商品必选分类） */
export function seedCategories(): CategoryRecord[] {
  return ['薯片膨化', '方便面', '饮料', '糖果巧克力', '乳制品', '日用'].map((name, i) => ({
    id: i + 1,
    name,
    sort: i,
    status: 'active' as const,
  }));
}

interface TenantBucket {
  buildings: BuildingRecord[];
  shopConfig: ShopConfigRecord;
  categories: CategoryRecord[];
  products: ProductRecord[];
  stocks: ProductStockRecord[];
  stockLogs: StockLogRecord[];
  /** 用户与地址在**租户库**（openid 是租户维度的：同一学生换一家店就是另一条记录） */
  users: UserRecord[];
  addresses: AddressRecord[];
  /**
   * 真实订单（**含房间号与商品明细**）—— 与平台库的 orderSummaries 投影是两回事。
   * 订单号序号放在桶里而非全局：每租户独立库，序号天然按租户各自从 1 开始。
   */
  orders: OrderRecord[];
  orderItems: OrderItemRecord[];
  notices: NoticeRecord[];
  /** 学生对微信订阅消息模板的一次性授权（CS-13 的推送通道凭证） */
  pushGrants: PushGrantRecord[];
  seq: {
    building: number;
    category: number;
    product: number;
    stock: number;
    stockLog: number;
    user: number;
    address: number;
    order: number;
    orderItem: number;
    notices: number;
    pushGrants: number;
  };
}

function emptyBucket(shopName: string): TenantBucket {
  const categories = seedCategories();
  return {
    buildings: [],
    shopConfig: defaultShopConfig(shopName),
    categories,
    products: [],
    stocks: [],
    stockLogs: [],
    users: [],
    addresses: [],
    orders: [],
    orderItems: [],
    notices: [],
    pushGrants: [],
    seq: {
      building: 1, category: categories.length + 1, product: 1, stock: 1, stockLog: 1,
      user: 1, address: 1, order: 1, orderItem: 1, notices: 1, pushGrants: 1,
    },
  };
}

class MemoryPlatformRepo implements PlatformRepo {
  constructor(private readonly s: MemoryStore) {}

  async createTenant(input: CreateTenantInput): Promise<TenantRecord> {
    if (this.s.tenants.has(input.tenantCode)) {
      throw new BizError(ERR.VALIDATION_FAILED, `租户编码已存在：${input.tenantCode}`);
    }
    if (input.appid && [...this.s.tenants.values()].some((t) => t.appid === input.appid)) {
      throw new BizError(ERR.VALIDATION_FAILED, `AppID 已被占用：${input.appid}`);
    }

    const tenant: TenantRecord = {
      id: this.s.seq.tenant++,
      tenantCode: input.tenantCode,
      appid: input.appid,
      mchId: null,
      orgName: input.orgName,
      shopName: input.shopName,
      schoolId: input.schoolId,
      contactName: input.contactName,
      contactPhone: input.contactPhone,
      logoUrl: null,
      region: input.region,
      status: 'pipeline',
      dbName: input.dbName,
      createdAt: new Date().toISOString(),
    };
    this.s.tenants.set(tenant.tenantCode, tenant);

    this.s.subscriptions.set(tenant.tenantCode, {
      tenantCode: tenant.tenantCode,
      periodStart: input.periodStart.toISOString(),
      periodEnd: input.periodEnd.toISOString(),
      status: 'active',
      feeCents: CENTS.SUBSCRIPTION_FEE,
      notifyFlags: null,
      lastRenewAt: null,
    });
    this.s.wallets.set(tenant.tenantCode, {
      tenantCode: tenant.tenantCode,
      balanceCents: 0,
      creditLimitCents: CENTS.CREDIT_LIMIT,
      warnLineCents: CENTS.WARN_LINE,
      minTopupCents: CENTS.MIN_TOPUP,
      status: 'active',
    });

    // 建库 → 初始化租户库（默认楼栋 + 学校模板带出的楼栋 + 默认分类）
    const bucket = this.s.bucket(tenant.tenantCode);
    // 入驻登记的联系电话同时作为**对外客服电话**的初值（见 defaultShopConfig 注释）
    bucket.shopConfig = defaultShopConfig(input.shopName, input.contactPhone ?? null);
    bucket.categories = seedCategories();
    let sort = 0;
    // 单楼栋商户自动降级依赖「默认楼栋」始终存在（§4.9）
    bucket.buildings.push({
      id: bucket.seq.building++,
      code: 'B000',
      name: '默认楼栋',
      sort: sort++,
      status: 'active',
      isDefault: true,
      deliveryEnabled: true,
      minAmountCents: null,
      deliveryFeeCents: null,
      accessibleFrom: null,
      accessibleTo: null,
      notice: null,
      configOverride: null,
      createdAt: new Date().toISOString(),
    });
    for (const name of input.buildingNames) {
      if (bucket.buildings.some((b) => b.name === name)) continue; // 与默认楼栋同名则不重复建
      bucket.buildings.push({
        id: bucket.seq.building++,
        code: `B${String(sort).padStart(3, '0')}`,
        name,
        sort: sort++,
        status: 'active',
        isDefault: false,
        deliveryEnabled: true,
        minAmountCents: null,
        deliveryFeeCents: null,
        accessibleFrom: null,
        accessibleTo: null,
        notice: null,
        configOverride: null,
        createdAt: new Date().toISOString(),
      });
    }

    // 第 8 阶段（平台侧创建租户）由系统自动完成
    for (const def of PIPELINE_STAGES) {
      const auto = def.no <= 7 ? 'pending' : def.no === 8 ? 'done' : 'pending';
      this.s.pipeline.push({
        tenantCode: tenant.tenantCode,
        stageNo: def.no,
        stageName: def.name,
        status: auto as PipelineStageRecord['status'],
        owner: def.owner,
        startAt: def.no === 8 ? new Date().toISOString() : null,
        doneAt: def.no === 8 ? new Date().toISOString() : null,
        rejectReason: null,
        contactedAt: null,
        remark: null,
        rejectedAt: null,
        resubmittedAt: null,
      });
    }
    return tenant;
  }

  async findTenantByCode(tenantCode: string): Promise<TenantRecord | null> {
    return this.s.tenants.get(tenantCode) ?? null;
  }

  async findTenantByAppId(appid: string): Promise<TenantRecord | null> {
    return [...this.s.tenants.values()].find((t) => t.appid === appid) ?? null;
  }

  async listTenants(): Promise<TenantRecord[]> {
    return [...this.s.tenants.values()].sort((a, b) => a.id - b.id);
  }

  async updateTenant(tenantCode: string, patch: Partial<TenantRecord>): Promise<TenantRecord> {
    const cur = this.s.tenants.get(tenantCode);
    if (!cur) throw BizError.notFound(ERR.TENANT_NOT_FOUND, `租户不存在：${tenantCode}`);
    const next = { ...cur, ...patch, tenantCode: cur.tenantCode, id: cur.id };
    this.s.tenants.set(tenantCode, next);
    return next;
  }

  async getSubscription(tenantCode: string): Promise<SubscriptionRecord | null> {
    return this.s.subscriptions.get(tenantCode) ?? null;
  }

  async upsertSubscription(tenantCode: string, patch: Partial<SubscriptionRecord>): Promise<SubscriptionRecord> {
    const cur = this.s.subscriptions.get(tenantCode);
    if (!cur) throw BizError.notFound(ERR.TENANT_NOT_FOUND, `租户不存在：${tenantCode}`);
    const next = { ...cur, ...patch, tenantCode };
    this.s.subscriptions.set(tenantCode, next);
    return next;
  }

  async getWallet(tenantCode: string): Promise<WalletRecord | null> {
    return this.s.wallets.get(tenantCode) ?? null;
  }

  async upsertWallet(tenantCode: string, patch: Partial<WalletRecord>): Promise<WalletRecord> {
    const cur = this.s.wallets.get(tenantCode);
    if (!cur) throw BizError.notFound(ERR.TENANT_NOT_FOUND, `租户不存在：${tenantCode}`);
    const next = { ...cur, ...patch, tenantCode };
    this.s.wallets.set(tenantCode, next);
    return next;
  }

  async listSchools(): Promise<SchoolRecord[]> {
    return [...this.s.schools.values()];
  }

  async upsertSchool(school: Omit<SchoolRecord, 'id'> & { id?: number }): Promise<SchoolRecord> {
    const id = school.id ?? this.s.seq.school++;
    const rec: SchoolRecord = { id, name: school.name, region: school.region, city: school.city ?? null };
    this.s.schools.set(id, rec);
    return rec;
  }

  async listBuildingTemplates(schoolId: number): Promise<BuildingTemplateRecord[]> {
    return [...this.s.templates.values()]
      .filter((t) => t.schoolId === schoolId)
      .sort((a, b) => a.sort - b.sort);
  }

  async replaceBuildingTemplates(schoolId: number, names: string[]): Promise<void> {
    for (const [id, t] of [...this.s.templates.entries()]) {
      if (t.schoolId === schoolId) this.s.templates.delete(id);
    }
    names.forEach((name, i) => {
      const id = this.s.seq.template++;
      this.s.templates.set(id, { id, schoolId, name, sort: i });
    });
  }

  async createPipeline(tenantCode: string): Promise<PipelineStageRecord[]> {
    return this.s.pipeline.filter((p) => p.tenantCode === tenantCode);
  }

  async listPipeline(tenantCode: string): Promise<PipelineStageRecord[]> {
    return this.s.pipeline
      .filter((p) => p.tenantCode === tenantCode)
      .sort((a, b) => a.stageNo - b.stageNo);
  }

  async issueWebLoginCode(tenantCode: string, code: string, ttlSeconds: number): Promise<{ expiresAt: string }> {
    // 同一租户只保留**最新一个**码：连续点两次生成，旧码就该立刻失效 ——
    // 否则屏幕上同时有两个"看起来都能用"的码，店主自己也不知道该敲哪个
    this.s.loginCodes = this.s.loginCodes.filter((c) => c.tenantCode !== tenantCode);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    this.s.loginCodes.push({ tenantCode, code, expiresAt, usedAt: null });
    return { expiresAt };
  }

  async consumeWebLoginCode(tenantCode: string, code: string): Promise<boolean> {
    const now = Date.now();
    const hit = this.s.loginCodes.find(
      (c) => c.tenantCode === tenantCode && c.code === code && c.usedAt === null,
    );
    if (!hit) return false;
    if (new Date(hit.expiresAt).getTime() < now) return false;
    hit.usedAt = new Date().toISOString();
    return true;
  }

  async appendAudit(entry: { tenantCode?: string | null; actor: string; action: string; target?: string | null; detail?: string | null }): Promise<void> {
    this.s.audits.push({ ...entry, tenantCode: entry.tenantCode ?? null, at: new Date().toISOString() });
  }

  /* -------------------------------------------------------------- 双账本 */

  async recordPaidOrder(input: {
    tenantCode: string;
    orderNo: string;
    amountCents: number;
    buildingCode?: string | null;
    paidAt?: Date;
  }): Promise<OrderSummaryRecord> {
    // 幂等：支付回调会重复推送，同一 orderNo 只能登记一次（否则服务费会被重复扣）
    const exist = this.s.orderSummaries.get(input.orderNo);
    if (exist) return exist;

    const rec: OrderSummaryRecord = {
      id: this.s.seq.order++,
      tenantCode: input.tenantCode,
      orderNo: input.orderNo,
      amountCents: input.amountCents,
      feeCents: feeOfCents(input.amountCents),
      status: 'paid',
      paidAt: (input.paidAt ?? new Date()).toISOString(),
      buildingCode: input.buildingCode ?? null,
      settledRunId: null,
      settledAt: null,
      refundCents: 0,
      refundedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.s.orderSummaries.set(rec.orderNo, rec);
    return rec;
  }

  async findOrderSummary(tenantCode: string, orderNo: string): Promise<OrderSummaryRecord | null> {
    const o = this.s.orderSummaries.get(orderNo);
    return o && o.tenantCode === tenantCode ? o : null;
  }

  async listPendingOrders(tenantCode: string, before?: Date): Promise<OrderSummaryRecord[]> {
    return [...this.s.orderSummaries.values()]
      .filter(
        (o) =>
          o.tenantCode === tenantCode &&
          o.status === 'paid' &&
          (!before || (o.paidAt !== null && new Date(o.paidAt).getTime() < before.getTime())),
      )
      .sort((a, b) => (a.paidAt ?? '').localeCompare(b.paidAt ?? '') || a.id - b.id);
  }

  async markOrdersSettled(tenantCode: string, orderNos: string[], runId: number, at: Date): Promise<number> {
    let n = 0;
    for (const no of orderNos) {
      const o = this.s.orderSummaries.get(no);
      if (!o || o.tenantCode !== tenantCode || o.status !== 'paid') continue;
      this.s.orderSummaries.set(no, { ...o, status: 'settled', settledRunId: runId, settledAt: at.toISOString() });
      n++;
    }
    return n;
  }

  async listOrdersByRun(tenantCode: string, runId: number): Promise<OrderSummaryRecord[]> {
    return [...this.s.orderSummaries.values()]
      .filter((o) => o.tenantCode === tenantCode && o.settledRunId === runId)
      .sort((a, b) => a.id - b.id);
  }

  async markOrderRefunded(tenantCode: string, orderNo: string, refundCents: number, at: Date): Promise<OrderSummaryRecord> {
    const o = this.s.orderSummaries.get(orderNo);
    if (!o || o.tenantCode !== tenantCode) {
      throw BizError.notFound(ERR.NOT_FOUND, `订单汇总不存在：${orderNo}`);
    }
    // 已结算 → refunded（服务费返还由 LedgerService 写流水）；
    // 未结算的待扣记录直接出队，不需要返还（钱还没扣过）
    const next: OrderSummaryRecord = {
      ...o,
      status: 'refunded',
      refundCents: o.refundCents + refundCents,
      refundedAt: at.toISOString(),
    };
    this.s.orderSummaries.set(orderNo, next);
    return next;
  }

  async listOrderSummaries(tenantCode: string, limit = 200): Promise<OrderSummaryRecord[]> {
    return [...this.s.orderSummaries.values()]
      .filter((o) => o.tenantCode === tenantCode)
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
  }

  async createSettlementRun(input: Omit<SettlementRunRecord, 'id' | 'createdAt'>): Promise<SettlementRunRecord> {
    // 幂等键 runDate + tenantCode：重复跑当天任务不能扣第二次
    const dup = [...this.s.runs.values()].find(
      (r) => r.tenantCode === input.tenantCode && r.runDate === input.runDate,
    );
    if (dup) return dup;
    const rec: SettlementRunRecord = { ...input, id: this.s.seq.run++, createdAt: new Date().toISOString() };
    this.s.runs.set(rec.id, rec);
    return rec;
  }

  async findSettlementRun(tenantCode: string, runDate: string): Promise<SettlementRunRecord | null> {
    return (
      [...this.s.runs.values()].find((r) => r.tenantCode === tenantCode && r.runDate === runDate) ?? null
    );
  }

  async updateSettlementRun(id: number, patch: Partial<SettlementRunRecord>): Promise<SettlementRunRecord> {
    const cur = this.s.runs.get(id);
    if (!cur) throw BizError.notFound(ERR.NOT_FOUND, `结算批次不存在：${id}`);
    const next = { ...cur, ...patch, id: cur.id };
    this.s.runs.set(id, next);
    return next;
  }

  async listSettlementRuns(tenantCode: string, limit = 100): Promise<SettlementRunRecord[]> {
    return [...this.s.runs.values()]
      .filter((r) => r.tenantCode === tenantCode)
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
  }

  async appendWalletTxn(input: {
    tenantCode: string;
    type: WalletTxnRecord['type'];
    amountCents: number;
    refOrderNo?: string | null;
    runId?: number | null;
    source: WalletTxnRecord['source'];
    operator?: string | null;
    remark?: string | null;
    createdAt?: Date;
  }): Promise<WalletTxnRecord> {
    const w = this.s.wallets.get(input.tenantCode);
    if (!w) throw BizError.notFound(ERR.TENANT_NOT_FOUND, `租户不存在：${input.tenantCode}`);

    // 余额与流水必须一起更新：balanceAfter 是快照，对账时逐条重算即可发现不一致
    const balanceAfterCents = w.balanceCents + input.amountCents;
    const rec: WalletTxnRecord = {
      id: this.s.seq.txn++,
      tenantCode: input.tenantCode,
      type: input.type,
      amountCents: input.amountCents,
      balanceAfterCents,
      refOrderNo: input.refOrderNo ?? null,
      runId: input.runId ?? null,
      source: input.source,
      operator: input.operator ?? null,
      remark: input.remark ?? null,
      createdAt: (input.createdAt ?? new Date()).toISOString(),
    };
    this.s.txns.push(rec);

    this.s.wallets.set(input.tenantCode, {
      ...w,
      balanceCents: balanceAfterCents,
      status: balanceAfterCents <= w.creditLimitCents ? 'blocked' : balanceAfterCents <= w.warnLineCents ? 'warned' : 'active',
    });
    return rec;
  }

  async listWalletTxns(tenantCode: string, opts?: { limit?: number; type?: WalletTxnRecord['type'] }): Promise<WalletTxnRecord[]> {
    return this.s.txns
      .filter((t) => t.tenantCode === tenantCode && (!opts?.type || t.type === opts.type))
      .sort((a, b) => b.id - a.id)
      .slice(0, opts?.limit ?? 200);
  }

  async listExpiringSubscriptions(withinDays: number, now = new Date()): Promise<SubscriptionRecord[]> {
    const horizon = now.getTime() + withinDays * 86_400_000;
    return [...this.s.subscriptions.values()].filter((s) => {
      if (!s.periodEnd) return false;
      const end = new Date(s.periodEnd).getTime();
      return end > now.getTime() && end <= horizon;
    });
  }

  async getStatement(tenantCode: string, period: string): Promise<StatementRecord | null> {
    return this.s.statements.get(`${tenantCode}|${period}`) ?? null;
  }

  async upsertStatement(tenantCode: string, period: string, patch: Partial<StatementRecord>): Promise<StatementRecord> {
    const key = `${tenantCode}|${period}`;
    const cur = this.s.statements.get(key) ?? {
      tenantCode,
      period,
      orderCount: 0,
      gmvCents: 0,
      feeDueCents: 0,
      feeDeductedCents: 0,
      diffCents: 0,
      status: 'open' as const,
      createdAt: new Date().toISOString(),
    };
    const next: StatementRecord = { ...cur, ...patch, tenantCode, period };
    this.s.statements.set(key, next);
    return next;
  }

  async listStatements(tenantCode: string): Promise<StatementRecord[]> {
    return [...this.s.statements.values()]
      .filter((s) => s.tenantCode === tenantCode)
      .sort((a, b) => a.period.localeCompare(b.period));
  }

  /* ========================================================================
   * 上线流水线（S6）
   * ======================================================================*/

  async updatePipelineStage(
    tenantCode: string,
    stageNo: number,
    patch: Partial<PipelineStageRecord>,
  ): Promise<PipelineStageRecord> {
    const hit = this.s.pipeline.find((p) => p.tenantCode === tenantCode && p.stageNo === stageNo);
    if (!hit) throw BizError.notFound(ERR.VALIDATION_FAILED, `流水线阶段不存在：${tenantCode} #${stageNo}`);
    Object.assign(hit, patch);
    return hit;
  }

  async listAllPipeline(): Promise<PipelineStageRecord[]> {
    return [...this.s.pipeline].sort(
      (a, b) => a.tenantCode.localeCompare(b.tenantCode) || a.stageNo - b.stageNo,
    );
  }

  async setTenantStatus(tenantCode: string, status: TenantStatus): Promise<TenantRecord> {
    const t = this.s.tenants.get(tenantCode);
    if (!t) throw BizError.notFound(ERR.TENANT_NOT_FOUND, `租户不存在：${tenantCode}`);
    t.status = status;
    return t;
  }

  /* ========================================================================
   * 版本与推送（S6）
   * ======================================================================*/

  async createAppVersion(input: { version: string; note?: string | null }): Promise<AppVersionRecord> {
    if (this.s.appVersions.some((v) => v.version === input.version)) {
      throw new BizError(ERR.VALIDATION_FAILED, `版本号已存在：${input.version}`);
    }
    const rec: AppVersionRecord = {
      id: this.s.seq.version++,
      version: input.version,
      note: input.note ?? null,
      status: 'draft',
      pushedCount: 0,
      publishedCount: 0,
      createdAt: new Date().toISOString(),
    };
    this.s.appVersions.push(rec);
    return rec;
  }

  async listAppVersions(): Promise<AppVersionRecord[]> {
    // 新的在前 —— 看板默认就是"最近发了什么"
    return [...this.s.appVersions].sort((a, b) => b.id - a.id);
  }

  async findAppVersion(id: number): Promise<AppVersionRecord | null> {
    return this.s.appVersions.find((v) => v.id === id) ?? null;
  }

  async updateAppVersion(id: number, patch: Partial<AppVersionRecord>): Promise<AppVersionRecord> {
    const hit = this.s.appVersions.find((v) => v.id === id);
    if (!hit) throw BizError.notFound(ERR.VALIDATION_FAILED, `版本不存在：${id}`);
    Object.assign(hit, patch, { id });
    return hit;
  }

  async createPushBatch(
    input: Omit<PushBatchRecord, 'id' | 'createdAt' | 'finishedAt'> & { finishedAt?: string | null },
  ): Promise<PushBatchRecord> {
    const rec: PushBatchRecord = {
      ...input,
      id: this.s.seq.batch++,
      createdAt: new Date().toISOString(),
      finishedAt: input.finishedAt ?? null,
    };
    this.s.pushBatches.push(rec);
    return rec;
  }

  async updatePushBatch(id: number, patch: Partial<PushBatchRecord>): Promise<PushBatchRecord> {
    const hit = this.s.pushBatches.find((b) => b.id === id);
    if (!hit) throw BizError.notFound(ERR.VALIDATION_FAILED, `推送批次不存在：${id}`);
    Object.assign(hit, patch, { id });
    return hit;
  }

  async listPushBatches(limit = 50): Promise<PushBatchRecord[]> {
    return [...this.s.pushBatches].sort((a, b) => b.id - a.id).slice(0, limit);
  }

  async addPushTargets(inputs: Array<Omit<PushTargetRecord, 'id'>>): Promise<PushTargetRecord[]> {
    const out = inputs.map((i) => ({ ...i, id: this.s.seq.target++ }));
    this.s.pushTargets.push(...out);
    return out;
  }

  async listPushTargets(opts: { batchId?: number; tenantCode?: string } = {}): Promise<PushTargetRecord[]> {
    return this.s.pushTargets.filter(
      (t) =>
        (opts.batchId === undefined || t.batchId === opts.batchId) &&
        (opts.tenantCode === undefined || t.tenantCode === opts.tenantCode),
    );
  }

  async updatePushTarget(id: number, patch: Partial<PushTargetRecord>): Promise<PushTargetRecord> {
    const hit = this.s.pushTargets.find((t) => t.id === id);
    if (!hit) throw BizError.notFound(ERR.VALIDATION_FAILED, `推送目标不存在：${id}`);
    Object.assign(hit, patch, { id });
    return hit;
  }

  async currentAppOf(tenantCode: string): Promise<PushTargetRecord | null> {
    // 取**最近一次成功**推送 —— 失败的推送不能算"这家在跑哪个版本"
    const hits = this.s.pushTargets.filter((t) => t.tenantCode === tenantCode && t.ok);
    if (!hits.length) return null;
    return hits.reduce((a, b) => (b.id > a.id ? b : a));
  }

  /* ========================================================================
   * 密钥（S6）
   * ======================================================================*/

  async upsertSecret(input: {
    tenantCode: string;
    kind: SecretKind;
    cipher: string;
    masked: string;
    remark?: string | null;
  }): Promise<TenantSecretRecord> {
    const exist = this.s.secrets.find((x) => x.tenantCode === input.tenantCode && x.kind === input.kind);
    if (exist) {
      // 替换语义：旧密文**直接覆盖**，不留副本 —— 留副本就等于"可查看"绕道可回到
      Object.assign(exist, {
        cipher: input.cipher,
        masked: input.masked,
        remark: input.remark ?? null,
        status: 'active' as const,
        invalidAt: null,
        invalidReason: null,
        updatedAt: new Date().toISOString(),
      });
      return exist;
    }
    const rec: TenantSecretRecord = {
      id: this.s.seq.secret++,
      tenantCode: input.tenantCode,
      kind: input.kind,
      cipher: input.cipher,
      masked: input.masked,
      status: 'active',
      remark: input.remark ?? null,
      updatedAt: new Date().toISOString(),
      invalidAt: null,
      invalidReason: null,
    };
    this.s.secrets.push(rec);
    return rec;
  }

  async listSecrets(tenantCode?: string): Promise<TenantSecretRecord[]> {
    return this.s.secrets.filter((x) => tenantCode === undefined || x.tenantCode === tenantCode);
  }

  async markSecretInvalid(tenantCode: string, kind: SecretKind, reason: string): Promise<TenantSecretRecord | null> {
    const hit = this.s.secrets.find((x) => x.tenantCode === tenantCode && x.kind === kind);
    if (!hit) return null;
    hit.status = 'invalid';
    hit.invalidAt = new Date().toISOString();
    hit.invalidReason = reason;
    return hit;
  }

  /* ========================================================================
   * 告警（S6）
   * ======================================================================*/

  async raiseAlert(input: Omit<AlertRecord, 'id' | 'createdAt' | 'ackAt' | 'ackBy'>): Promise<{ alert: AlertRecord; created: boolean }> {
    const exist = this.s.alerts.find((a) => a.dedupeKey === input.dedupeKey);
    if (exist) return { alert: exist, created: false };
    const rec: AlertRecord = { ...input, id: this.s.seq.alert++, createdAt: new Date().toISOString(), ackAt: null, ackBy: null };
    this.s.alerts.push(rec);
    return { alert: rec, created: true };
  }

  async listAlerts(opts: { open?: boolean; tenantCode?: string; limit?: number } = {}): Promise<AlertRecord[]> {
    return this.s.alerts
      .filter(
        (a) =>
          // open === true 才过滤；不传就是"全部"（含已确认）。语义只有一种读法
          (opts.open === true ? a.ackAt === null : true) &&
          (opts.tenantCode === undefined || a.tenantCode === opts.tenantCode),
      )
      .sort((a, b) => b.id - a.id)
      .slice(0, opts.limit ?? 200);
  }

  async ackAlert(id: number, by: string): Promise<AlertRecord> {
    const hit = this.s.alerts.find((a) => a.id === id);
    if (!hit) throw BizError.notFound(ERR.VALIDATION_FAILED, `告警不存在：${id}`);
    if (hit.ackAt === null) {
      hit.ackAt = new Date().toISOString();
      hit.ackBy = by;
    }
    return hit;
  }

  /* ========================================================================
   * 工单（S6）
   * ======================================================================*/

  async createTicket(input: { tenantCode?: string | null; title: string; category: TicketCategory; createdBy: string }): Promise<TicketRecord> {
    const rec: TicketRecord = {
      id: this.s.seq.ticket++,
      tenantCode: input.tenantCode ?? null,
      title: input.title,
      category: input.category,
      // 分类决定接单人：技术归我方，经营归合伙人（§6.3 S30）
      assignee: input.category === 'operation' ? 'partner' : 'platform',
      status: 'open',
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
      closedAt: null,
      logs: [],
    };
    this.s.tickets.push(rec);
    return rec;
  }

  async listTickets(opts: { status?: TicketStatus; tenantCode?: string } = {}): Promise<TicketRecord[]> {
    return this.s.tickets
      .filter(
        (t) =>
          (opts.status === undefined || t.status === opts.status) &&
          (opts.tenantCode === undefined || t.tenantCode === opts.tenantCode),
      )
      .sort((a, b) => b.id - a.id);
  }

  async findTicket(id: number): Promise<TicketRecord | null> {
    return this.s.tickets.find((t) => t.id === id) ?? null;
  }

  async appendTicketLog(id: number, log: { by: string; text: string }, patch?: Partial<Pick<TicketRecord, 'status' | 'assignee'>>): Promise<TicketRecord> {
    const hit = this.s.tickets.find((t) => t.id === id);
    if (!hit) throw BizError.notFound(ERR.VALIDATION_FAILED, `工单不存在：${id}`);
    hit.logs.push({ ...log, at: new Date().toISOString() });
    if (patch?.status) {
      hit.status = patch.status;
      if (patch.status === 'closed') hit.closedAt = new Date().toISOString();
    }
    if (patch?.assignee) hit.assignee = patch.assignee;
    return hit;
  }

  /* ========================================================================
   * 审计（S6）
   * ======================================================================*/

  async listAudits(opts: { tenantCode?: string; limit?: number } = {}): Promise<AuditRecord[]> {
    return this.s.audits
      .filter((a) => opts.tenantCode === undefined || a.tenantCode === opts.tenantCode)
      .map((a, i) => ({ id: i + 1, tenantCode: a.tenantCode, actor: a.actor, action: a.action, target: a.target ?? null, detail: a.detail ?? null, at: a.at }))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, opts.limit ?? 100);
  }

  /* ========================================================================
   * 边界兜底（S7）：孤儿支付 + 任务运行记录
   * ======================================================================*/

  async appendOrphanPay(input: {
    tenantCode: string;
    orderNo: string;
    txnId: string;
    amountCents: number;
    paidAt?: string | null;
  }): Promise<{ record: OrphanPayRecord; created: boolean }> {
    // 幂等键 = 租户 + 支付流水号：微信回调会重放，同一笔钱记三遍就变成"三笔要查的账"
    const exist = this.s.orphanPays.find((x) => x.tenantCode === input.tenantCode && x.txnId === input.txnId);
    if (exist) return { record: exist, created: false };
    const rec: OrphanPayRecord = {
      id: this.s.seq.orphanPay++,
      tenantCode: input.tenantCode,
      orderNo: input.orderNo,
      txnId: input.txnId,
      amountCents: input.amountCents,
      paidAt: input.paidAt ?? null,
      receivedAt: new Date().toISOString(),
      status: 'open',
      resolvedAt: null,
      resolvedBy: null,
      resolveNote: null,
    };
    this.s.orphanPays.push(rec);
    return { record: rec, created: true };
  }

  async listOrphanPays(opts: { tenantCode?: string; status?: OrphanPayRecord['status']; limit?: number } = {}): Promise<OrphanPayRecord[]> {
    return this.s.orphanPays
      .filter(
        (x) =>
          (opts.tenantCode === undefined || x.tenantCode === opts.tenantCode) &&
          (opts.status === undefined || x.status === opts.status),
      )
      .sort((a, b) => b.id - a.id)
      .slice(0, opts.limit ?? 200);
  }

  async resolveOrphanPay(id: number, by: string, note: string): Promise<OrphanPayRecord> {
    const hit = this.s.orphanPays.find((x) => x.id === id);
    if (!hit) throw BizError.notFound(ERR.VALIDATION_FAILED, `孤儿支付记录不存在：${id}`);
    if (!note?.trim()) throw new BizError(ERR.VALIDATION_FAILED, '结清孤儿支付必须写明处理说明');
    hit.status = 'resolved';
    hit.resolvedAt = new Date().toISOString();
    hit.resolvedBy = by;
    hit.resolveNote = note.trim();
    return hit;
  }

  async appendJobRun(input: Omit<JobRunRecord, 'id'>): Promise<JobRunRecord> {
    const rec: JobRunRecord = { ...input, id: this.s.seq.jobRun++ };
    this.s.jobRuns.push(rec);
    // 只保留最近 500 条：任务看板看的是"最近怎么样"，不是审计流水
    if (this.s.jobRuns.length > 500) this.s.jobRuns.splice(0, this.s.jobRuns.length - 500);
    return rec;
  }

  async listJobRuns(opts: { kind?: JobKind; limit?: number } = {}): Promise<JobRunRecord[]> {
    return this.s.jobRuns
      .filter((x) => opts.kind === undefined || x.kind === opts.kind)
      .sort((a, b) => b.id - a.id)
      .slice(0, opts.limit ?? 100);
  }

  /* ========================================================================
   * 学校与楼栋模板（S6）
   * ======================================================================*/

  async deleteSchool(id: number): Promise<boolean> {
    const ok = this.s.schools.delete(id);
    for (const [tid, t] of [...this.s.templates]) if (t.schoolId === id) this.s.templates.delete(tid);
    return ok;
  }

  async reset(): Promise<void> {
    this.s.reset();
  }
}

class MemoryTenantRepo implements TenantRepo {
  constructor(private readonly s: MemoryStore, private readonly tenantCode: string) {}

  private bucket(): TenantBucket {
    return this.s.bucket(this.tenantCode);
  }

  async listBuildings(includeDisabled = true): Promise<BuildingRecord[]> {
    return this.bucket()
      .buildings.filter((b) => includeDisabled || b.status === 'active')
      .sort((a, b) => a.sort - b.sort || a.id - b.id);
  }

  async findBuilding(id: number): Promise<BuildingRecord | null> {
    return this.bucket().buildings.find((b) => b.id === id) ?? null;
  }

  async createBuilding(input: { name: string; code?: string; sort?: number; isDefault?: boolean; configOverride?: Record<string, unknown> | null }): Promise<BuildingRecord> {
    const bucket = this.bucket();
    if (bucket.buildings.some((b) => b.name === input.name)) {
      throw new BizError(ERR.VALIDATION_FAILED, `楼栋名已存在：${input.name}`);
    }
    const id = bucket.seq.building++;
    const code = input.code ?? `B${String(id).padStart(3, '0')}`;
    const rec: BuildingRecord = {
      id,
      code,
      name: input.name,
      sort: input.sort ?? bucket.buildings.length,
      status: 'active',
      isDefault: input.isDefault ?? false,
      deliveryEnabled: true,
      minAmountCents: null,
      deliveryFeeCents: null,
      accessibleFrom: null,
      accessibleTo: null,
      notice: null,
      configOverride: (input.configOverride ?? null) as BuildingRecord['configOverride'],
      createdAt: new Date().toISOString(),
    };
    bucket.buildings.push(rec);
    return rec;
  }

  async updateBuilding(id: number, patch: Partial<BuildingRecord>): Promise<BuildingRecord> {
    const bucket = this.bucket();
    const idx = bucket.buildings.findIndex((b) => b.id === id);
    if (idx < 0) throw BizError.notFound(ERR.BUILDING_NOT_FOUND, `楼栋不存在：${id}`);
    const next = { ...bucket.buildings[idx]!, ...patch, id, code: bucket.buildings[idx]!.code };
    bucket.buildings[idx] = next;
    return next;
  }

  async disableBuilding(id: number): Promise<BuildingRecord> {
    return this.updateBuilding(id, { status: 'disabled', deliveryEnabled: false });
  }

  async applyBulkConfig(patch: BulkBuildingConfig, buildingIds?: number[]): Promise<number> {
    const bucket = this.bucket();
    const targets = bucket.buildings.filter(
      (b) => b.status === 'active' && (!buildingIds || buildingIds.includes(b.id)),
    );
    // 已知字段写「列」（与单栋编辑同一处，避免两条路径打架）；未知字段进 config_override
    const KNOWN = ['minAmountCents', 'deliveryFeeCents', 'accessibleFrom', 'accessibleTo', 'notice'] as const;

    for (const b of targets) {
      const idx = bucket.buildings.findIndex((x) => x.id === b.id);
      const next: BuildingRecord = { ...b };

      for (const k of KNOWN) {
        if (patch[k] !== undefined) {
          (next as unknown as Record<string, unknown>)[k] = patch[k] ?? null;
        }
      }

      const extras: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(patch)) {
        if ((KNOWN as readonly string[]).includes(k) || k === 'clearOverrideKeys') continue;
        extras[k] = v;
      }
      let override: Record<string, unknown> | null = { ...((b.configOverride ?? {}) as Record<string, unknown>) };
      for (const k of patch.clearOverrideKeys ?? []) delete override[k];
      Object.assign(override, extras);
      next.configOverride = Object.keys(override).length ? override : null;

      bucket.buildings[idx] = next;
    }
    return targets.length;
  }

  async getShopConfig(): Promise<ShopConfigRecord> {
    return this.bucket().shopConfig;
  }

  async saveShopConfig(patch: Partial<ShopConfigRecord>): Promise<ShopConfigRecord> {
    const bucket = this.bucket();
    bucket.shopConfig = { ...bucket.shopConfig, ...patch };
    return bucket.shopConfig;
  }

  /* ------------------------------------------------------------ 商品与库存 */

  async listCategories(): Promise<CategoryRecord[]> {
    return [...this.bucket().categories].sort((a, b) => a.sort - b.sort || a.id - b.id);
  }

  async listProducts(opts: { includeOff?: boolean } = {}): Promise<ProductRecord[]> {
    return this.bucket()
      .products.filter((p) => opts.includeOff || p.status === 'active')
      .sort((a, b) => a.sort - b.sort || a.id - b.id);
  }

  async findProduct(id: number): Promise<ProductRecord | null> {
    return this.bucket().products.find((p) => p.id === id) ?? null;
  }

  async createProduct(input: {
    name: string;
    spec?: string | null;
    cover?: string | null;
    priceCents: number;
    categoryId?: number | null;
    sort?: number;
    buildingIds?: number[];
  }): Promise<ProductRecord> {
    const bucket = this.bucket();
    const name = String(input.name ?? '').trim();
    if (!name) throw new BizError(ERR.VALIDATION_FAILED, '商品名不能为空');
    if (!Number.isInteger(input.priceCents) || input.priceCents < 0) {
      throw new BizError(ERR.VALIDATION_FAILED, '价格必须为非负整数分');
    }
    if (bucket.products.some((p) => p.name === name && p.spec === (input.spec ?? null))) {
      throw new BizError(ERR.VALIDATION_FAILED, `同名同规格商品已存在：${name}`);
    }

    const now = new Date().toISOString();
    const rec: ProductRecord = {
      id: bucket.seq.product++,
      name,
      cover: input.cover ?? null,
      spec: input.spec ?? null,
      priceCents: input.priceCents,
      categoryId: input.categoryId ?? null,
      status: 'active',
      sort: input.sort ?? bucket.products.length,
      createdAt: now,
      updatedAt: now,
    };
    bucket.products.push(rec);

    // 只在指定楼栋建格 —— **不在每个楼栋都建格**。
    // 因为"没有格"和"有格且 stock=0"在前台是两种不同展示（未上架 vs 售罄），
    // 建商品时无脑铺满所有楼栋，等于把「未上架」这个状态消灭掉。
    for (const bid of input.buildingIds ?? []) {
      if (bucket.stocks.some((s) => s.productId === rec.id && s.buildingId === bid)) continue;
      bucket.stocks.push({
        id: bucket.seq.stock++,
        productId: rec.id,
        buildingId: bid,
        stock: 0,
        locked: 0,
        sold: 0,
        status: 'on',
        warnStock: null,
        updatedAt: now,
      });
    }
    return rec;
  }

  async updateProduct(id: number, patch: Partial<ProductRecord>): Promise<ProductRecord> {
    const bucket = this.bucket();
    const idx = bucket.products.findIndex((p) => p.id === id);
    if (idx < 0) throw BizError.notFound(ERR.NOT_FOUND, `商品不存在：${id}`);
    const next: ProductRecord = {
      ...bucket.products[idx]!,
      ...patch,
      id,
      updatedAt: new Date().toISOString(),
    };
    bucket.products[idx] = next;
    return next;
  }

  async listStocks(buildingId?: number): Promise<ProductStockRecord[]> {
    return this.bucket()
      .stocks.filter((s) => buildingId === undefined || s.buildingId === buildingId)
      .sort((a, b) => a.productId - b.productId || a.buildingId - b.buildingId);
  }

  async findStock(productId: number, buildingId: number): Promise<ProductStockRecord | null> {
    return this.bucket().stocks.find((s) => s.productId === productId && s.buildingId === buildingId) ?? null;
  }

  async upsertStock(
    productId: number,
    buildingId: number,
    patch: Partial<Pick<ProductStockRecord, 'stock' | 'status' | 'warnStock'>>,
  ): Promise<ProductStockRecord> {
    const bucket = this.bucket();
    if (!bucket.products.some((p) => p.id === productId)) {
      throw BizError.notFound(ERR.NOT_FOUND, `商品不存在：${productId}`);
    }
    if (!bucket.buildings.some((b) => b.id === buildingId)) {
      throw BizError.notFound(ERR.BUILDING_NOT_FOUND, `楼栋不存在：${buildingId}`);
    }
    if (patch.stock !== undefined && (!Number.isInteger(patch.stock) || patch.stock < 0)) {
      throw new BizError(ERR.VALIDATION_FAILED, '库存必须为非负整数');
    }

    const idx = bucket.stocks.findIndex((s) => s.productId === productId && s.buildingId === buildingId);
    if (idx < 0) {
      const rec: ProductStockRecord = {
        id: bucket.seq.stock++,
        productId,
        buildingId,
        stock: patch.stock ?? 0,
        locked: 0,
        sold: 0,
        status: patch.status ?? 'on',
        warnStock: patch.warnStock ?? null,
        updatedAt: new Date().toISOString(),
      };
      bucket.stocks.push(rec);
      return rec;
    }
    const next: ProductStockRecord = {
      ...bucket.stocks[idx]!,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    bucket.stocks[idx] = next;
    return next;
  }

  /**
   * 增量迁移原语。内存实现里"读-改-写"这三步不会被打断（JS 单线程），
   * 但**数据库实现必须写成一条 UPDATE**，不能照抄这个写法 —— 见接口注释。
   */
  async moveStock(input: {
    productId: number;
    buildingId: number;
    dStock?: number;
    dLocked?: number;
    dSold?: number;
    type: StockLogType;
    refOrderNo?: string | null;
    operator?: string | null;
    remark?: string | null;
    createdAt?: Date;
    minStock?: number;
    requireExists?: boolean;
  }): Promise<{ ok: boolean; reason?: 'not_found' | 'insufficient'; cell: ProductStockRecord | null; log: StockLogRecord | null }> {
    const bucket = this.bucket();
    const dStock = input.dStock ?? 0;
    const dLocked = input.dLocked ?? 0;
    const dSold = input.dSold ?? 0;

    const cell = bucket.stocks.find((s) => s.productId === input.productId && s.buildingId === input.buildingId);
    // 条件判定照搬那一条 SQL 的 WHERE
    if (!cell) {
      if (input.requireExists) return { ok: false, reason: 'not_found', cell: null, log: null };
      // 不要求存在则建格（= 顺带上架），但与条件版不同：这里允许零起点
      const created: ProductStockRecord = {
        id: bucket.seq.stock++,
        productId: input.productId,
        buildingId: input.buildingId,
        stock: dStock,
        locked: dLocked,
        sold: dSold,
        status: 'on',
        warnStock: null,
        updatedAt: new Date().toISOString(),
      };
      if (created.stock < 0) return { ok: false, reason: 'insufficient', cell: null, log: null };
      bucket.stocks.push(created);
      const log = await this.appendStockLog({
        productId: input.productId,
        buildingId: input.buildingId,
        type: input.type,
        change: dStock,
        stockAfter: created.stock,
        refOrderNo: input.refOrderNo,
        operator: input.operator,
        remark: input.remark,
        createdAt: input.createdAt,
      });
      return { ok: true, cell: created, log };
    }

    const nextStock = cell.stock + dStock;
    if (input.minStock !== undefined && nextStock < input.minStock) {
      return { ok: false, reason: 'insufficient', cell, log: null };
    }
    if (nextStock < 0 || cell.locked + dLocked < 0 || cell.sold + dSold < 0) {
      return { ok: false, reason: 'insufficient', cell, log: null };
    }

    const next: ProductStockRecord = {
      ...cell,
      stock: nextStock,
      locked: cell.locked + dLocked,
      sold: cell.sold + dSold,
      updatedAt: new Date().toISOString(),
    };
    bucket.stocks[bucket.stocks.findIndex((s) => s.id === cell.id)] = next;

    // 改库存与记流水在同一次调用里 —— 分开就迟早出现"改了没记"的格子
    const log = await this.appendStockLog({
      productId: input.productId,
      buildingId: input.buildingId,
      type: input.type,
      change: dStock,
      stockAfter: next.stock,
      refOrderNo: input.refOrderNo,
      operator: input.operator,
      remark: input.remark,
      createdAt: input.createdAt,
    });
    return { ok: true, cell: next, log };
  }

  /**
   * 条件迁移 —— 不超卖的执行点。
   *
   * 语义严格等价于：
   *   UPDATE product_stocks SET stock = stock + ?, locked = locked + ?, sold = sold + ?
   *    WHERE product_id = ? AND building_id = ? [AND status = 'on'] AND stock + ? >= 0
   * 然后看 affectedRows。
   *
   * 内存实现里"先查再判"与真库等价（单线程不交错）；真库必须靠 WHERE 里的条件 + 行锁。
   * 这不是写法差异，是**正确性差异** —— 见接口注释里的超卖推演。
   */
  async moveStockIf(input: {
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
    requireOnShelf?: boolean;
  }): Promise<{ ok: boolean; reason?: 'not_on_shelf' | 'insufficient'; cell: ProductStockRecord | null; log: StockLogRecord | null }> {
    const bucket = this.bucket();
    const dLocked = input.dLocked ?? 0;
    const dSold = input.dSold ?? 0;
    const cell = bucket.stocks.find((s) => s.productId === input.productId && s.buildingId === input.buildingId);

    if (!cell) return { ok: false, reason: 'not_on_shelf', cell: null, log: null };
    if (input.requireOnShelf && cell.status !== 'on') {
      return { ok: false, reason: 'not_on_shelf', cell, log: null };
    }
    // WHERE stock + ? >= 0 —— 结果不得为负
    if (!Number.isInteger(input.dStock) || cell.stock + input.dStock < 0) {
      return { ok: false, reason: 'insufficient', cell, log: null };
    }
    if (cell.locked + dLocked < 0 || cell.sold + dSold < 0) {
      return { ok: false, reason: 'insufficient', cell, log: null };
    }

    const next: ProductStockRecord = {
      ...cell,
      stock: cell.stock + input.dStock,
      locked: cell.locked + dLocked,
      sold: cell.sold + dSold,
      updatedAt: new Date().toISOString(),
    };
    bucket.stocks[bucket.stocks.findIndex((s) => s.id === cell.id)] = next;

    const log = await this.appendStockLog({
      productId: input.productId,
      buildingId: input.buildingId,
      type: input.type,
      change: input.dStock,
      stockAfter: next.stock,
      refOrderNo: input.refOrderNo,
      operator: input.operator,
      remark: input.remark,
      createdAt: input.createdAt,
    });
    return { ok: true, cell: next, log };
  }

  /** 私有：只给上面两个原语用 —— 流水不得单独写，必须与库存变更同生同灭 */
  private async appendStockLog(input: {
    productId: number;
    buildingId: number;
    type: StockLogType;
    change: number;
    stockAfter: number;
    refOrderNo?: string | null;
    operator?: string | null;
    remark?: string | null;
    createdAt?: Date;
  }): Promise<StockLogRecord> {
    const bucket = this.bucket();
    const rec: StockLogRecord = {
      id: bucket.seq.stockLog++,
      productId: input.productId,
      buildingId: input.buildingId,
      type: input.type,
      change: input.change,
      stockAfter: input.stockAfter,
      refOrderNo: input.refOrderNo ?? null,
      operator: input.operator ?? null,
      remark: input.remark ?? null,
      createdAt: (input.createdAt ?? new Date()).toISOString(),
    };
    bucket.stockLogs.push(rec);
    return rec;
  }

  async findStockByOrder(orderNo: string): Promise<StockLogRecord[]> {
    return this.bucket()
      .stockLogs.filter((l) => l.refOrderNo === orderNo)
      .sort((a, b) => a.id - b.id);
  }

  async listStockLogs(opts: { productId?: number; buildingId?: number; limit?: number } = {}): Promise<StockLogRecord[]> {
    return this.bucket()
      .stockLogs.filter(
        (l) =>
          (opts.productId === undefined || l.productId === opts.productId) &&
          (opts.buildingId === undefined || l.buildingId === opts.buildingId),
      )
      .sort((a, b) => b.id - a.id)
      .slice(0, opts.limit ?? 200);
  }

  /* ------------------------------------------------------------ 用户与地址 */

  async findUserByOpenid(openid: string): Promise<UserRecord | null> {
    return this.bucket().users.find((u) => u.openid === openid) ?? null;
  }

  async findUser(id: number): Promise<UserRecord | null> {
    return this.bucket().users.find((u) => u.id === id) ?? null;
  }

  async createUser(input: {
    openid: string;
    unionid?: string | null;
    nickname?: string | null;
    avatar?: string | null;
  }): Promise<UserRecord> {
    const bucket = this.bucket();
    const exist = bucket.users.find((u) => u.openid === input.openid);
    if (exist) return exist; // 幂等：同一 openid 重复登录不建第二个用户
    const rec: UserRecord = {
      id: bucket.seq.user++,
      openid: input.openid,
      unionid: input.unionid ?? null,
      nickname: input.nickname ?? null,
      avatar: input.avatar ?? null,
      phone: null,
      lastBuildingId: null,
      role: 'student',
      createdAt: new Date().toISOString(),
    };
    bucket.users.push(rec);
    return rec;
  }

  async updateUser(id: number, patch: Partial<UserRecord>): Promise<UserRecord> {
    const bucket = this.bucket();
    const idx = bucket.users.findIndex((u) => u.id === id);
    if (idx < 0) throw new BizError(ERR.NOT_FOUND, `用户不存在：${id}`);
    const next = { ...bucket.users[idx]!, ...patch, id };
    bucket.users[idx] = next;
    return next;
  }

  async listAddresses(userId: number): Promise<AddressRecord[]> {
    return this.bucket()
      .addresses.filter((a) => a.userId === userId)
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.id - b.id);
  }

  async findAddress(userId: number, id: number): Promise<AddressRecord | null> {
    return this.bucket().addresses.find((a) => a.userId === userId && a.id === id) ?? null;
  }

  async createAddress(input: Omit<AddressRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<AddressRecord> {
    const bucket = this.bucket();
    const now = new Date().toISOString();
    // 默认地址唯一：置新地址为默认时，同用户旧默认必须让位
    if (input.isDefault) {
      bucket.addresses = bucket.addresses.map((a) =>
        a.userId === input.userId ? { ...a, isDefault: false } : a,
      );
    }
    const rec: AddressRecord = { ...input, id: bucket.seq.address++, createdAt: now, updatedAt: now };
    bucket.addresses.push(rec);
    return rec;
  }

  async updateAddress(userId: number, id: number, patch: Partial<AddressRecord>): Promise<AddressRecord> {
    const bucket = this.bucket();
    const idx = bucket.addresses.findIndex((a) => a.userId === userId && a.id === id);
    if (idx < 0) throw new BizError(ERR.NOT_FOUND, `地址不存在：${id}`);
    if (patch.isDefault) {
      bucket.addresses = bucket.addresses.map((a) =>
        a.userId === userId ? { ...a, isDefault: false } : a,
      );
    }
    const idx2 = bucket.addresses.findIndex((a) => a.userId === userId && a.id === id);
    const next = { ...bucket.addresses[idx2]!, ...patch, id, userId, updatedAt: new Date().toISOString() };
    bucket.addresses[idx2] = next;
    return next;
  }

  async deleteAddress(userId: number, id: number): Promise<void> {
    const bucket = this.bucket();
    bucket.addresses = bucket.addresses.filter((a) => !(a.userId === userId && a.id === id));
  }

  /* ---------------------------------------------------------------- 订单 */

  async findOrderByClientKey(userId: number, clientKey: string): Promise<OrderRecord | null> {
    return this.bucket().orders.find((o) => o.userId === userId && o.clientKey === clientKey) ?? null;
  }

  async nextOrderNo(tenantCode: string): Promise<string> {
    const bucket = this.bucket();
    // 日期取中国时区的自然日：订单号里的日期必须是商户/学生眼里的"今天"，
    // 否则 23:30 下的单会显示成前一天，客服对单时对不上
    const bizDate = new Date(Date.now() + 480 * 60_000).toISOString().slice(0, 10).replace(/-/g, '');
    const n = bucket.seq.order++;
    return `${tenantCode.toUpperCase()}-${bizDate}-${String(n).padStart(4, '0')}`;
  }

  async createOrder(input: {
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
  }): Promise<OrderRecord> {
    const bucket = this.bucket();
    if (bucket.orders.some((o) => o.orderNo === input.orderNo)) {
      throw new BizError(ERR.VALIDATION_FAILED, `订单号重复：${input.orderNo}`);
    }
    const now = new Date().toISOString();
    const id = bucket.seq.order; // 与订单号里的序号同源，便于人工核对
    const items: OrderItemRecord[] = input.items.map((it) => {
      const rid = bucket.seq.orderItem++;
      return { ...it, id: rid, orderId: id };
    });
    const rec: OrderRecord = {
      id,
      orderNo: input.orderNo,
      userId: input.userId,
      buildingId: input.buildingId,
      floor: input.floor,
      room: input.room,
      contact: input.contact,
      phone: input.phone,
      amountCents: input.amountCents,
      deliveryFeeCents: input.deliveryFeeCents,
      totalCents: input.totalCents,
      feeCents: input.feeCents,
      remark: input.remark,
      status: 'pending_pay',
      payStatus: 'unpaid',
      payTxnId: null,
      paidAt: null,
      acceptedAt: null,
      deliveredAt: null,
      cancelledAt: null,
      cancelReason: null,
      clientKey: input.clientKey,
      autoCompleted: false,
      createdAt: now,
      updatedAt: now,
      items,
    };
    bucket.orders.push(rec);
    bucket.orderItems.push(...items);
    return rec;
  }

  async findOrder(orderNo: string): Promise<OrderRecord | null> {
    return this.bucket().orders.find((o) => o.orderNo === orderNo) ?? null;
  }

  async updateOrderStatus(input: {
    orderNo: string;
    expectFrom: OrderStatus;
    to: OrderStatus;
    patch?: Partial<Pick<OrderRecord, 'payStatus' | 'payTxnId' | 'paidAt' | 'acceptedAt' | 'deliveredAt' | 'cancelledAt' | 'cancelReason' | 'autoCompleted'>>;
  }): Promise<{ ok: boolean; order: OrderRecord | null }> {
    const bucket = this.bucket();
    const idx = bucket.orders.findIndex((o) => o.orderNo === input.orderNo);
    if (idx < 0) return { ok: false, order: null };
    const cur = bucket.orders[idx]!;
    // 条件写落库前的比较 —— 这一句就是 Prisma 实现里那个 WHERE status = ?
    if (cur.status !== input.expectFrom) {
      return { ok: false, order: cur };
    }
    const next: OrderRecord = {
      ...cur,
      ...(input.patch ?? {}),
      status: input.to,
      updatedAt: new Date().toISOString(),
    };
    bucket.orders[idx] = next;
    return { ok: true, order: next };
  }

  async listOrdersByUser(
    userId: number,
    opts: { limit?: number; statuses?: OrderStatus[] } = {},
  ): Promise<OrderRecord[]> {
    return this.bucket()
      .orders.filter((o) => o.userId === userId && (!opts.statuses || opts.statuses.includes(o.status)))
      .sort((a, b) => b.id - a.id)
      .slice(0, opts.limit ?? 50);
  }

  async listOrders(
    opts: { statuses?: OrderStatus[]; keyword?: string; limit?: number; offset?: number } = {},
  ): Promise<{ items: OrderRecord[]; total: number }> {
    const kw = opts.keyword?.trim() ?? '';
    const matched = this.bucket()
      .orders.filter((o) => {
        if (opts.statuses?.length && !opts.statuses.includes(o.status)) return false;
        // 商户检索只认「单号 / 房间号」两个口径：
        // 订单管理页的检索框是"我刚接到一个电话说 305 的单有问题"，不是全文搜索
        if (!kw) return true;
        return o.orderNo.includes(kw) || o.room.includes(kw);
      })
      .sort((a, b) => b.id - a.id);

    const offset = Math.max(0, opts.offset ?? 0);
    const limit = Math.min(Math.max(1, opts.limit ?? 20), 200);
    return { items: matched.slice(offset, offset + limit), total: matched.length };
  }

  async listOrdersByStatus(statuses: OrderStatus[], opts: { limit?: number } = {}): Promise<OrderRecord[]> {
    return this.bucket()
      .orders.filter((o) => statuses.includes(o.status))
      .sort((a, b) => a.id - b.id)
      .slice(0, opts.limit ?? 500);
  }

  async listExpiredPendingPay(before: Date): Promise<OrderRecord[]> {
    const t = before.getTime();
    return this.bucket()
      .orders.filter((o) => o.status === 'pending_pay' && new Date(o.createdAt).getTime() < t)
      .sort((a, b) => a.id - b.id);
  }

  async listStuckDelivering(before: Date): Promise<OrderRecord[]> {
    const t = before.getTime();
    return this.bucket()
      .orders.filter((o) => {
        if (o.status !== 'delivering') return false;
        // 以接单时刻为起算点；没有接单时刻（直连送达被拒后倒推等异常）退回创建时刻，
        // 宁可兜底偏保守，也不要让订单永远挂在"配送中"
        const base = o.acceptedAt ?? o.createdAt;
        return new Date(base).getTime() < t;
      })
      .sort((a, b) => a.id - b.id);
  }

  async countOrdersByUserAndProduct(userId: number, productId: number): Promise<number> {
    const bucket = this.bucket();
    const mine = bucket.orders.filter(
      (o) => o.userId === userId && o.payStatus !== 'unpaid' && o.status !== 'cancelled',
    );
    let n = 0;
    for (const o of mine) {
      if (o.items.some((it) => it.productId === productId)) n += 1;
    }
    return n;
  }


  /* -------------------------------------------- 站内消息 / 订阅授权 */

  async addNotice(input: {
    userId: number; type: NoticeType; title: string; body: string; orderNo: string | null;
  }): Promise<NoticeRecord> {
    const bucket = this.bucket();
    const row: NoticeRecord = {
      id: bucket.seq.notices++,
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body,
      orderNo: input.orderNo,
      createdAt: new Date().toISOString(),
      readAt: null,
    };
    bucket.notices.unshift(row);
    return row;
  }

  async listNotices(userId: number, opts: { limit?: number } = {}): Promise<NoticeRecord[]> {
    const rows = this.bucket().notices.filter((n) => n.userId === userId);
    return opts.limit ? rows.slice(0, opts.limit) : rows;
  }

  async countUnreadNotices(userId: number): Promise<number> {
    return this.bucket().notices.filter((n) => n.userId === userId && n.readAt === null).length;
  }

  async markNoticesRead(userId: number, ids?: number[]): Promise<number> {
    const bucket = this.bucket();
    const only = ids && ids.length ? new Set(ids) : null;
    // 已读的行不重复计数：否则前端"又点了一次"会把红点多减一个
    const targets = bucket.notices.filter(
      (n) => n.userId === userId && n.readAt === null && (!only || only.has(n.id)),
    );
    const at = new Date().toISOString();
    for (const n of targets) n.readAt = at;
    return targets.length;
  }

  async addPushGrant(input: {
    userId: number; tmplId: string; result: string; orderNo: string | null;
  }): Promise<PushGrantRecord> {
    const bucket = this.bucket();
    const row: PushGrantRecord = {
      id: bucket.seq.pushGrants++,
      userId: input.userId,
      tmplId: input.tmplId,
      result: input.result,
      orderNo: input.orderNo,
      consumedAt: null,
      createdAt: new Date().toISOString(),
    };
    bucket.pushGrants.push(row);
    return row;
  }

  async consumePushGrant(
    userId: number, tmplId: string, orderNo: string | null,
  ): Promise<PushGrantRecord | null> {
    const bucket = this.bucket();
    const hit = bucket.pushGrants.find(
      (g) =>
        g.userId === userId &&
        g.tmplId === tmplId &&
        g.orderNo === orderNo &&
        g.result === 'accept' &&
        g.consumedAt === null,
    );
    if (!hit) return null;
    hit.consumedAt = new Date().toISOString();
    return hit;
  }

  async reset(): Promise<void> {
    const bucket = this.bucket();
    bucket.buildings = [];
    bucket.categories = seedCategories();
    bucket.products = [];
    bucket.stocks = [];
    bucket.stockLogs = [];
    bucket.users = [];
    bucket.addresses = [];
    bucket.orders = [];
    bucket.notices = [];
    bucket.pushGrants = [];
    bucket.orderItems = [];
    bucket.seq = {
      building: 1,
      // 与 emptyBucket 同源：种子里已有 6 个分类，序号必须从 7 起，
      // 否则新建分类会撞上种子分类的 id（reset 后 id=1 的"薯片膨化"会被覆盖）
      category: seedCategories().length + 1,
      product: 1, stock: 1, stockLog: 1,
      user: 1, address: 1, order: 1, orderItem: 1, notices: 1, pushGrants: 1,
    };
    bucket.shopConfig = defaultShopConfig('未命名店铺');
  }
}

export class MemoryStore {
  readonly tenants = new Map<string, TenantRecord>();
  readonly subscriptions = new Map<string, SubscriptionRecord>();
  readonly wallets = new Map<string, WalletRecord>();
  readonly schools = new Map<number, SchoolRecord>();
  readonly templates = new Map<number, BuildingTemplateRecord>();
  /**
   * **平台库**的订单汇总投影（含待扣队列）：orderNo 全局唯一 → 重复支付回调天然幂等。
   *
   * ⚠️ 命名刻意叫 orderSummaries 而不是 orders：它是**只存钱不存人**的账本侧投影
   *（无房间号、无商品明细），与租户库里那条真实的 `OrderRecord` 是两回事。
   * 两者同名会让"这个字段到底能不能带房间号"变成每次都要重新判断的问题（AC-13）。
   */
  readonly orderSummaries = new Map<string, OrderSummaryRecord>();
  readonly runs = new Map<number, SettlementRunRecord>();
  txns: WalletTxnRecord[] = [];
  readonly statements = new Map<string, StatementRecord>();
  pipeline: PipelineStageRecord[] = [];
  audits: Array<{ tenantCode: string | null; actor: string; action: string; target?: string | null; detail?: string | null; at: string }> = [];
  /** 网页端登录码：一次性，过期即失效；只存哈希之外的元数据，用完即删 */
  loginCodes: Array<{ tenantCode: string; code: string; expiresAt: string; usedAt: string | null }> = [];

  /* ------------------------------------------------- 平台侧运行时（S6） */

  readonly appVersions: AppVersionRecord[] = [];
  readonly pushBatches: PushBatchRecord[] = [];
  readonly pushTargets: PushTargetRecord[] = [];
  readonly secrets: TenantSecretRecord[] = [];
  readonly alerts: AlertRecord[] = [];
  readonly tickets: TicketRecord[] = [];
  readonly audits2: AuditRecord[] = [];

  /* ------------------------------------------------- 边界兜底（S7） */

  /** 孤儿支付：收到钱但没有订单。只记录 + 告警，**绝不自动编单** */
  readonly orphanPays: OrphanPayRecord[] = [];
  /** 五类定时任务的运行记录 —— 失败的任务也必须留下痕迹 */
  readonly jobRuns: JobRunRecord[] = [];

  readonly seq = {
    tenant: 1, school: 1, template: 1, order: 1, run: 1, txn: 1,
    version: 1, batch: 1, target: 1, secret: 1, alert: 1, ticket: 1, audit: 1,
    orphanPay: 1, jobRun: 1,
  };
  private readonly buckets = new Map<string, TenantBucket>();

  constructor() {
    this.seedDemoSchools();
  }

  bucket(tenantCode: string): TenantBucket {
    let b = this.buckets.get(tenantCode);
    if (!b) {
      b = emptyBucket('未命名店铺');
      this.buckets.set(tenantCode, b);
    }
    return b;
  }

  /** 广西为主的学校字典 + 楼栋模板 —— 只作建租户时的模板来源（§4.1） */
  private seedDemoSchools(): void {
    const demo: Array<{ name: string; region: string; city: string; buildings: string[] }> = [
      { name: '广西大学',       region: '广西', city: '南宁', buildings: ['1 号宿舍楼', '2 号宿舍楼', '3 号宿舍楼', '4 号宿舍楼', '5 号宿舍楼', '6 号宿舍楼'] },
      { name: '广西民族大学',   region: '广西', city: '南宁', buildings: ['文学院宿舍', '理学院宿舍', '东区 1 栋', '东区 2 栋'] },
      { name: '南宁师范大学',   region: '广西', city: '南宁', buildings: ['明秀校区 1 栋', '明秀校区 2 栋', '长岗校区 1 栋'] },
      { name: '桂林电子科技大学', region: '广西', city: '桂林', buildings: ['A 区 1 栋', 'A 区 2 栋', 'B 区 1 栋'] },
    ];
    for (const s of demo) {
      const id = this.seq.school++;
      this.schools.set(id, { id, name: s.name, region: s.region, city: s.city });
      s.buildings.forEach((name, i) => {
        const tid = this.seq.template++;
        this.templates.set(tid, { id: tid, schoolId: id, name, sort: i });
      });
    }
  }

  reset(): void {
    this.tenants.clear();
    this.subscriptions.clear();
    this.wallets.clear();
    this.buckets.clear();
    this.orderSummaries.clear();
    this.runs.clear();
    this.txns = [];
    this.statements.clear();
    this.pipeline = [];
    this.audits = [];
    this.loginCodes = [];
    this.appVersions.length = 0;
    this.pushBatches.length = 0;
    this.pushTargets.length = 0;
    this.secrets.length = 0;
    this.alerts.length = 0;
    this.tickets.length = 0;
    this.audits2.length = 0;
    this.orphanPays.length = 0;
    this.jobRuns.length = 0;
    this.seq.tenant = 1;
    this.seq.order = 1;
    this.seq.run = 1;
    this.seq.txn = 1;
    this.seq.version = 1;
    this.seq.batch = 1;
    this.seq.target = 1;
    this.seq.secret = 1;
    this.seq.alert = 1;
    this.seq.ticket = 1;
    this.seq.audit = 1;
    this.seq.orphanPay = 1;
    this.seq.jobRun = 1;
  }
}

export class MemoryRepoFactory implements RepoFactory {
  readonly store = new MemoryStore();
  private readonly platformRepo = new MemoryPlatformRepo(this.store);
  private readonly tenantRepos = new Map<string, TenantRepo>();

  platform(): PlatformRepo {
    return this.platformRepo;
  }

  tenant(tenantCode: string): TenantRepo {
    let r = this.tenantRepos.get(tenantCode);
    if (!r) {
      r = new MemoryTenantRepo(this.store, tenantCode);
      this.tenantRepos.set(tenantCode, r);
    }
    return r;
  }

  describe(): string {
    return `memory (租户数=${this.store.tenants.size})`;
  }
}
