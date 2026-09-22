import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { REPO_FACTORY } from '../core/repo.factory';
import type { PlatformRepo, RepoFactory } from '../core/repository';
import { LedgerService } from './ledger.service';
import { TenantService } from '../platform/tenant.service';

/**
 * 平台侧账本路由（我方视角）。
 * 权限：TenantRouterMiddleware 的 x-platform-key（上线前换账号体系 + RBAC）。
 *
 * 这里能做的三件事，恰好对应"唯一的收钱通道"：
 *   ① 给商户充值 / 调整余额（钱进来）
 *   ② 手动跑一次结算（钱扣出去，正常由定时任务做）
 *   ③ 看对账结果（钱对不对得上）
 *
 * 定时任务的入口（`/ledger/jobs/*`）在 S7 搬到 `jobs.controller.ts`，
 * **URL 一字未改** —— 实现换模块不该让运维手册和监控探针跟着改。
 */
@Controller('api/platform/ledger')
export class PlatformLedgerController {
  constructor(
    private readonly ledger: LedgerService,
    private readonly tenants: TenantService,
    @Inject(REPO_FACTORY) private readonly repos: RepoFactory,
  ) {}

  private get platform(): PlatformRepo {
    return this.repos.platform();
  }

  /** 两个账本状态同屏：订阅剩余天数 + 余额（验收 V2-8） */
  @Get('overview')
  async overview() {
    const items = await this.tenants.listTenantsWithGates();
    return {
      items,
      summary: {
        total: items.length,
        balanceBlocked: items.filter((i) => i.gates.balanceTone === 'danger').length,
        subscriptionExpiring: items.filter((i) => i.gates.subscriptionDaysLeft !== null && i.gates.subscriptionDaysLeft <= 7).length,
      },
    };
  }

  /* ---------------------------------------------------------------- 对账看板（S7） */

  /**
   * 平台对账看板：一屏看完所有租户"钱对不对得上"。
   *
   * ⚠️ **必须声明在 `@Get(':tenantCode')` 之前** —— 否则 `reconcile-board`
   * 会被当成租户编码吃掉，然后报 `TENANT_NOT_FOUND: 租户不存在：reconcile-board`。
   * 这种错很像业务错，实际是路由顺序错，排障时会先怀疑租户表。
   */
  @Get('reconcile-board')
  async reconcileBoard(@Query('now') now?: string) {
    return this.ledger.platformReconcileBoard(now ? new Date(now) : new Date());
  }

  /** 账期账单批量生成（定时任务 `statement_build` 的手工口） */
  @Post('statements/build')
  @HttpCode(200)
  async buildStatements(@Body() body: { period?: string; now?: string }) {
    const period = body?.period ?? LedgerService.prevPeriod(body?.now ? new Date(body.now) : new Date());
    return this.ledger.buildAllStatements(period);
  }

  /** 孤儿支付清单（收到钱但没有订单）—— 逐笔人工核查的唯一入口 */
  @Get('orphan-pays')
  async orphanPays(@Query('tenantCode') tenantCode?: string, @Query('status') status?: 'open' | 'resolved') {
    const items = await this.platform.listOrphanPays({ tenantCode, status, limit: 500 });
    return { items, open: items.filter((i) => i.status === 'open').length };
  }

  /** 结清一条孤儿支付（**必须写处理说明**，否则等于把异常抹掉） */
  @Post('orphan-pays/:id/resolve')
  @HttpCode(200)
  async resolveOrphanPay(@Param('id') id: string, @Body() body: { operator?: string; note?: string }) {
    return this.platform.resolveOrphanPay(Number(id), body?.operator ?? 'platform', body?.note ?? '');
  }

  /** 充值（手动入账；将来接微信支付商户平台回调时走同一入口） */
  @Post(':tenantCode/topup')
  @HttpCode(200)
  async topup(
    @Param('tenantCode') tenantCode: string,
    @Body() body: { amountYuan?: number; amountCents?: number; remark?: string; operator?: string },
  ) {
    const cents = body.amountCents ?? Math.round(Number(body.amountYuan ?? 0) * 100);
    const r = await this.ledger.topup(tenantCode, cents, {
      operator: body.operator ?? 'platform',
      remark: body.remark ?? null,
      source: 'manual',
    });
    return { txn: r.txn, wallet: r.wallet, unfrozen: r.unfrozen };
  }

  /** 人工调整 —— 必须带理由，钱说不清等于账有问题 */
  @Post(':tenantCode/adjust')
  @HttpCode(200)
  async adjust(
    @Param('tenantCode') tenantCode: string,
    @Body() body: { amountCents: number; reason: string; operator: string },
  ) {
    return { txn: await this.ledger.adjust(tenantCode, body.amountCents, body.reason, body.operator) };
  }

  /**
   * 「支付成功 → 写待扣记录」的落地入口。
   *
   * ⚠️ 这是**内部接口**，由支付回调（S4 的订单支付回调）调用，不是给前端调的。
   * 之所以提前到 S2 就存在：待扣登记是账本的起点，没有它整条扣减链路无从验证。
   * 幂等由 orderNo 保证 —— 支付回调重复推送 10 次也只登记 1 条。
   */
  @Post(':tenantCode/orders/paid')
  @HttpCode(200)
  async markPaid(
    @Param('tenantCode') tenantCode: string,
    @Body() body: { orderNo: string; amountCents: number; buildingCode?: string | null; paidAt?: string },
  ) {
    const order = await this.ledger.recordPaidOrder(tenantCode, {
      orderNo: body.orderNo,
      amountCents: body.amountCents,
      buildingCode: body.buildingCode ?? null,
      paidAt: body.paidAt ? new Date(body.paidAt) : undefined,
    });
    return { order };
  }

  /** 退款落地：服务费只对"真正退回去的钱"返还 */
  @Post(':tenantCode/orders/:orderNo/refund')
  @HttpCode(200)
  async refund(
    @Param('tenantCode') tenantCode: string,
    @Param('orderNo') orderNo: string,
    @Body() body: { refundCents: number; operator?: string },
  ) {
    return this.ledger.refundOrder(tenantCode, {
      orderNo,
      refundCents: body.refundCents,
      operator: body.operator ?? 'platform',
    });
  }

  /** 续期（服务期延长 + 清零提醒位） */
  @Post(':tenantCode/subscription/renew')
  @HttpCode(200)
  async renew(
    @Param('tenantCode') tenantCode: string,
    @Body() body: { periodEnd?: string; operator?: string },
  ) {
    return this.ledger.renewSubscription(tenantCode, {
      periodEnd: body?.periodEnd ? new Date(body.periodEnd) : undefined,
      operator: body?.operator ?? 'platform',
    });
  }

  /** 订阅提醒发放状态（还会再提醒几次） */
  @Get(':tenantCode/subscription/notify-state')
  async notifyState(@Param('tenantCode') tenantCode: string) {
    return this.ledger.subscriptionNotifyState(tenantCode);
  }

  /** 商户账本全景（平台排障用）：余额 / 订阅 / 待扣 / 流水 / 结算批次 */
  @Get(':tenantCode')
  async detail(@Param('tenantCode') tenantCode: string, @Query('txnLimit') txnLimit?: string) {
    return this.ledger.billingView(tenantCode, { txnLimit: txnLimit ? Number(txnLimit) : 50 });
  }

  /** 待扣队列（尚未扣服务费的订单）—— 对账前先看这里，能不能对上先看它 */
  @Get(':tenantCode/pending')
  async pending(@Param('tenantCode') tenantCode: string) {
    return this.ledger.pendingFees(tenantCode);
  }

  /**
   * 账本自洽核对（差额必须为 0）。
   * 这是"分毫不差"的可执行定义：余额 == 全部流水求和。
   */
  @Get(':tenantCode/reconcile')
  async reconcile(@Param('tenantCode') tenantCode: string) {
    return this.ledger.reconcile(tenantCode);
  }

  /** 手动跑某租户某天的结算（幂等） */
  @Post(':tenantCode/settle')
  @HttpCode(200)
  async settle(@Param('tenantCode') tenantCode: string, @Body() body: { runDate?: string }) {
    const runDate = body?.runDate ?? LedgerService.bizDate(new Date());
    return this.ledger.settle(tenantCode, runDate, { source: 'manual', operator: 'platform' });
  }

  /** 展开某结算批次覆盖了哪些订单 —— 「明细可回链订单」的那一跳 */
  @Get(':tenantCode/runs/:runId/orders')
  async runOrders(@Param('tenantCode') tenantCode: string, @Param('runId') runId: string) {
    return this.ledger.expandRun(tenantCode, Number(runId));
  }

  /** 账期账单（差额 ≠0 必须标红） */
  @Get(':tenantCode/statements')
  async statements(@Param('tenantCode') tenantCode: string, @Query('period') period?: string) {
    if (period) return { statement: await this.ledger.buildStatement(tenantCode, period) };
    return { items: await this.ledger.listStatements(tenantCode) };
  }
}
