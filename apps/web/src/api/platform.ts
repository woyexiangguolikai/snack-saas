/**
 * 平台后台的接口层。
 *
 * 两条与商户端**刻意不同**的规矩：
 *   ① 全部走 `x-platform-key`（`{ platform: true }`），不带 `authorization`；
 *   ② 路径一律是 `/api/platform/...`，**不含租户号** ——
 *      平台视角的 URL 里出现 tenantCode 只能作为查询参数，
 *      出现在路径前缀里会让人误以为"平台是在租户上下文里操作"。
 */
import { request, type RequestOptions } from './http';
import type {
  AppVersion,
  AlertView,
  DeployBoard,
  GateOverview,
  PipelineBoard,
  PipelineStageView,
  PipelineTenantView,
  PlatformSchool,
  PlatformTenantDetail,
  PlatformTenantRow,
  PushBatch,
  PushResult,
  ReworkQueue,
  SecretView,
  TicketView,
  VersionBoardRow,
} from './platform-types';

const P = '/api/platform';

const get = <T>(p: string, query?: RequestOptions['query']) =>
  request<T>(p, { method: 'GET', query, platform: true });
const post = <T>(p: string, body?: unknown) => request<T>(p, { method: 'POST', body, platform: true });
const patch = <T>(p: string, body?: unknown) => request<T>(p, { method: 'PATCH', body, platform: true });

/** 操作人：过渡期没有账号体系，只能手填一个名字，用于审计留痕 */
export const operator = { name: '平台运维' };

export const papi = {
  /** 不带密钥探活：用于登录页判断服务是否可达 */
  health(): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/api/health', { method: 'GET' });
  },

  /* ------------------------------------------------------------- 租户 */

  tenants(): Promise<{ items: PlatformTenantRow[] }> {
    return get<{ items: PlatformTenantRow[] }>(`${P}/tenants`);
  },

  tenantDetail(tenantCode: string): Promise<PlatformTenantDetail> {
    return get<PlatformTenantDetail>(`${P}/tenants/${tenantCode}/detail`);
  },

  createTenant(body: Record<string, unknown>): Promise<{ tenant: { tenantCode: string; shopName: string }; buildings: unknown[]; singleBuildingMode: boolean }> {
    return post(`${P}/tenants`, body);
  },

  setTenantStatus(tenantCode: string, action: 'suspend' | 'recover', reason?: string) {
    return post(`${P}/tenants/${tenantCode}/status`, { action, reason, operator: operator.name });
  },

  schools(): Promise<{ items: Array<{ id: number; name: string; region: string; city: string | null; buildingTemplates: string[] }> }> {
    return get(`${P}/schools`);
  },

  /* --------------------------------------------------------- 学校模板 */

  schoolTemplates(): Promise<{ items: PlatformSchool[] }> {
    return get<{ items: PlatformSchool[] }>(`${P}/schools/templates`);
  },

  saveSchool(body: { id?: number; name: string; region: string; city?: string | null; buildingNames?: string[] }) {
    return post(`${P}/schools/templates`, body);
  },

  deleteSchool(id: number): Promise<{ deleted: boolean; blockedBy?: number }> {
    return post(`${P}/schools/templates/${id}/delete`, {});
  },

  /* ------------------------------------------------------------- 流水线 */

  pipelineBoard(): Promise<PipelineBoard> {
    return get<PipelineBoard>(`${P}/pipeline/board`);
  },

  pipelineOf(tenantCode: string): Promise<PipelineTenantView> {
    return get<PipelineTenantView>(`${P}/pipeline/${tenantCode}`);
  },

  rework(): Promise<ReworkQueue> {
    return get<ReworkQueue>(`${P}/pipeline/rework`);
  },

  completeStage(tenantCode: string, stageNo: number, remark?: string) {
    return post<PipelineTenantView>(`${P}/pipeline/${tenantCode}/stages/${stageNo}/complete`, { remark });
  },

  rejectStage(tenantCode: string, stageNo: number, reason: string) {
    return post<PipelineTenantView>(`${P}/pipeline/${tenantCode}/stages/${stageNo}/reject`, { reason });
  },

  resubmitStage(tenantCode: string, stageNo: number) {
    return post<PipelineTenantView>(`${P}/pipeline/${tenantCode}/stages/${stageNo}/resubmit`, {});
  },

  touchStage(tenantCode: string, stageNo: number, note?: string) {
    return post<PipelineTenantView>(`${P}/pipeline/${tenantCode}/stages/${stageNo}/touch`, { note });
  },

  /* --------------------------------------------------------- 版本与推送 */

  deployBoard(filter: 'all' | 'stale' | 'unsubmitted' | 'failed' = 'all'): Promise<DeployBoard> {
    return get<DeployBoard>(`${P}/deploy/board`, { filter });
  },

  versions(): Promise<{ items: AppVersion[] }> {
    return get<{ items: AppVersion[] }>(`${P}/deploy/versions`);
  },

  createVersion(version: string, note?: string): Promise<AppVersion> {
    return post(`${P}/deploy/versions`, { version, note });
  },

  grayState(versionId: number): Promise<{ passed: boolean; reason: string }> {
    return get(`${P}/deploy/versions/${versionId}/gray-state`);
  },

  batches(): Promise<{ items: PushBatch[] }> {
    return get<{ items: PushBatch[] }>(`${P}/deploy/batches`);
  },

  push(body: {
    versionId: number;
    tenantCodes: string[];
    exclude?: string[];
    kind: 'gray' | 'batch';
    confirmedGrayPassed?: boolean;
  }): Promise<PushResult> {
    return post<PushResult>(`${P}/deploy/push`, { ...body, operator: operator.name });
  },

  rollback(batchId: number, previousVersionId: number) {
    return post(`${P}/deploy/batches/${batchId}/rollback`, { previousVersionId, operator: operator.name });
  },

  markSubmitted(tenantCode: string, version: string) {
    return post(`${P}/deploy/${tenantCode}/version/${version}/submitted`, {});
  },

  markPublished(tenantCode: string, version: string) {
    return post(`${P}/deploy/${tenantCode}/version/${version}/published`, {});
  },

  /* ------------------------------------------------------------- 账本 */

  ledgerOverview(): Promise<GateOverview> {
    return get<GateOverview>(`${P}/ledger/overview`);
  },

  topup(tenantCode: string, amountCents: number, remark?: string) {
    return post(`${P}/ledger/${tenantCode}/topup`, { amountCents, remark, operator: operator.name });
  },

  renewSubscription(tenantCode: string, periodEnd?: string) {
    return post(`${P}/ledger/${tenantCode}/subscription/renew`, { periodEnd, operator: operator.name });
  },

  statements(tenantCode: string, period?: string) {
    return get(`${P}/ledger/${tenantCode}/statements`, { period });
  },

  reconcile(tenantCode: string) {
    return get(`${P}/ledger/${tenantCode}/reconcile`);
  },

  runSettle(tenantCode: string, runDate?: string) {
    return post(`${P}/ledger/${tenantCode}/settle`, { runDate });
  },

  /* ------------------------------------------------- 定时任务（S7-A 的看板口） */

  /**
   * 任务清单由**服务端给出**，前端不写死 kind。
   * 写死的话，服务端加一个任务、前端就少一个按钮 —— 而"少一个按钮"
   * 不会报错，只会没人跑得到那个任务。
   */
  ledgerJobKinds(): Promise<{ items: Array<{ kind: string; label: string }> }> {
    return get(`${P}/ledger/jobs/kinds`);
  },

  /**
   * 任务看板。
   * `scheduleState.ticking` 与 `enabled` 分开看是有意的：
   * **手工跑绿了不等于定时任务正常**，运维最容易被这一点骗到。
   */
  ledgerJobStatus(limit = 20): Promise<{
    enabled: boolean;
    settlementHour: number;
    patrolIntervalMinutes: number;
    scheduleState: {
      lastSettlementDate: string | null;
      lastStatementPeriod: string | null;
      lastPatrolAt: string | null;
      ticking: boolean;
    };
    counts: { total: number; failed: number };
    runs: Array<{
      id: number;
      kind: string;
      ok: boolean;
      trigger: 'schedule' | 'manual';
      startedAt: string;
      detail: unknown;
      error: string | null;
    }>;
    lastSettlementDate: string | null;
  }> {
    return get(`${P}/ledger/jobs/status`, { limit: String(limit) });
  },

  /** 手动跑一次任务；`now` 可注入 → 验收不用等一天 */
  runLedgerJob(kind: string, now?: string) {
    return post(`${P}/ledger/jobs/run`, { kind, now, trigger: 'manual' });
  },

  /* ------------------------------------------------------------- 密钥 */

  secrets(tenantCode?: string): Promise<{ items: SecretView[]; missing: Array<{ tenantCode: string; shopName: string; kind: string }> }> {
    return get(`${P}/secrets`, { tenantCode });
  },

  putSecret(tenantCode: string, kind: 'upload_key' | 'pay_cert', value: string, remark?: string) {
    return post<SecretView>(`${P}/secrets`, { tenantCode, kind, value, remark, operator: operator.name });
  },

  invalidateSecret(tenantCode: string, kind: string, reason: string) {
    return post(`${P}/secrets/${tenantCode}/${kind}/invalidate`, { reason });
  },

  /* ------------------------------------------------------------- 告警 */

  alerts(open = false): Promise<AlertView> {
    return get<AlertView>(`${P}/alerts`, open ? { open: '1' } : undefined);
  },

  scanAlerts(now?: string) {
    return post(`${P}/alerts/scan`, { now });
  },

  ackAlert(id: number) {
    return post(`${P}/alerts/${id}/ack`, { by: operator.name });
  },

  /* ------------------------------------------------------------- 工单 */

  tickets(status?: string): Promise<TicketView> {
    return get<TicketView>(`${P}/tickets`, { status });
  },

  createTicket(body: { tenantCode?: string | null; title: string; category: string; detail?: string }) {
    return post(`${P}/tickets`, { ...body, createdBy: operator.name });
  },

  appendTicket(id: number, body: { text: string; status?: string; assignee?: string }) {
    return patch(`${P}/tickets/${id}`, { ...body, by: operator.name });
  },
};
