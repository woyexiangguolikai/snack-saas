import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AppLogger } from '../core/logger';
import { REPO_FACTORY } from '../core/repo.factory';
import { env } from '../core/env';
import type { JobKind, JobRunRecord, RepoFactory } from '../core/repository';
import { LedgerService } from '../ledger/ledger.service';
import { OrderService } from '../order/order.service';

/**
 * 定时任务调度器（S7 起承载**全部五类**任务）。
 *
 * 刻意的设计：**这里只有"什么时候跑"，没有"跑什么"。**
 * 业务逻辑全在各自的域服务里，且每个方法都接受 `now` 参数 ——
 * 于是每个任务都能在测试里被"手动拨表跑一次"，跨日扣减、15/7/3 提醒、
 * 超时关单、送达兜底、对账巡检都不需要真的等到那一天。
 *
 * 为什么从 LedgerModule 搬到独立模块：
 *   五类任务里有两类（超时关单 / 送达兜底 / 对账巡检）属于**订单域**，
 *   而 OrderModule 已经 import 了 LedgerModule。把调度器留在账本模块里，
 *   就会形成 Ledger → Order → Ledger 的循环。调度器**跨域**，
 *   所以它应该站在两个域之上，而不是塞进其中一个。
 *
 * 三条工程纪律：
 *   ① **幂等靠业务层**，不靠调度层加锁 —— 进程重启、重复触发、多实例并发
 *      都不该把钱扣两次（(runDate, tenantCode) 唯一键、orderNo 幂等）。
 *   ② **频繁任务不刷屏**：每分钟跑的任务在没有动作时不写运行记录，
 *      否则一天 2880 条会把真正要看的那条埋掉。
 *   ③ **失败一定留痕**：无论频繁与否，抛错必须写一条 ok=false 的记录 ——
 *      静默失败的任务等于没跑，而"没跑"最贵。
 */
@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private timers: NodeJS.Timeout[] = [];
  /** 最近一次每日扣减的业务日（防重复触发） */
  private lastSettlementDate: string | null = null;
  /** 最近一次账单生成的账期（按月） */
  private lastStatementPeriod: string | null = null;
  private lastPatrolAt = 0;

  constructor(
    private readonly ledger: LedgerService,
    private readonly orders: OrderService,
    @Inject(REPO_FACTORY) private readonly repos: RepoFactory,
    private readonly logger: AppLogger,
  ) {}

  private get platform() {
    return this.repos.platform();
  }

  onModuleInit(): void {
    if (!env.jobsEnabled) {
      this.logger.log('jobs', { msg: '定时任务已关闭（JOBS_ENABLED=false）' });
      return;
    }
    // 每分钟醒一次：够便宜，也够准（年粒度任务差几十秒无所谓）
    const t = setInterval(() => {
      void this.tick().catch((e) => this.logger.error('jobs.tick 失败', { msg: String(e?.message ?? e) }));
    }, 60_000);
    t.unref?.();
    this.timers.push(t);
    this.logger.log('jobs', { msg: `定时任务已启动：每日扣减 ${env.settlementHour}:00 · 巡检每 ${env.patrolIntervalMinutes} 分钟（中国时区）` });
  }

  onModuleDestroy(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /* ========================================================================
   * 调度心跳
   * ======================================================================*/

  async tick(now: Date = new Date()): Promise<void> {
    const localHour = localHourOf(now);

    // 每日一次
    if (localHour >= env.settlementHour && this.lastSettlementDate !== LedgerService.bizDate(now)) {
      await this.run('daily_settlement', now, 'schedule');
    }

    // 每分钟：超时关单 / 送达兜底。越及时越好，且没有动作时不写记录
    await this.run('close_expired', now, 'schedule');
    await this.run('auto_complete', now, 'schedule');

    // 周期巡检：到期提醒 + 对账巡检
    if (now.getTime() - this.lastPatrolAt >= env.patrolIntervalMinutes * 60_000) {
      this.lastPatrolAt = now.getTime();
      await this.run('expiry_reminder', now, 'schedule');
      await this.run('reconcile_patrol', now, 'schedule');
    }

    // 每月一次：生成上月账单（1 号之后第一次心跳）
    const period = LedgerService.prevPeriod(now);
    if (localDayOfMonth(now) >= 1 && localHour >= env.settlementHour && this.lastStatementPeriod !== period) {
      await this.run('statement_build', now, 'schedule');
    }
  }

  /* ========================================================================
   * 单一入口：跑某一类任务（手工与调度共用）
   * ======================================================================*/

  async run(
    kind: JobKind,
    now: Date = new Date(),
    trigger: 'schedule' | 'manual' = 'manual',
  ): Promise<{ kind: JobKind; ok: boolean; summary: string; detail: unknown }> {
    const startedAt = new Date().toISOString();
    try {
      const { summary, detail, acted } = await this.dispatch(kind, now);
      const freq = kind === 'close_expired' || kind === 'auto_complete';
      // 频繁任务在没有动作时不留痕（一天 2880 条会把真正要看的那条埋掉）
      if (!freq || acted) {
        await this.record({ kind, trigger, startedAt, ok: true, summary, detail, error: null });
      }
      return { kind, ok: true, summary, detail };
    } catch (e) {
      const error = String((e as Error)?.message ?? e);
      // 失败**无论如何**都留痕
      await this.record({ kind, trigger, startedAt, ok: false, summary: '任务失败', detail: null, error });
      this.logger.error(`jobs.${kind} 失败`, { msg: error });
      return { kind, ok: false, summary: '任务失败', detail: { error } };
    }
  }

  /** 跑全部任务（`all` 的语义只给手工触发用：验收要一次看全） */
  async runAll(now: Date = new Date(), trigger: 'schedule' | 'manual' = 'manual') {
    const kinds: JobKind[] = ['daily_settlement', 'close_expired', 'auto_complete', 'expiry_reminder', 'reconcile_patrol', 'statement_build'];
    const results = [];
    for (const k of kinds) results.push(await this.run(k, now, trigger));
    return results;
  }

  private async dispatch(kind: JobKind, now: Date): Promise<{ summary: string; detail: unknown; acted: boolean }> {
    switch (kind) {
      case 'daily_settlement': {
        const r = await this.ledger.runDailySettlement(now);
        this.lastSettlementDate = r.runDate;
        return {
          summary: `扣减 ${r.settled} 家 · 服务费 ¥${(r.totalFeeCents / 100).toFixed(2)}`,
          // detail 保留账本原始出参：老接口（`{ settlement: ... }`）直接把它吐回去，
          // 中间不再做一次字段搬运 —— 搬运一次就多一处会漏字段的地方
          detail: r,
          acted: true,
        };
      }

      case 'close_expired': {
        const tenants = await this.platform.listTenants();
        const closed: Array<{ tenantCode: string; orderNo: string }> = [];
        for (const t of tenants) {
          if (t.status === 'suspended') continue;
          const r = await this.orders.closeExpired(t.tenantCode, now);
          for (const orderNo of r.closed) closed.push({ tenantCode: t.tenantCode, orderNo });
        }
        return {
          summary: closed.length ? `关闭超时未支付 ${closed.length} 单` : '无超时订单',
          detail: { closed },
          acted: closed.length > 0,
        };
      }

      case 'auto_complete': {
        const tenants = await this.platform.listTenants();
        const completed: Array<{ tenantCode: string; orderNo: string }> = [];
        for (const t of tenants) {
          if (t.status === 'suspended') continue;
          const r = await this.orders.autoCompleteStuck(t.tenantCode, now);
          for (const orderNo of r.completed) completed.push({ tenantCode: t.tenantCode, orderNo });
        }
        return {
          summary: completed.length ? `兜底完成 ${completed.length} 单（商户忘点送达）` : '无滞留配送中订单',
          detail: { completed },
          acted: completed.length > 0,
        };
      }

      case 'expiry_reminder': {
        const status = await this.ledger.refreshSubscriptionStatus(now);
        const reminders = await this.ledger.collectSubscriptionReminders(now);
        return {
          summary: reminders.length ? `到期提醒 ${reminders.length} 条` : '无临近到期租户',
          // 明细原样保留（含数组），老接口 `{ patrol: {expired, expiring, reminders} }` 直接复用
          detail: { ...status, reminders },
          acted: true,
        };
      }

      case 'reconcile_patrol': {
        const tenants = await this.platform.listTenants();
        const perTenant: Array<{ tenantCode: string; scanned: number; repaired: number; orphans: number }> = [];
        let repairedTotal = 0;
        let orphansTotal = 0;

        for (const t of tenants) {
          const r = await this.orders.patrolPaidIntegrity(t.tenantCode, now);
          repairedTotal += r.repairs.length;
          orphansTotal += r.orphanPays.length;
          perTenant.push({ tenantCode: t.tenantCode, scanned: r.scanned, repaired: r.repairs.length, orphans: r.orphanPays.length });

          // 孤儿支付逐笔进告警：每一笔都是**真金白银**，一笔一条不嫌多。
          // 用 pay_anomaly 这个既有分类，不新开第六类 —— 它就是支付异常。
          for (const o of r.orphanPays) {
            await this.platform.raiseAlert({
              tenantCode: t.tenantCode,
              kind: 'pay_anomaly',
              level: 'danger',
              title: `${t.shopName} 收到一笔 ¥${(o.amountCents / 100).toFixed(2)} 的付款，但没有对应订单`,
              detail:
                `订单号 ${o.orderNo} · 支付流水号 ${o.txnId}。` +
                '可能成因：订单被误删 / 回调串了租户 / 伪造回调 —— 三者无法自动区分，需凭流水号到微信侧核对后人工补录。',
              dedupeKey: `orphan_pay:${t.tenantCode}:${o.txnId}`,
            });
          }

          // 自愈成功也要有痕迹（写在运行记录里，不发告警 —— 已经自己好了就别吵人）
          if (r.repairs.length) {
            this.logger.warn('对账巡检自愈完成', { tenantCode: t.tenantCode, repairs: r.repairs });
          }
        }

        return {
          summary:
            `巡检 ${tenants.length} 家 · 自愈 ${repairedTotal} 单` + (orphansTotal ? ` · **孤儿支付 ${orphansTotal} 笔**` : ''),
          detail: { perTenant },
          // 自愈和孤儿都算"有动作"：哪怕只是自愈了也要留痕，便于回答"昨天巡检干了什么"
          acted: true,
        };
      }

      case 'statement_build': {
        const period = LedgerService.prevPeriod(now);
        const r = await this.ledger.buildAllStatements(period);
        this.lastStatementPeriod = period;
        return {
          summary: `生成 ${r.period} 账单 ${r.items.length} 份` + (r.diffCount ? ` · ${r.diffCount} 份有差额` : ''),
          detail: r,
          acted: true,
        };
      }
    }
  }

  private async record(input: Omit<JobRunRecord, 'id' | 'finishedAt'>): Promise<void> {
    await this.platform.appendJobRun({ ...input, finishedAt: new Date().toISOString() });
  }

  /* ========================================================================
   * 向后兼容的旧形状（S2 起就在用）
   * ----------------------------------------------------------------------
   * 任务从账本模块搬到独立模块、kind 从两种扩到六种，但**调用方看到的形状不变**：
   * 运维手册里的 curl、监控探针、验收脚本都不该因为一次"实现层搬家"而改。
   * 这些方法就是那层薄薄的适配，它们是**有意的技术债**，不是遗留。
   * ======================================================================*/

  /** 旧形状：`{ runDate, settled, skipped, totalFeeCents, ... }` */
  async runDailySettlement(now: Date = new Date()) {
    const r = await this.run('daily_settlement', now, 'manual');
    return r.detail as Awaited<ReturnType<LedgerService['runDailySettlement']>>;
  }

  /** 旧形状：`{ expired, expiring, reminders }` */
  async runPatrol(now: Date = new Date()) {
    const r = await this.run('expiry_reminder', now, 'manual');
    return r.detail as { expired: string[]; expiring: string[]; reminders: Array<Record<string, unknown>> };
  }

  /** 旧形状的任务看板：`{ enabled, settlementHour, lastSettlementDate, history }` */
  async recentRuns() {
    const runs = await this.platform.listJobRuns({ limit: 50 });
    return {
      enabled: env.jobsEnabled,
      settlementHour: env.settlementHour,
      lastSettlementDate: this.lastSettlementDate,
      history: runs.map((r) => ({ at: r.finishedAt ?? r.startedAt, kind: r.kind, summary: r.detail ?? r.summary, ok: r.ok })),
    };
  }

  /* ========================================================================
   * 任务看板
   * ======================================================================*/

  /**
   * 后台「任务看板」直接读它。
   *
   * `scheduleState` 单列出来是有意的：**手工跑绿了不等于定时任务正常**。
   * 运维最容易被这个骗到 —— 手动点一次全绿，然后线上其实一次都没跑过
   * （比如进程启动后 `tick` 抛了错，但没人看日志）。
   */
  async board(opts: { kind?: JobKind; limit?: number } = {}) {
    const runs = await this.platform.listJobRuns({ kind: opts.kind, limit: opts.limit ?? 50 });
    const recent = runs.slice(0, 100);
    const failures = recent.filter((r) => !r.ok);
    return {
      enabled: env.jobsEnabled,
      settlementHour: env.settlementHour,
      patrolIntervalMinutes: env.patrolIntervalMinutes,
      scheduleState: {
        lastSettlementDate: this.lastSettlementDate,
        lastStatementPeriod: this.lastStatementPeriod,
        lastPatrolAt: this.lastPatrolAt ? new Date(this.lastPatrolAt).toISOString() : null,
        /** 调度器是否真的在跑（JOBS_ENABLED=false 时为 false） */
        ticking: env.jobsEnabled,
      },
      counts: { total: recent.length, failed: failures.length },
      runs,
    };
  }
}

/* ------------------------------------------------------------------ 工具 */

/** 中国时区的小时（服务器多为 UTC，直接取 getHours 会把扣减挪到前一天） */
function localHourOf(now: Date): number {
  return new Date(now.getTime() + 480 * 60_000).getUTCHours();
}
function localDayOfMonth(now: Date): number {
  return new Date(now.getTime() + 480 * 60_000).getUTCDate();
}
