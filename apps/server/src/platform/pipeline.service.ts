import { Inject, Injectable } from '@nestjs/common';
import { ERR, BizError } from '../core/errors';
import { PIPELINE_STAGES, SYSTEM_AUTO_STAGE_NO } from '../core/pipeline-stages';
import type { PipelineStageDef } from '../core/pipeline-stages';
import { REPO_FACTORY } from '../core/repo.factory';
import type { PlatformRepo, RepoFactory } from '../core/repository';
import type {
  PipelineOwner,
  PipelineStageRecord,
  PipelineStageView,
  ReworkItem,
  TenantPipelineView,
  TenantStatus,
} from '../core/types';

const DEF_BY_NO = new Map<number, PipelineStageDef>(PIPELINE_STAGES.map((d) => [d.no, d]));

/**
 * 两个自然日之间**隔了几个工作日**（不含起始日，含截止日）。
 *
 * 为什么按工作日而不是自然日：SLA 是以工作日定义的（备案 20 个工作日），
 * 按自然日算会把两个周末算成"超期 4 天"，于是看板上满屏超期红字，
 * 看久了就没人看了 —— 一个永远在报警的看板等于没有看板。
 */
export function businessDaysBetween(from: string | null, to: Date): number {
  if (!from) return 0;
  const start = new Date(from);
  if (Number.isNaN(start.getTime())) return 0;
  const a = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const b = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  if (b.getTime() <= a.getTime()) return 0;
  let days = 0;
  const cur = new Date(a);
  while (cur.getTime() < b.getTime()) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) days += 1;
  }
  return days;
}

/** 自然日之差（返工等待用；返工是人等人的事，按天算就够了） */
function daysBetween(from: string | null, to: Date): number {
  if (!from) return 0;
  const t = new Date(from).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((to.getTime() - t) / 86_400_000));
}

/**
 * 上线流水线服务 —— 平台后台**最重要的看板**。
 *
 * 它存在的唯一理由，是把 §5 的"三个非代码瓶颈"变成可回答的问题：
 *   · 这个租户**卡在哪一步**？
 *   · 卡了**几天**？
 *   · **催过没有**（上次触达）？
 * 这三个问题答不上来，流水线就只是一张好看的图。
 */
@Injectable()
export class PipelineService {
  constructor(@Inject(REPO_FACTORY) private readonly repos: RepoFactory) {}

  private get platform(): PlatformRepo {
    return this.repos.platform();
  }

  /**
   * 全平台流水线看板。
   *
   * 一次取全部阶段再在内存里分组，而不是"按租户逐个查"：
   * 100 个租户就是 100 次查询，看板每次刷新都打 100 次库 ——
   * 这类"看起来只是慢一点"的实现，最后会变成"平台后台一打开就卡"。
   */
  async board(): Promise<{
    items: TenantPipelineView[];
    summary: {
      total: number;
      onTrack: number;
      overdue: number;
      rework: number;
      activated: number;
      avgStuckDays: number;
    };
    stageNames: Array<{ no: number; name: string; owner: PipelineOwner; slaDays: number; external: boolean }>;
  }> {
    const [tenants, stages] = await Promise.all([this.platform.listTenants(), this.platform.listAllPipeline()]);
    const byTenant = new Map<string, PipelineStageRecord[]>();
    for (const s of stages) {
      const list = byTenant.get(s.tenantCode) ?? [];
      list.push(s);
      byTenant.set(s.tenantCode, list);
    }

    const now = new Date();
    const items = tenants.map((t) => this.buildView(t.tenantCode, t.shopName, t.status, byTenant.get(t.tenantCode) ?? [], now));

    const overdue = items.filter((i) => i.overdue && i.status !== 'active').length;
    const rework = items.filter((i) => i.hasRejected).length;
    const activated = items.filter((i) => i.status === 'active').length;
    const running = items.filter((i) => i.status !== 'active');
    const avgStuckDays = running.length
      ? Math.round((running.reduce((s, i) => s + i.stuckDays, 0) / running.length) * 10) / 10
      : 0;

    return {
      items,
      summary: {
        total: items.length,
        onTrack: running.length - overdue,
        overdue,
        rework,
        activated,
        avgStuckDays,
      },
      stageNames: PIPELINE_STAGES.map((d) => ({
        no: d.no,
        name: d.name,
        owner: d.owner,
        slaDays: d.slaDays,
        external: d.external,
      })),
    };
  }

  /** 单租户流水线（P-02 租户详情里的那一块） */
  async ofTenant(tenantCode: string): Promise<TenantPipelineView> {
    const t = await this.platform.findTenantByCode(tenantCode);
    if (!t) throw BizError.notFound(ERR.TENANT_NOT_FOUND, `租户不存在：${tenantCode}`);
    const stages = await this.platform.listPipeline(tenantCode);
    return this.buildView(tenantCode, t.shopName, t.status, stages, new Date());
  }

  private buildView(
    tenantCode: string,
    shopName: string,
    status: TenantStatus,
    raw: PipelineStageRecord[],
    now: Date,
  ): TenantPipelineView {
    const sorted = [...raw].sort((a, b) => a.stageNo - b.stageNo);
    const views: PipelineStageView[] = [];
    let prevDoneAt: string | null = null;

    for (const s of sorted) {
      const def = DEF_BY_NO.get(s.stageNo);
      // 卡点起算时间：做起来了从 startAt，还没开始从前一阶段完成时间，
      // 驳回状态从驳回那一刻 —— 三个阶段各有各的"从什么时候开始等"
      const since =
        s.status === 'done'
          ? null
          : s.status === 'rejected'
            ? (s.rejectedAt ?? s.startAt ?? prevDoneAt)
            : s.status === 'doing'
              ? (s.startAt ?? prevDoneAt)
              : prevDoneAt;

      const stuckDays = s.status === 'done' ? 0 : businessDaysBetween(since, now);
      const sla = def?.slaDays ?? 0;
      views.push({
        ...s,
        slaDays: sla,
        external: def?.external ?? false,
        stuckDays,
        // SLA 为 0 表示"期望当天完成"（如建库是系统瞬时完成），不能拿它判超期
        overdue: s.status !== 'done' && sla > 0 && stuckDays > sla,
        lastContactedAt: s.contactedAt,
      });
      if (s.status === 'done') prevDoneAt = s.doneAt ?? prevDoneAt;
    }

    const current = views.find((v) => v.status !== 'done');
    const doneCount = views.filter((v) => v.status === 'done').length;
    const rejected = views.find((v) => v.status === 'rejected');

    return {
      tenantCode,
      shopName,
      status,
      currentStageNo: current?.stageNo ?? PIPELINE_STAGES.length,
      currentStageName: current?.stageName ?? '已全部完成',
      doneCount,
      totalCount: PIPELINE_STAGES.length,
      stuckDays: current?.stuckDays ?? 0,
      overdue: current?.overdue ?? false,
      currentOwner: current?.owner ?? 'renter',
      external: current?.external ?? false,
      lastContactedAt: current?.lastContactedAt ?? null,
      // 有驳回就是"待返工" —— 不必额外判"重提没重提"：
      // 重提那一刻状态就回到 doing 了，还停在 rejected 的一定是没重提
      hasRejected: Boolean(rejected),
      stages: views,
    };
  }

  /**
   * 返工队列（P-05）。
   *
   * 驳回是**正常流程**，不是异常 —— 微信审核驳回太常见了。
   * 所以这里既不 panic 也不隐藏，只回答一个问题：这一单催了没有。
   */
  async reworkQueue(): Promise<{ items: ReworkItem[]; byStage: Array<{ stageNo: number; stageName: string; count: number }> }> {
    const [tenants, stages] = await Promise.all([this.platform.listTenants(), this.platform.listAllPipeline()]);
    const nameOf = new Map(tenants.map((t) => [t.tenantCode, t.shopName]));
    const now = new Date();

    const items: ReworkItem[] = stages
      .filter((s) => s.status === 'rejected')
      .map((s) => ({
        tenantCode: s.tenantCode,
        shopName: nameOf.get(s.tenantCode) ?? s.tenantCode,
        stageNo: s.stageNo,
        stageName: s.stageName,
        owner: s.owner,
        rejectReason: s.rejectReason,
        rejectedAt: s.rejectedAt,
        resubmittedAt: s.resubmittedAt,
        waitingDays: daysBetween(s.rejectedAt, now),
      }))
      .sort((a, b) => b.waitingDays - a.waitingDays);

    const group = new Map<number, { stageNo: number; stageName: string; count: number }>();
    for (const it of items) {
      const g = group.get(it.stageNo) ?? { stageNo: it.stageNo, stageName: it.stageName, count: 0 };
      g.count += 1;
      group.set(it.stageNo, g);
    }

    return { items, byStage: [...group.values()].sort((a, b) => b.count - a.count) };
  }

  /* --------------------------------------------------------------- 推进 */

  /**
   * 完成某阶段 → 自动把下一阶段置为"进行中"。
   *
   * 为什么自动推进：漏做这一步的后果不是"少点一次按钮"，而是
   * **下一阶段永远停在 pending，卡点天数永远从 0 开始** —— 看板因此永远显示一切正常。
   */
  async complete(tenantCode: string, stageNo: number, remark?: string | null): Promise<TenantPipelineView> {
    const stage = await this.stageOf(tenantCode, stageNo);
    if (stage.status === 'done') return this.ofTenant(tenantCode);

    const now = new Date().toISOString();
    await this.platform.updatePipelineStage(tenantCode, stageNo, {
      status: 'done',
      doneAt: now,
      startAt: stage.startAt ?? now,
      rejectReason: null,
      remark: remark ?? stage.remark,
    });

    const next = PIPELINE_STAGES.find((d) => d.no === stageNo + 1);
    if (next) {
      const nextStage = await this.stageOf(tenantCode, next.no);
      if (nextStage.status === 'pending') {
        await this.platform.updatePipelineStage(tenantCode, next.no, { status: 'doing', startAt: now });
      }
    }

    await this.platform.appendAudit({
      tenantCode,
      actor: 'platform',
      action: 'pipeline.complete',
      target: `${tenantCode}#${stageNo}`,
      detail: `完成第 ${stageNo} 阶段：${stage.stageName}`,
    });

    // 12 阶段走完 = 可营业。这一步不自动做的话，租户会一直卡在 pipeline 状态，
    // 而"闸门"里订阅与余额都正常 —— 于是谁也没发现这户其实没被放开。
    const all = await this.platform.listPipeline(tenantCode);
    if (all.every((p) => p.stageNo === stageNo || p.status === 'done')) {
      await this.platform.setTenantStatus(tenantCode, 'active');
    }

    return this.ofTenant(tenantCode);
  }

  /**
   * 驳回（审核未通过 / 商户号被拒）。
   *
   * 落库保存 `rejectedAt` 不是为了统计，而是为了让"驳回后卡了几天"可算 ——
   * 这是返工队列存在的全部意义。
   */
  async reject(tenantCode: string, stageNo: number, reason: string): Promise<TenantPipelineView> {
    const text = String(reason ?? '').trim();
    if (!text) {
      // 没写原因的驳回 = 返工时只能靠记忆，而"靠记忆"通常意味着返工三周后没人知道要改什么
      throw new BizError(ERR.VALIDATION_FAILED, '驳回必须写明原因 —— 返工的人只能看到这句话');
    }
    const stage = await this.stageOf(tenantCode, stageNo);
    const now = new Date().toISOString();
    await this.platform.updatePipelineStage(tenantCode, stageNo, {
      status: 'rejected',
      rejectReason: text,
      rejectedAt: now,
      doneAt: null,
    });
    await this.platform.appendAudit({
      tenantCode,
      actor: 'platform',
      action: 'pipeline.reject',
      target: `${tenantCode}#${stageNo}`,
      detail: text,
    });
    void stage;
    return this.ofTenant(tenantCode);
  }

  /** 商户重提材料 → 状态回到"进行中"，但驳回原因**保留**（返工依据不能丢） */
  async resubmit(tenantCode: string, stageNo: number): Promise<TenantPipelineView> {
    await this.stageOf(tenantCode, stageNo);
    const now = new Date().toISOString();
    await this.platform.updatePipelineStage(tenantCode, stageNo, {
      status: 'doing',
      resubmittedAt: now,
      startAt: now,
    });
    await this.platform.appendAudit({
      tenantCode,
      actor: 'platform',
      action: 'pipeline.resubmit',
      target: `${tenantCode}#${stageNo}`,
      detail: '商户已重提，返工闭环',
    });
    return this.ofTenant(tenantCode);
  }

  /**
   * 记录"触达过商户"。
   *
   * 与"推进阶段"分开的两个动作：催办是**平台唯一能做的事**（推动权在商户手上），
   * 把它和状态推进绑在一起，就会出现"催了但没推进，于是什么都没记"。
   */
  async touch(tenantCode: string, stageNo: number, note?: string | null): Promise<TenantPipelineView> {
    await this.stageOf(tenantCode, stageNo);
    await this.platform.updatePipelineStage(tenantCode, stageNo, {
      contactedAt: new Date().toISOString(),
      ...(note ? { remark: note } : {}),
    });
    await this.platform.appendAudit({
      tenantCode,
      actor: 'platform',
      action: 'pipeline.touch',
      target: `${tenantCode}#${stageNo}`,
      detail: note ?? '记录触达',
    });
    return this.ofTenant(tenantCode);
  }

  /** 把第 8 阶段（平台建库，系统自动完成）补齐 —— 手工补建租户时用 */
  async autoCompleteSystemStage(tenantCode: string): Promise<TenantPipelineView> {
    const s = await this.stageOf(tenantCode, SYSTEM_AUTO_STAGE_NO);
    if (s.status !== 'done') return this.complete(tenantCode, SYSTEM_AUTO_STAGE_NO, '系统自动完成');
    return this.ofTenant(tenantCode);
  }

  private async stageOf(tenantCode: string, stageNo: number): Promise<PipelineStageRecord> {
    const stages = await this.platform.listPipeline(tenantCode);
    const hit = stages.find((s) => s.stageNo === stageNo);
    if (!hit) {
      throw BizError.notFound(ERR.VALIDATION_FAILED, `流水线阶段不存在：${tenantCode} #${stageNo}`);
    }
    return hit;
  }
}
