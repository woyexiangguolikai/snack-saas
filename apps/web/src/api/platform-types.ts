/**
 * 平台后台的类型定义。
 *
 * 与 `api/types.ts`（商户端）分开一个文件的理由：**这两套类型不该能互相引用**。
 * 商户端类型里有 roomNo（店主是正当可见的），平台端类型里绝不能有 ——
 * 分成两个文件后，平台页面想 import 一个带 roomNo 的类型，
 * 得先显式跨文件，那一刻的改动是显眼的。
 */

/* ---------------------------------------------------------------- 租户 */

export interface GateTone {
  subscriptionEndsAt: string | null;
  subscriptionDaysLeft: number | null;
  subscriptionValid: boolean;
  subscriptionTone: 'ok' | 'warn' | 'danger' | 'off';
  balanceCents: number;
  warnLineCents: number;
  balanceTone: 'ok' | 'warn' | 'danger' | 'off';
}

export interface PlatformTenantRow {
  tenantCode: string;
  shopName: string;
  orgName: string;
  appid: string | null;
  status: string;
  dbName: string;
  buildingCount: number;
  gates: GateTone;
}

export interface PlatformTenantDetail {
  basic: {
    tenantCode: string;
    shopName: string;
    orgName: string;
    appid: string | null;
    mchId: string | null;
    region: string | null;
    contactName: string | null;
    contactPhone: string | null;
    dbName: string;
    status: string;
    createdAt: string;
  };
  gates: {
    wallet: { balanceCents: number; warnLineCents: number; creditLimitCents: number };
    subscription: { periodStart: string | null; periodEnd: string | null; status: string; daysLeft: number | null };
    pending: { items: Array<{ orderNo: string; amountCents: number }>; totalCents: number };
  };
  buildings: Array<{ id: number; code: string; name: string; status: string; deliveryEnabled: boolean; sort: number }>;
  orderSummary: {
    orderCount: number;
    gmvCents: number;
    feeCents: number;
    recent: Array<{
      orderNo: string;
      amountCents: number;
      feeCents: number;
      status: string;
      buildingCode: string | null;
      paidAt: string | null;
      refundCents: number;
    }>;
  };
  pipeline: PipelineTenantView;
  version: {
    currentVersion: string | null;
    pushedAt: string | null;
    submitted: boolean;
    published: boolean;
    error: string | null;
    history: unknown[];
  };
  audits: Array<{ actor: string; action: string; target: string | null; detail: string | null; at: string }>;
}

/* ------------------------------------------------------------- 流水线 */

export interface PipelineStageView {
  tenantCode: string;
  stageNo: number;
  stageName: string;
  status: 'pending' | 'doing' | 'done' | 'rejected';
  owner: 'renter' | 'partner' | 'platform' | 'system';
  startAt: string | null;
  doneAt: string | null;
  rejectReason: string | null;
  rejectedAt: string | null;
  resubmittedAt: string | null;
  contactedAt: string | null;
  remark: string | null;
  slaDays: number;
  external: boolean;
  stuckDays: number;
  overdue: boolean;
  lastContactedAt: string | null;
}

export interface PipelineTenantView {
  tenantCode: string;
  shopName: string;
  status: string;
  currentStageNo: number;
  currentStageName: string;
  doneCount: number;
  totalCount: number;
  stuckDays: number;
  overdue: boolean;
  currentOwner: string;
  external: boolean;
  lastContactedAt: string | null;
  hasRejected: boolean;
  stages: PipelineStageView[];
}

export interface PipelineBoard {
  items: PipelineTenantView[];
  summary: {
    total: number;
    onTrack: number;
    overdue: number;
    rework: number;
    activated: number;
    avgStuckDays: number;
  };
  stageNames: Array<{ no: number; name: string; owner: string; slaDays: number; external: boolean }>;
}

export interface ReworkQueue {
  items: Array<{
    tenantCode: string;
    shopName: string;
    stageNo: number;
    stageName: string;
    owner: string;
    rejectReason: string | null;
    rejectedAt: string | null;
    resubmittedAt: string | null;
    waitingDays: number;
  }>;
  byStage: Array<{ stageNo: number; stageName: string; count: number }>;
}

/* --------------------------------------------------------- 版本与推送 */

export interface AppVersion {
  id: number;
  version: string;
  note: string | null;
  status: string;
  pushedCount: number;
  publishedCount: number;
  createdAt: string;
}

export interface PushTarget {
  id: number;
  batchId: number;
  tenantCode: string;
  appid: string;
  version: string;
  ok: boolean;
  error: string | null;
  submitted: boolean;
  published: boolean;
  pushedAt: string | null;
  submittedAt: string | null;
  publishedAt: string | null;
}

export interface PushBatch {
  id: number;
  versionId: number;
  version: string;
  kind: 'gray' | 'batch' | 'rollback';
  excluded: string[];
  totalTargets: number;
  succeeded: number;
  failed: number;
  status: string;
  operator: string;
  createdAt: string;
  finishedAt: string | null;
  targetRows: PushTarget[];
}

export interface PushResult {
  batch: PushBatch;
  targets: PushTarget[];
  skipped: string[];
}

export interface VersionBoardRow {
  tenantCode: string;
  shopName: string;
  appid: string | null;
  currentVersion: string | null;
  latestVersion: string | null;
  pushedAt: string | null;
  submitted: boolean;
  published: boolean;
  failed: boolean;
  error: string | null;
  category: 'on_latest' | 'stale' | 'unsubmitted' | 'failed' | 'never_pushed';
}

export interface DeployBoard {
  latestVersion: string | null;
  stats: { total: number; onLatest: number; stale: number; unsubmitted: number; failed: number; neverPushed: number };
  items: VersionBoardRow[];
  provider: string;
  filters: Record<'all' | 'stale' | 'unsubmitted' | 'failed', number>;
}

/* ------------------------------------------------------------- 账本 */

export interface GateOverview {
  items: PlatformTenantRow[];
  summary: { total: number; balanceBlocked: number; subscriptionExpiring: number };
}

/* ------------------------------------------------------------- 密钥 */

export interface SecretView {
  id: number;
  tenantCode: string;
  shopName: string;
  kind: string;
  masked: string;
  status: 'active' | 'invalid' | 'missing';
  remark: string | null;
  updatedAt: string;
  invalidAt: string | null;
  invalidReason: string | null;
}

/* ------------------------------------------------------------- 告警 */

export interface AlertView {
  items: Array<{
    id: number;
    tenantCode: string | null;
    kind: string;
    level: 'info' | 'warn' | 'danger';
    title: string;
    detail: string;
    createdAt: string;
    ackAt: string | null;
    ackBy: string | null;
  }>;
  summary: { open: number; danger: number; warn: number; info: number };
}

/* ------------------------------------------------------------- 工单 */

export interface TicketView {
  items: Array<{
    id: number;
    tenantCode: string | null;
    shopName: string | null;
    title: string;
    category: string;
    assignee: 'platform' | 'partner';
    status: 'open' | 'doing' | 'closed';
    createdBy: string;
    createdAt: string;
    closedAt: string | null;
    logs: Array<{ at: string; by: string; text: string }>;
  }>;
  summary: Record<string, number>;
}

/* ------------------------------------------------------------- 学校 */

export interface PlatformSchool {
  id: number;
  name: string;
  region: string;
  city: string | null;
  buildings: Array<{ id: number; name: string; sort: number }>;
  tenantCount: number;
}
