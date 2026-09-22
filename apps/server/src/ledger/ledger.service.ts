import { Inject, Injectable } from '@nestjs/common';
import { ERR, BizError } from '../core/errors';
import { REPO_FACTORY } from '../core/repo.factory';
import type { OrderSummaryRecord, PlatformRepo, RepoFactory, SettlementRunRecord, WalletTxnRecord } from '../core/repository';
import {
  CENTS,
  FEE_BP,
  SUBSCRIPTION_WARN_DAYS,
  feeOfCents,
  type LedgerReconcile,
  type ReceivableItem,
  type StatementRecord,
  type SubscriptionReminder,
  type SubscriptionRecord,
  type WalletRecord,
} from '../core/types';
import { CHINA_TZ_OFFSET_MINUTES } from '../core/time-window';
import { COPY } from './copy';

/**
 * LedgerService —— 双账本（订阅 + 余额）。**这是我方唯一的收钱通道**，
 * 所以这里的每一条规则都按"钱不能错"来写，而不是按"功能能跑"。
 *
 * 三条贯穿全文件的设计决定：
 *
 * 1) **扣费不是一单一写，而是"当日汇总、次日扣减"。**
 *    支付成功只登记待扣记录（order_summary.status='paid'）；
 *    每日任务把当天所有待扣订单汇总成 1 条 fee 流水。
 *    好处：流水条数 = 天数而不是订单数（商户对账看得懂）；
 *    代价：明细要能展开 → 所以每条 fee 流水带 runId，能回到 settlement_run 再展开到每一笔订单。
 *    这也是为什么"每笔扣费必须能回链订单"不是靠流水本身，而是靠这两跳。
 *
 * 2) **幂等键放在业务语义上，不放在"调用方会不会重复调"上。**
 *    orderNo 全局唯一 → 支付回调重复 10 次只登记 1 条；
 *    (runDate, tenantCode) 唯一 → 每日任务重复跑不会扣第二次。
 *
 * 3) **余额与流水一起写。** appendWalletTxn 同时更新 balance 快照，
 *    所以"余额 == 流水求和"是可以被逐条验证的不变量，而不是信念。
 *
 * 铁律：**措辞一律取自 copy.ts**。这里不手写面向商户的句子。
 */
@Injectable()
export class LedgerService {
  constructor(@Inject(REPO_FACTORY) private readonly repos: RepoFactory) {}

  private get platform(): PlatformRepo {
    return this.repos.platform();
  }

  /** 中国时区的自然日 YYYY-MM-DD（存储层是 UTC，业务日是本地日） */
  static bizDate(at: Date, tzOffsetMinutes = CHINA_TZ_OFFSET_MINUTES): string {
    return new Date(at.getTime() + tzOffsetMinutes * 60_000).toISOString().slice(0, 10);
  }

  /** 某个业务日的起点（UTC 时刻）。用于把"当日"变成一条可比较的边界。 */
  static bizDayStart(at: Date, tzOffsetMinutes = CHINA_TZ_OFFSET_MINUTES): Date {
    const local = new Date(at.getTime() + tzOffsetMinutes * 60_000);
    const midnightUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
    return new Date(midnightUtc - tzOffsetMinutes * 60_000);
  }

  /** 'YYYY-MM-DD' → 该业务日起点 */
  static bizDayStartOf(runDate: string, tzOffsetMinutes = CHINA_TZ_OFFSET_MINUTES): Date {
    const [y, m, d] = runDate.split('-').map(Number);
    return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) - tzOffsetMinutes * 60_000);
  }

  /* ============================================================ 一、待扣登记 */

  /**
   * 支付成功 → 登记待扣记录。
   * 必须在支付回调里调用；重复回调不会重复登记（幂等）。
   * 只登记不动钱 —— 这样"商户看到的扣费"永远是"昨天的成交"，可预期、可核对。
   */
  async recordPaidOrder(
    tenantCode: string,
    input: { orderNo: string; amountCents: number; buildingCode?: string | null; paidAt?: Date },
  ): Promise<OrderSummaryRecord> {
    if (!Number.isInteger(input.amountCents) || input.amountCents < 0) {
      throw new BizError(ERR.VALIDATION_FAILED, '订单金额必须为非负整数分');
    }
    if (!input.orderNo) throw new BizError(ERR.VALIDATION_FAILED, '缺少订单号');
    return this.platform.recordPaidOrder({
      tenantCode,
      orderNo: input.orderNo,
      amountCents: input.amountCents,
      buildingCode: input.buildingCode ?? null,
      paidAt: input.paidAt ?? new Date(),
    });
  }

  /** 待扣队列（商户账单页的"待结算"区） */
  async pendingFees(tenantCode: string): Promise<{ items: ReceivableItem[]; totalFeeCents: number; orderCount: number }> {
    const rows = await this.platform.listPendingOrders(tenantCode);
    const items: ReceivableItem[] = rows.map((o) => ({
      orderNo: o.orderNo,
      amountCents: o.amountCents,
      feeCents: o.feeCents,
      paidAt: o.paidAt,
      buildingCode: o.buildingCode,
    }));
    return {
      items,
      totalFeeCents: items.reduce((s, i) => s + i.feeCents, 0),
      orderCount: items.length,
    };
  }

  /* ============================================================ 二、每日扣减 */

  /**
   * 结算某租户"runDate 这一天开始之前"的全部待扣订单。
   * 幂等：同一天重复调用直接返回已有批次，不会扣第二次。
   *
   * `before` 为什么必须显式：
   *   如果不传就扫全部待扣，那么"每日任务在几点跑"会改变扣减结果 ——
   *   凌晨 1 点跑扣的是昨天的单，下午 3 点补跑就会把今天的单一起扣了。
   *   所以默认值取 runDate 的业务日起点，让"跨日扣减"字面上成立：
   *   今天产生的订单，今天不会被扣。
   */
  async settle(
    tenantCode: string,
    runDate: string,
    opts: { before?: Date; source?: WalletTxnRecord['source']; operator?: string | null } = {},
  ): Promise<{ run: SettlementRunRecord; txn: WalletTxnRecord | null; orderNos: string[]; skipped: boolean }> {
    const before = opts.before ?? LedgerService.bizDayStartOf(runDate);
    const existing = await this.platform.findSettlementRun(tenantCode, runDate);
    if (existing) {
      const orderNos = (await this.platform.listOrdersByRun(tenantCode, existing.id)).map((o) => o.orderNo);
      return { run: existing, txn: null, orderNos, skipped: true };
    }

    const pending = await this.platform.listPendingOrders(tenantCode, before);

    if (!pending.length) {
      // 没有待扣也要落一条批次记录：否则"今天到底跑没跑"在后台看不出来
      const run = await this.platform.createSettlementRun({
        runDate,
        tenantCode,
        orderCount: 0,
        gmvCents: 0,
        feeCents: 0,
        status: 'done',
        failReason: null,
      });
      return { run, txn: null, orderNos: [], skipped: false };
    }

    const gmvCents = pending.reduce((s, o) => s + o.amountCents, 0);
    // 逐单四舍五入再求和 —— 不是对总额算 2%。
    // 两者在多数情况相同，但"每笔订单各自计费"才是商户能自己验算的口径。
    const feeCents = pending.reduce((s, o) => s + o.feeCents, 0);

    const run = await this.platform.createSettlementRun({
      runDate,
      tenantCode,
      orderCount: pending.length,
      gmvCents,
      feeCents,
      status: 'pending',
      failReason: null,
    });

    // 先扣钱、再标记订单已结算。
    // 顺序反过来的话，钱扣失败时订单已经被标记 settled，那笔服务费就永久丢了。
    const txn = await this.platform.appendWalletTxn({
      tenantCode,
      type: 'fee',
      amountCents: -feeCents,
      runId: run.id,
      source: opts.source ?? 'job',
      operator: opts.operator ?? null,
      remark: `${run.runDate} 汇总 ${pending.length} 笔订单服务费（${FEE_BP / 100}%）`,
      // 流水时间钉在边界前 1 秒：这样"流水按业务日归属"与"账单按业务日归属"永远一致
      createdAt: new Date(before.getTime() - 1000),
    });

    const orderNos = pending.map((o) => o.orderNo);
    await this.platform.markOrdersSettled(tenantCode, orderNos, run.id, before);
    const done = await this.platform.updateSettlementRun(run.id, { status: 'done' });

    return { run: done, txn, orderNos, skipped: false };
  }

  /**
   * 每日汇总扣减任务：遍历全部租户。
   * `now` 可注入 —— 这样"跨日"能在测试里被真实跑出来，而不是等一天。
   */
  async runDailySettlement(now: Date = new Date()): Promise<{
    runDate: string;
    tenants: number;
    settled: number;
    skipped: number;
    totalFeeCents: number;
    details: Array<{ tenantCode: string; orderCount: number; feeCents: number; skipped: boolean; balanceAfterCents: number }>;
  }> {
    const runDate = LedgerService.bizDate(now);
    const tenants = await this.platform.listTenants();

    let settled = 0;
    let skipped = 0;
    let totalFeeCents = 0;
    const details: Array<{ tenantCode: string; orderCount: number; feeCents: number; skipped: boolean; balanceAfterCents: number }> = [];

    for (const t of tenants) {
      const r = await this.settle(t.tenantCode, runDate, { source: 'job' });
      if (r.skipped) skipped++;
      else settled++;
      totalFeeCents += r.run.feeCents;
      const w = await this.platform.getWallet(t.tenantCode);
      details.push({
        tenantCode: t.tenantCode,
        orderCount: r.run.orderCount,
        feeCents: r.run.feeCents,
        skipped: r.skipped,
        balanceAfterCents: w?.balanceCents ?? 0,
      });
    }

    return { runDate, tenants: tenants.length, settled, skipped, totalFeeCents, details };
  }

  /* ============================================================ 三、退款返还 */

  /**
   * 退款落地：**服务费只对"真正退回去的钱"返还**。
   * - 该订单的服务费还没扣（status='paid'）→ 直接出队，不产生任何流水
   *   （钱没扣过就不能"返还"，否则余额会凭空多出来）
   * - 已扣（status='settled'）→ 按本次退款额返还服务费，写 type='refund' 流水，
   *   并带 refOrderNo 回链订单
   */
  async refundOrder(
    tenantCode: string,
    input: { orderNo: string; refundCents: number; operator?: string | null },
  ): Promise<{ order: OrderSummaryRecord; refundTxn: WalletTxnRecord | null; feeReturnedCents: number }> {
    const order = await this.platform.findOrderSummary(tenantCode, input.orderNo);
    if (!order) throw BizError.notFound(ERR.NOT_FOUND, `订单汇总不存在：${input.orderNo}`);
    if (order.status === 'canceled') {
      throw new BizError(ERR.ORDER_ALREADY_REFUNDED, '该订单已取消，无需退款');
    }
    if (!Number.isInteger(input.refundCents) || input.refundCents <= 0) {
      throw new BizError(ERR.VALIDATION_FAILED, '退款金额必须为正整数分');
    }
    if (order.refundCents + input.refundCents > order.amountCents) {
      throw new BizError(ERR.VALIDATION_FAILED, '累计退款额超过订单金额');
    }

    const wasSettled = order.status === 'settled';
    const feeReturnedCents = wasSettled ? feeOfCents(input.refundCents) : 0;

    const next = await this.platform.markOrderRefunded(tenantCode, input.orderNo, input.refundCents, new Date());

    const refundTxn = wasSettled
      ? await this.platform.appendWalletTxn({
          tenantCode,
          type: 'refund',
          amountCents: feeReturnedCents,
          refOrderNo: input.orderNo,
          source: 'system',
          operator: input.operator ?? null,
          remark: `退款 ¥${(input.refundCents / 100).toFixed(2)} 的服务费返还`,
        })
      : null;

    return { order: next, refundTxn, feeReturnedCents };
  }

  /* ============================================================ 四、充值 */

  /** 充值：校验最低额 → 落流水（充值是正数）→ 余额自动解冻（status 由快照重算） */
  async topup(
    tenantCode: string,
    amountCents: number,
    opts: { operator?: string | null; remark?: string | null; source?: WalletTxnRecord['source'] } = {},
  ): Promise<{ txn: WalletTxnRecord; wallet: WalletRecord; unfrozen: boolean }> {
    const wallet = await this.platform.getWallet(tenantCode);
    if (!wallet) throw BizError.notFound(ERR.TENANT_NOT_FOUND, `租户不存在：${tenantCode}`);

    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new BizError(ERR.TOPUP_AMOUNT_INVALID, '充值金额必须为正整数分');
    }
    if (amountCents < wallet.minTopupCents) {
      throw new BizError(
        ERR.TOPUP_BELOW_MIN,
        `${COPY.topupMinHint((wallet.minTopupCents / 100).toFixed(0))}（本次 ¥${(amountCents / 100).toFixed(2)}）`,
      );
    }

    const wasBlocked = wallet.balanceCents <= wallet.creditLimitCents;
    const txn = await this.platform.appendWalletTxn({
      tenantCode,
      type: 'topup',
      amountCents,
      source: opts.source ?? 'manual',
      operator: opts.operator ?? null,
      remark: opts.remark ?? COPY.topupTitle,
    });
    const after = (await this.platform.getWallet(tenantCode))!;
    return { txn, wallet: after, unfrozen: wasBlocked && after.balanceCents > after.creditLimitCents };
  }

  /** 人工调整（补偿对账差额）—— 必须留 operator 与理由，否则钱说不清 */
  async adjust(
    tenantCode: string,
    amountCents: number,
    reason: string,
    operator: string,
  ): Promise<WalletTxnRecord> {
    if (!Number.isInteger(amountCents) || amountCents === 0) {
      throw new BizError(ERR.VALIDATION_FAILED, '调整金额必须为非零整数分');
    }
    if (!reason?.trim()) throw new BizError(ERR.VALIDATION_FAILED, '人工调整必须写明理由');
    if (!operator?.trim()) throw new BizError(ERR.VALIDATION_FAILED, '人工调整必须记录操作人');
    return this.platform.appendWalletTxn({
      tenantCode,
      type: 'adjust',
      amountCents,
      source: 'manual',
      operator,
      remark: reason.trim(),
    });
  }

  /* ============================================================ 五、账单与对账 */

  /** 商户账单页：余额 + 账期 + 待扣 + 近 N 条流水 */
  async billingView(tenantCode: string, opts: { txnLimit?: number } = {}) {
    const [wallet, sub, txns, runs, pending] = await Promise.all([
      this.platform.getWallet(tenantCode),
      this.platform.getSubscription(tenantCode),
      this.platform.listWalletTxns(tenantCode, { limit: opts.txnLimit ?? 50 }),
      this.platform.listSettlementRuns(tenantCode, 30),
      this.pendingFees(tenantCode),
    ]);
    if (!wallet) throw BizError.notFound(ERR.TENANT_NOT_FOUND, `租户不存在：${tenantCode}`);

    return {
      wallet: {
        ...wallet,
        /** tone 直接决定 UI 颜色，业务代码不得自行选色 */
        tone: this.balanceTone(wallet),
        warnTitle: COPY.balanceWarnTitle,
        warnBody: COPY.balanceWarnBody((wallet.balanceCents / 100).toFixed(2), (wallet.warnLineCents / 100).toFixed(0)),
        walletName: COPY.walletName,
      },
      subscription: sub
        ? {
            ...sub,
            daysLeft: sub.periodEnd ? Math.ceil((new Date(sub.periodEnd).getTime() - Date.now()) / 86_400_000) : null,
            subscriptionName: COPY.subscriptionName,
            /** 到期文案（中性）：剩余/已结束两种，不含禁用词 */
            notice: this.subscriptionNotice(sub),
          }
        : null,
      pending,
      txns,
      runs,
    };
  }

  balanceTone(w: WalletRecord): 'ok' | 'warn' | 'danger' {
    if (w.balanceCents <= w.creditLimitCents) return 'danger';
    if (w.balanceCents <= w.warnLineCents) return 'warn';
    return 'ok';
  }

  subscriptionNotice(sub: SubscriptionRecord): string {
    const days = sub.periodEnd ? Math.ceil((new Date(sub.periodEnd).getTime() - Date.now()) / 86_400_000) : null;
    if (days === null) return COPY.subscriptionExpiredBody;
    if (days <= 0) return COPY.subscriptionExpiredBody;
    return COPY.subscriptionWarnBody(this.formatDateCN(sub.periodEnd as string));
  }

  /**
   * 展开一个结算批次：批次 → 覆盖的订单明细。
   * 这是"一天一条扣费流水"能成立的前提 —— 商户点开那条流水必须能看到它扣的是哪 37 笔单。
   */
  async expandRun(tenantCode: string, runId: number) {
    const run = (await this.platform.listSettlementRuns(tenantCode, 1000)).find((r) => r.id === runId);
    if (!run) throw BizError.notFound(ERR.SETTLEMENT_NOT_FOUND, `结算批次不存在：${runId}`);
    const orders = await this.platform.listOrdersByRun(tenantCode, runId);
    const txns = (await this.platform.listWalletTxns(tenantCode, { limit: 1000 })).filter((t) => t.runId === runId);
    return {
      run,
      txn: txns[0] ?? null,
      /** 校验用：批次里的 feeCents 必须等于明细汇总，不等就是批次与明细脱钩 */
      detailSumCents: orders.reduce((s, o) => s + o.feeCents, 0),
      consistent: orders.reduce((s, o) => s + o.feeCents, 0) === run.feeCents,
      items: orders.map((o) => ({
        orderNo: o.orderNo,
        amountCents: o.amountCents,
        feeCents: o.feeCents,
        status: o.status,
        buildingCode: o.buildingCode,
      })),
    };
  }

  async listStatements(tenantCode: string): Promise<StatementRecord[]> {
    return this.platform.listStatements(tenantCode);
  }

  /**
   * 账本自洽核对 —— 这条是"分毫不差"的可执行定义。
   * 断言：余额 == 全部流水求和。差额 ≠ 0 说明有一次扣减/返还漏写了流水。
   */  async reconcile(tenantCode: string): Promise<LedgerReconcile> {
    const wallet = await this.platform.getWallet(tenantCode);
    if (!wallet) throw BizError.notFound(ERR.TENANT_NOT_FOUND, `租户不存在：${tenantCode}`);

    const txns = await this.platform.listWalletTxns(tenantCode, { limit: 100_000 });
    const txnSumCents = txns.reduce((s, t) => s + t.amountCents, 0);
    const orders = await this.platform.listOrderSummaries(tenantCode, 100_000);

    const pending = orders.filter((o) => o.status === 'paid');
    const settled = orders.filter((o) => o.status === 'settled' || o.status === 'refunded');

    return {
      tenantCode,
      balanceCents: wallet.balanceCents,
      txnSumCents,
      diffCents: wallet.balanceCents - txnSumCents,
      txnCount: txns.length,
      pendingFeeCents: pending.reduce((s, o) => s + o.feeCents, 0),
      pendingOrderCount: pending.length,
      settledFeeCents: settled.reduce((s, o) => s + o.feeCents, 0),
      settledOrderCount: settled.length,
      ok: wallet.balanceCents === txnSumCents,
    };
  }

  /**
   * 账期账单。period 形如 '2026-09'。
   * `feeDueCents` 是"应付"、`feeDeductedCents` 是"实扣"，
   * 差额 ≠0 就是断链（付了但没扣 / 扣了但没付），必须在后台标红。
   */
  async buildStatement(tenantCode: string, period: string): Promise<StatementRecord> {
    const orders = await this.platform.listOrderSummaries(tenantCode, 100_000);
    const inPeriod = orders.filter((o) => o.paidAt !== null && LedgerService.bizDate(new Date(o.paidAt)).startsWith(period));

    const gmvCents = inPeriod.reduce((s, o) => s + o.amountCents, 0);
    // 应付：该账期成交订单的理论服务费（退款订单按净额）
    const feeDueCents = inPeriod.reduce(
      (s, o) => s + (o.status === 'refunded' ? feeOfCents(o.amountCents - o.refundCents) : o.feeCents),
      0,
    );
    // 实扣：该账期真正落账的 fee 流水（按流水时间归属，不是按订单归属）
    const txns = await this.platform.listWalletTxns(tenantCode, { limit: 100_000 });
    const feeDeductedCents = txns
      .filter((t) => t.type === 'fee' && LedgerService.bizDate(new Date(t.createdAt)).startsWith(period))
      .reduce((s, t) => s + Math.abs(t.amountCents), 0);
    const refundedCents = txns
      .filter((t) => t.type === 'refund' && LedgerService.bizDate(new Date(t.createdAt)).startsWith(period))
      .reduce((s, t) => s + t.amountCents, 0);

    const diffCents = feeDueCents - (feeDeductedCents - refundedCents);

    return this.platform.upsertStatement(tenantCode, period, {
      orderCount: inPeriod.length,
      gmvCents,
      feeDueCents,
      feeDeductedCents,
      diffCents,
      status: diffCents === 0 ? 'ok' : 'diff',
    });
  }

  /* ============================================================ 六、到期提醒 */

  /**
   * 到期提醒（15 / 7 / 3 天）。
   * 幂等靠 subscription.notifyFlags 记位：同一个阈值只推一次，
   * 否则每日任务会把商户一天骚扰一遍。
   */
  async collectSubscriptionReminders(now: Date = new Date()): Promise<SubscriptionReminder[]> {
    const max = Math.max(...SUBSCRIPTION_WARN_DAYS);
    const subs = await this.platform.listExpiringSubscriptions(max, now);
    const out: SubscriptionReminder[] = [];

    for (const sub of subs) {
      const days = Math.ceil((new Date(sub.periodEnd as string).getTime() - now.getTime()) / 86_400_000);
      const threshold = [...SUBSCRIPTION_WARN_DAYS].sort((a, b) => a - b).find((d) => days <= d);
      if (threshold === undefined) continue;

      const flags = (sub.notifyFlags ?? '').split(',').filter(Boolean);
      if (flags.includes(String(threshold))) continue;

      const tenant = await this.platform.findTenantByCode(sub.tenantCode);
      out.push({
        tenantCode: sub.tenantCode,
        shopName: tenant?.shopName ?? sub.tenantCode,
        periodEnd: sub.periodEnd as string,
        daysLeft: days,
        threshold,
        title: COPY.subscriptionWarnTitle(days),
        body: COPY.subscriptionWarnBody(this.formatDateCN(sub.periodEnd as string)),
      });

      await this.platform.upsertSubscription(sub.tenantCode, {
        notifyFlags: [...flags, String(threshold)].join(','),
        status: 'expiring',
      });
    }
    return out;
  }

  /** 订阅到期状态刷新：过期后只降级到"可浏览不可下单"，不关店、不清数据 */
  async refreshSubscriptionStatus(now: Date = new Date()): Promise<{ expired: string[]; expiring: string[] }> {
    const tenants = await this.platform.listTenants();
    const expired: string[] = [];
    const expiring: string[] = [];

    for (const t of tenants) {
      const sub = await this.platform.getSubscription(t.tenantCode);
      if (!sub?.periodEnd) continue;
      const end = new Date(sub.periodEnd).getTime();
      const days = Math.ceil((end - now.getTime()) / 86_400_000);

      if (end <= now.getTime()) {
        if (sub.status !== 'expired') {
          await this.platform.upsertSubscription(t.tenantCode, { status: 'expired' });
          // 租户状态同步为 expired（不是 suspended：suspended 是我方强制停用，语义不同）
          if (t.status === 'active') await this.platform.updateTenant(t.tenantCode, { status: 'expired' });
        }
        expired.push(t.tenantCode);
      } else if (days <= Math.max(...SUBSCRIPTION_WARN_DAYS)) {
        if (sub.status !== 'expiring') await this.platform.upsertSubscription(t.tenantCode, { status: 'expiring' });
        expiring.push(t.tenantCode);
      }
    }
    return { expired, expiring };
  }

  /** 续期：延长服务期并清空提醒位（否则新学期第一天就把旧提醒当成"已发过"） */
  async renewSubscription(
    tenantCode: string,
    opts: { periodEnd?: Date; operator?: string | null } = {},
  ): Promise<{ before: SubscriptionRecord; after: SubscriptionRecord }> {
    const before = await this.platform.getSubscription(tenantCode);
    if (!before) throw BizError.notFound(ERR.TENANT_NOT_FOUND, `租户不存在：${tenantCode}`);

    const base = before.periodEnd && new Date(before.periodEnd) > new Date() ? new Date(before.periodEnd) : new Date();
    // 默认续一个学期：从当前到期日（或今天）起 +1 个月粒度不准确，统一按 +6 个月（一个学期）
    const nextEnd = opts.periodEnd ?? new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 6, base.getUTCDate()));

    const after = await this.platform.upsertSubscription(tenantCode, {
      periodEnd: nextEnd.toISOString(),
      status: 'active',
      lastRenewAt: new Date().toISOString(),
      notifyFlags: null,
    });
    await this.platform.updateTenant(tenantCode, { status: 'active' });
    await this.platform.appendAudit({
      tenantCode,
      actor: opts.operator ?? 'platform',
      action: 'subscription.renew',
      target: tenantCode,
      detail: `服务期 ${before.periodEnd ?? '(无)'} → ${after.periodEnd}`,
    });
    return { before, after };
  }

  /** 订阅续期/重开时把提醒位重置的成本要可见 —— 平台后台用它提示"还会再提醒 3 次" */
  async subscriptionNotifyState(tenantCode: string) {
    const sub = await this.platform.getSubscription(tenantCode);
    if (!sub) return null;
    const sent = (sub.notifyFlags ?? '').split(',').filter(Boolean).map(Number);
    return {
      notifyFlags: sub.notifyFlags,
      sent,
      remaining: SUBSCRIPTION_WARN_DAYS.filter((d) => !sent.includes(d)),
    };
  }

  private formatDateCN(iso: string): string {
    const t = new Date(new Date(iso).getTime() + CHINA_TZ_OFFSET_MINUTES * 60_000);
    return `${t.getUTCFullYear()} 年 ${t.getUTCMonth() + 1} 月 ${t.getUTCDate()} 日`;
  }
}
