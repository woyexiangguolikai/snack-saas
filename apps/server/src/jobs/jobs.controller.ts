import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import type { JobKind } from '../core/repository';
import { JobsService } from './jobs.service';

const ALL_KINDS: JobKind[] = [
  'daily_settlement',
  'close_expired',
  'auto_complete',
  'expiry_reminder',
  'reconcile_patrol',
  'statement_build',
];

/**
 * 定时任务的后台入口（P-04 任务看板）。
 *
 * **路径与 S2 时期完全一致**（`/api/platform/ledger/jobs/*`）：
 * 任务从账本模块搬到了独立模块，但 URL 没变 —— 换 URL 意味着
 * 已经写好的运维手册、监控探针、验收脚本全部要跟着改，而这次搬迁
 * 对调用方是**零语义变化**的。接口的稳定性和实现的组织方式不该绑在一起。
 */
@Controller('api/platform/ledger/jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  /**
   * 手动触发。`now` 可注入 → 验收不用等一天（跨日扣减、15/7/3 提醒、
   * 送达兜底都能当场验证）。
   *
   * `kind` 省略 = `all`。**兼收两个历史别名**：
   *   · `settlement` → `daily_settlement`
   *   · `patrol`     → `expiry_reminder`
   * 老写法返回**老形状**（`{ settlement, patrol }`），新写法返回 `{ results }`。
   * 这样运维手册里的 curl 和既有验收脚本都不用改。
   */
  @Post('run')
  @HttpCode(200)
  async run(
    @Body()
    body: { kind?: JobKind | 'all' | 'settlement' | 'patrol'; now?: string; trigger?: 'schedule' | 'manual' } = {},
  ) {
    const now = body.now ? new Date(body.now) : new Date();
    const trigger = body.trigger ?? 'manual';
    const kind = body.kind ?? 'all';
    const stamp = { now: now.toISOString() };

    // ---- 历史别名：返回老形状 ------------------------------------------------
    if (kind === 'settlement') return { ...stamp, settlement: await this.jobs.runDailySettlement(now) };
    if (kind === 'patrol') return { ...stamp, patrol: await this.jobs.runPatrol(now) };
    if (kind === 'all') {
      // `all` 同时给老形状与新形状：老字段供既有脚本，results 供新看板。
      // 每个任务**只跑一次**，老字段从 results 里取，不重复触发。
      const results = await this.jobs.runAll(now, trigger);
      const settlement = results.find((r) => r.kind === 'daily_settlement')?.detail;
      const patrol = results.find((r) => r.kind === 'expiry_reminder')?.detail;
      return { ...stamp, settlement, patrol, results };
    }
    if (!ALL_KINDS.includes(kind)) {
      return { error: `未知任务：${kind}`, known: ALL_KINDS };
    }
    return { ...stamp, results: [await this.jobs.run(kind, now, trigger)] };
  }

  /** 任务看板：最近运行记录 + 调度器状态（**手工跑绿 ≠ 定时任务正常**） */
  @Get('status')
  async status(@Query('kind') kind?: JobKind, @Query('limit') limit?: string) {
    const [board, legacy] = await Promise.all([
      this.jobs.board({ kind, limit: limit ? Number(limit) : undefined }),
      this.jobs.recentRuns(),
    ]);
    // `history` 是 S2 起的旧字段名，保留它同样是为了不动既有脚本
    return { ...board, lastSettlementDate: legacy.lastSettlementDate, history: legacy.history };
  }

  /** 五类任务的清单（前端"手动跑一次"的按钮就是按它渲染的，不写死在页面里） */
  @Get('kinds')
  kinds() {
    return {
      items: ALL_KINDS.map((k) => ({ kind: k, label: KIND_LABEL[k] })),
    };
  }
}

const KIND_LABEL: Record<JobKind, string> = {
  daily_settlement: '每日汇总扣减',
  close_expired: '超时关单',
  auto_complete: '送达自动完成兜底',
  expiry_reminder: '到期 15/7/3 提醒',
  reconcile_patrol: '对账巡检（支付成功但订单没走完 / 孤儿支付）',
  statement_build: '账期账单生成',
};
