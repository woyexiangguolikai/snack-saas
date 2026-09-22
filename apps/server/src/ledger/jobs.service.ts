import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { LedgerService } from './ledger.service';
import { AppLogger } from '../core/logger';
import { env } from '../core/env';

/**
 * 定时任务调度器。
 *
 * 刻意的设计：**这里只有"什么时候跑"，没有"跑什么"。**
 * 真正的业务逻辑全在 LedgerService 里，且每个方法都接受 `now` 参数 ——
 * 于是每个任务都能在测试里被"手动拨表跑一次"，跨日扣减、15/7/3 提醒
 * 都不需要真的等到那一天。定时器只是触发方式之一。
 *
 * 幂等完全靠业务层（(runDate, tenantCode) 唯一键、notifyFlags 记位），
 * 所以进程重启、重复触发、多实例并发都不会把钱扣两次 —— 调度层不需要额外锁。
 */
@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private timers: NodeJS.Timeout[] = [];
  private lastSettlementDate: string | null = null;
  private lastPatrolAt = 0;
  /** 最近一次运行结果：后台「任务看板」直接读它，而不是去翻日志 */
  private readonly history: Array<{ at: string; kind: string; summary: unknown }> = [];

  constructor(
    private readonly ledger: LedgerService,
    private readonly logger: AppLogger,
  ) {}

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
    this.logger.log('jobs', { msg: `定时任务已启动，每日扣减时刻 ${env.settlementHour}:00（中国时区）` });
  }

  onModuleDestroy(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** 调度心跳：先判断"该不该跑"，再调业务层 */
  async tick(now: Date = new Date()): Promise<void> {
    if (this.shouldRunSettlement(now)) {
      const r = await this.runDailySettlement(now);
      this.logger.log('jobs.settlement', { runDate: r.runDate, feeCents: r.totalFeeCents, tenants: r.tenants });
    }
    if (now.getTime() - this.lastPatrolAt >= env.patrolIntervalMinutes * 60_000) {
      this.lastPatrolAt = now.getTime();
      const r = await this.runPatrol(now);
      if (r.reminders.length) this.logger.log('jobs.reminders', { count: r.reminders.length });
    }
  }

  private shouldRunSettlement(now: Date): boolean {
    // 业务日与"当地时间的小时"都按中国时区算，避免服务器 UTC 时区把扣减挪到前一天
    const localHour = new Date(now.getTime() + 480 * 60_000).getUTCHours();
    const today = LedgerService.bizDate(now);
    if (localHour < env.settlementHour) return false;
    return this.lastSettlementDate !== today;
  }

  /** 手动/定时执行每日扣减。重复调用是安全的（结算批次唯一键兜底）。 */
  async runDailySettlement(now: Date = new Date()) {
    const r = await this.ledger.runDailySettlement(now);
    this.lastSettlementDate = r.runDate;
    this.record('dailySettlement', { runDate: r.runDate, settled: r.settled, skipped: r.skipped, feeCents: r.totalFeeCents });
    return r;
  }

  /** 巡检：订阅到期状态刷新 + 15/7/3 提醒收集（提醒的"发送"在 S6 接微信通知） */
  async runPatrol(now: Date = new Date(), consumeReminders = true) {
    const status = await this.ledger.refreshSubscriptionStatus(now);
    const reminders = await this.ledger.collectSubscriptionReminders(now);
    this.record('patrol', { expired: status.expired.length, expiring: status.expiring.length, reminders: reminders.length });
    return { ...status, reminders };
  }

  private record(kind: string, summary: unknown): void {
    this.history.unshift({ at: new Date().toISOString(), kind, summary });
    if (this.history.length > 50) this.history.length = 50;
  }

  /** 任务看板：最近运行记录（失败的任务也必须看得见，否则断链是静默的） */
  recentRuns() {
    return { enabled: env.jobsEnabled, settlementHour: env.settlementHour, lastSettlementDate: this.lastSettlementDate, history: this.history };
  }
}
