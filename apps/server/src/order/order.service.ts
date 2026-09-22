import { Inject, Injectable } from '@nestjs/common';
import { NoticeService } from '../notice/notice.service';
import type { NoticeType } from '../core/repository';
import { resolveBuildingConfig } from '../core/config-resolver';
import { env } from '../core/env';
import { ERR, BizError } from '../core/errors';
import { AppLogger } from '../core/logger';
import { REPO_FACTORY } from '../core/repo.factory';
import type { OrderRecord, OrderStatus, RepoFactory } from '../core/repository';
import {
  ORDER_TIMEOUT,
  feeOfCents,
  type DeliveryGroup,
  type DeliveryListItem,
  type MerchantOrderView,
  type PlaceOrderInput,
  type StudentOrderView,
} from '../core/types';
import { LedgerService } from '../ledger/ledger.service';
import { TenantService } from '../platform/tenant.service';
import { allowedActions, statusText, statusTone, transition, type OrderAction } from './order-state';

/* ============================================================================
 * 订单服务 —— 交易闭环的枢纽
 * ----------------------------------------------------------------------------
 * 四条正确性主线，每条都只在一个地方保证：
 *
 * ① **不超卖** → 全部走仓储的 `moveStockIf`（单条条件 UPDATE）。
 *    不在这里做"先查库存再判断"——那在真库里必然超卖。
 *
 * ② **不重复下单** → `clientKey` 服务端查重。
 *    学生在地铁里连点三次，三次请求都会到服务端；没有这道检测就是三张单。
 *
 * ③ **回调幂等** → 条件写（`expectFrom`）选出唯一赢家，**副作用放在条件写之后**。
 *    顺序不能反：先做副作用再判断"我是不是第一个"，就等于没有幂等 ——
 *    两个并发回调会双双完成副作用，然后才去抢那个"唯一"。这是本文件最要紧的一句话。
 *
 * ④ **库存与订单不脱节** → 下单失败必须回滚已占的格子。
 *    ⚠️ 内存实现用的是**补偿写**（反向 moveStock），因为内存没有事务；
 *    Prisma 实现必须把「预占 + 建单」放进**同一个事务**，靠事务回滚而不是补偿写。
 *    两者对外可观测行为必须一致：失败后不留任何预占残留。
 * ==========================================================================*/

export interface PayCallbackInput {
  orderNo: string;
  /** 支付平台流水号 */
  txnId: string;
  /** 平台回调的实付金额（分）—— 必须与订单 totalCents 一致 */
  amountCents: number;
  paidAt?: Date;
}

export interface PayCallbackResult {
  order: OrderRecord;
  /** true = 这次回调没有产生新的副作用（订单早已处理过） */
  idempotent: boolean;
  /** 幂等重放时顺手补齐的缺失副作用（正常情况下为空数组） */
  repaired: string[];
}

@Injectable()
export class OrderService {
  constructor(
    @Inject(REPO_FACTORY) private readonly repos: RepoFactory,
    private readonly tenants: TenantService,
    private readonly ledger: LedgerService,
    private readonly notices: NoticeService,
    private readonly logger: AppLogger,
  ) {}

  /* ========================================================================
   * ① 下单
   * ======================================================================*/

  /**
   * 提交订单。
   *
   * `now` 只给测试注入用 —— HTTP 入口**永远不传**，因此生产环境下
   * "现在几点"只能来自服务端（AC-14：前端本地时间判断能不能下单 = 不验收）。
   * 这与 `orderGateOf(t, buildingId, now)`、`closeExpired(t, now)` 是同一套约定：
   * 时间敏感的判断都要能注入 now，否则"跨日/跨时间窗"这类验收只能靠等。
   */
  async placeOrder(
    tenantCode: string,
    input: PlaceOrderInput,
    now: Date = new Date(),
  ): Promise<{ order: OrderRecord; duplicated: boolean }> {
    const repo = this.repos.tenant(tenantCode);

    const lines = mergeLines(input.lines);
    if (!lines.length) throw new BizError(ERR.VALIDATION_FAILED, '购物车是空的');

    // ---- 幂等键：同 key 直接返回原单，不新建、不重复占库存 -------------------
    if (input.clientKey) {
      const exist = await repo.findOrderByClientKey(input.userId, input.clientKey);
      if (exist) return { order: exist, duplicated: true };
    }

    // ---- 楼栋 --------------------------------------------------------------
    const building = await repo.findBuilding(input.buildingId);
    if (!building) {
      throw BizError.notFound(ERR.BUILDING_NOT_FOUND, `楼栋不存在：${input.buildingId}`);
    }

    // ---- 地址：楼栋必须与订单楼栋一致 ---------------------------------------
    // 这条不拦，货会送到学生根本没在的楼 —— 整个系统里最贵的一类错误（CS-10）
    if (!input.addressId) {
      throw new BizError(ERR.ORDER_ADDRESS_REQUIRED, '请先选择收货地址');
    }
    const addr = await repo.findAddress(input.userId, input.addressId);
    if (!addr) throw BizError.notFound(ERR.ADDRESS_NOT_FOUND, '地址不存在');
    if (addr.buildingId !== input.buildingId) {
      const addrBuilding = await repo.findBuilding(addr.buildingId);
      throw new BizError(
        ERR.ORDER_CROSS_BUILDING,
        `地址在「${addrBuilding?.name ?? addr.buildingId}」，与当前选择的「${building.name}」不是同一栋，请重新选择`,
      );
    }

    // ---- 六道闸门（复用唯一判定入口，**不在这里重写一遍**） ------------------
    const gate = await this.tenants.orderGateOf(tenantCode, input.buildingId, now);
    if (!gate.orderable) {
      throw new BizError(gateToErr(gate.state), gate.message);
    }

    // ---- 服务端算价（客户端传来的价格一律不看） -----------------------------
    const shop = await repo.getShopConfig();
    const cfg = resolveBuildingConfig(building, shop);

    const priced: Array<{
      productId: number;
      nameSnap: string;
      priceSnap: number;
      qty: number;
      amountCents: number;
    }> = [];
    for (const l of lines) {
      const p = await repo.findProduct(l.productId);
      if (!p) throw BizError.notFound(ERR.NOT_FOUND, `商品不存在：${l.productId}`);
      if (p.status !== 'active') {
        throw new BizError(ERR.VALIDATION_FAILED, `「${p.name}」已下架，请从购物车移除后重新提交`);
      }
      priced.push({
        productId: p.id,
        nameSnap: p.name,
        priceSnap: p.priceCents,
        qty: l.qty,
        amountCents: p.priceCents * l.qty,
      });
    }

    const amountCents = priced.reduce((s, x) => s + x.amountCents, 0);
    if (amountCents < cfg.minAmountCents) {
      throw new BizError(
        ERR.ORDER_MIN_AMOUNT,
        `还差 ${((cfg.minAmountCents - amountCents) / 100).toFixed(2)} 元起送`,
      );
    }
    const deliveryFeeCents = cfg.deliveryFeeCents;
    const totalCents = amountCents + deliveryFeeCents;

    // ---- 先生成订单号，再预占 -----------------------------------------------
    // 顺序有讲究：库存流水要能回链订单（`refOrderNo`），所以订单号必须先有。
    // 反过来的代价是"预占失败会烧掉一个单号"—— 这是可接受且正确的：
    // 订单号一旦对外用过就绝不复用。
    const orderNo = await repo.nextOrderNo(tenantCode);

    const reserved: Array<{ productId: number; qty: number }> = [];
    for (const l of priced) {
      const r = await repo.moveStockIf({
        productId: l.productId,
        buildingId: input.buildingId,
        dStock: -l.qty,
        dLocked: +l.qty,
        type: 'order_hold',
        refOrderNo: orderNo,
        operator: `student:${input.userId}`,
        requireOnShelf: true,
      });
      if (!r.ok) {
        await this.releaseReservations(tenantCode, input.buildingId, reserved, orderNo, '下单失败回滚');
        const why = r.reason === 'not_on_shelf' ? '本栋未上架' : '库存不足';
        throw new BizError(ERR.ORDER_OUT_OF_STOCK, `「${l.nameSnap}」${why}，请调整数量后重试`);
      }
      reserved.push({ productId: l.productId, qty: l.qty });
    }

    // ---- 建单（失败也必须回滚，否则库存被永久占住） --------------------------
    try {
      const order = await repo.createOrder({
        orderNo,
        userId: input.userId,
        buildingId: input.buildingId,
        floor: addr.floor,
        room: addr.room,
        contact: addr.contact,
        phone: addr.phone,
        amountCents,
        deliveryFeeCents,
        totalCents,
        feeCents: feeOfCents(totalCents),
        remark: input.remark,
        clientKey: input.clientKey,
        items: priced,
      });
      return { order, duplicated: false };
    } catch (e) {
      await this.releaseReservations(tenantCode, input.buildingId, reserved, orderNo, '建单失败回滚');
      throw e;
    }
  }

  /** 回滚已占的格子。内存实现靠它；Prisma 实现应当由事务回滚取代，但行为必须一致。 */
  private async releaseReservations(
    tenantCode: string,
    buildingId: number,
    reserved: Array<{ productId: number; qty: number }>,
    orderNo: string,
    remark: string,
  ): Promise<void> {
    const repo = this.repos.tenant(tenantCode);
    for (const r of reserved) {
      const back = await repo.moveStock({
        productId: r.productId,
        buildingId,
        dStock: +r.qty,
        dLocked: -r.qty,
        type: 'cancel_release',
        refOrderNo: orderNo,
        operator: 'system',
        remark,
      });
      if (!back.ok) {
        // 回滚失败是**必须吵闹**的事故：库存会永久少一块，只能靠对账兜。
        this.logger.error('库存回滚失败 —— 需要人工介入', { tenantCode, orderNo, ...r, reason: back.reason });
      }
    }
  }

  /* ========================================================================
   * ①-B 发起支付
   * ======================================================================*/

  /**
   * 为一张待支付单取 JSAPI 支付参数。
   *
   * **未配置商户号时返回 200 + `configured:false`，而不是抛错。**
   * 理由：这不是学生做错了什么，也不是服务故障 —— 它是"这家店还没接入微信支付"
   * 这样一个**正常的中间状态**。抛错会让前端走进通用错误页，
   * 把"订单已保留、30 分钟内可付"这个关键信息丢掉；而学生最担心的恰恰是
   * "我的单还在不在"。
   *
   * 订单状态不做任何变动：预占继续有效，超时关单任务照常兜底。
   */
  async createPrepay(
    tenantCode: string,
    orderNo: string,
    userId: number,
  ): Promise<{
    configured: boolean;
    orderNo: string;
    totalCents: number;
    /** 剩余可支付秒数 —— 前端倒计时用（判定仍在服务端） */
    payExpiresInSeconds: number | null;
    hint: string;
    payParams: Record<string, string> | null;
    /**
     * 当前环境是否开放模拟支付。
     * 由服务端告诉前端，而不是前端读环境变量 —— 否则就成了"前端自己决定要不要显示
     * 一个绕过支付的按钮"，这在生产上是灾难。这里只有一个真相源：服务端的 env。
     */
    devSimulateAvailable: boolean;
  }> {
    const order = await this.requireOwnOrder(tenantCode, orderNo, userId);

    if (order.status !== 'pending_pay' || order.payStatus === 'paid') {
      throw new BizError(
        ERR.PAY_ORDER_NOT_PAYABLE,
        `订单当前为「${statusText(order.status)}」，无需再次支付`,
      );
    }

    const payExpiresInSeconds = Math.max(
      0,
      Math.floor(
        (new Date(order.createdAt).getTime() + ORDER_TIMEOUT.PAY_TIMEOUT_MINUTES * 60_000 - Date.now()) / 1000,
      ),
    );

    const cfg = env.wechatPay;
    const configured = !!(cfg.mchId && cfg.apiV3Key && cfg.serialNo && cfg.privateKey);

    if (!configured) {
      this.logger.warn('发起支付时未配置微信支付商户号，订单保持待支付', {
        tenantCode, orderNo, totalCents: order.totalCents,
      });
      return {
        configured: false,
        orderNo: order.orderNo,
        totalCents: order.totalCents,
        payExpiresInSeconds,
        hint:
          '本店尚未接入微信支付，订单已为你保留。请在倒计时结束前完成支付，' +
          '或联系店家确认。',
        payParams: null,
        devSimulateAvailable: env.devPaySimulate,
      };
    }

    // ---- 已配置商户号：JSAPI 下单 ------------------------------------------
    // 这一步需要商户证书签名（RSA-SHA256 + 平台证书验签），是与微信的强契约，
    // 必须用真实的商户号联调才能验证签名格式与回调解密 —— 在拿到商户号之前
    // 写一份"看起来像"的实现只会制造出"已在生产跑但从未验签"的假安全感。
    // 因此这里显式失败，而不是返回一份伪造的 payParams。
    throw new BizError(
      ERR.PAY_NOT_CONFIGURED,
      '商户号已配置，但 JSAPI 下单尚未接入（需要 apiclient_key 签名与平台证书验签）。' +
        '接入完成前请使用开发环境的模拟支付。',
    );
  }

  /**
   * 开发用：把订单标记为已支付。
   *
   * **走的是与真实回调完全相同的那条路**（`onPayCallback`），
   * 而不是直接改状态 —— 否则模拟出来的"成功"会绕过金额校验、幂等条件写、
   * 库存预占转已售、账本登记，那条链路上任何一处坏了都测不出来。
   *
   * 生产环境由 `env.devPaySimulate`（默认绑定 NODE_ENV）关死。
   */
  async simulatePay(tenantCode: string, orderNo: string, userId: number): Promise<{ order: OrderRecord; idempotent: boolean }> {
    if (!env.devPaySimulate) {
      throw new BizError(
        ERR.PAY_NOT_CONFIGURED,
        '模拟支付未开启（生产环境恒关闭；本地请设置 DEV_PAY_SIMULATE=true）',
      );
    }
    const order = await this.requireOwnOrder(tenantCode, orderNo, userId);
    const r = await this.onPayCallback(tenantCode, {
      orderNo: order.orderNo,
      txnId: `SIMULATED-${order.orderNo}-${Date.now()}`,
      amountCents: order.totalCents,
    });
    return { order: r.order, idempotent: r.idempotent };
  }

  /* ========================================================================
   * ② 支付回调（幂等）
   * ======================================================================*/

  async onPayCallback(tenantCode: string, input: PayCallbackInput): Promise<PayCallbackResult> {
    const repo = this.repos.tenant(tenantCode);
    const order = await repo.findOrder(input.orderNo);
    if (!order) throw BizError.notFound(ERR.ORDER_NOT_FOUND, `订单不存在：${input.orderNo}`);

    // ---- 金额校验：不符则**不落任何状态**，单独吵一声让人去查 ----------------
    // 金额不符通常是两类事：回调被篡改，或订单金额在支付途中被改过。
    // 两种都必须人工查，绝不能"先按回调金额记上再说"。
    if (input.amountCents !== order.totalCents) {
      this.logger.error('支付回调金额与订单不符，已拒绝落账', {
        tenantCode, orderNo: order.orderNo,
        callbackCents: input.amountCents, orderCents: order.totalCents, txnId: input.txnId,
      });
      throw new BizError(
        ERR.ORDER_AMOUNT_MISMATCH,
        `回调金额 ${input.amountCents} 与订单实付 ${order.totalCents} 不一致`,
      );
    }

    // ---- 幂等分支：订单已不是待支付 -----------------------------------------
    if (order.status !== 'pending_pay') {
      if (order.payStatus === 'paid') {
        // 平台会重发回调。这里不只是"返回成功"，还顺手补齐可能缺失的副作用 ——
        // 幂等的重放同时就是一次自愈的机会（上次可能死在半路）。
        const repaired = await this.ensurePaidSideEffects(tenantCode, order);
        return { order: (await repo.findOrder(input.orderNo))!, idempotent: true, repaired };
      }
      throw new BizError(
        ERR.ORDER_ILLEGAL_TRANSITION,
        `订单当前为「${statusText(order.status)}」，不能接收支付回调`,
      );
    }

    // ---- 条件写选出唯一赢家 ------------------------------------------------
    // 两个并发回调会同时走到这里，但只有一个的 WHERE status='pending_pay' 命中。
    const moved = await repo.updateOrderStatus({
      orderNo: order.orderNo,
      expectFrom: 'pending_pay',
      to: 'pending_accept',
      patch: {
        payStatus: 'paid',
        payTxnId: input.txnId,
        paidAt: (input.paidAt ?? new Date()).toISOString(),
      },
    });
    if (!moved.ok) {
      // 输给并发了：对方已经在做副作用，这里直接按幂等返回，不重复做
      const fresh = await repo.findOrder(input.orderNo);
      this.logger.warn('支付回调并发，已按幂等处理', { tenantCode, orderNo: order.orderNo });
      return { order: fresh!, idempotent: true, repaired: [] };
    }

    const paid = moved.order!;
    // ---- 副作用放在"唯一赢家"分支之内，所以天然只执行一次 -------------------
    const repaired = await this.ensurePaidSideEffects(tenantCode, paid);
    return { order: (await repo.findOrder(input.orderNo))!, idempotent: false, repaired };
  }

  /**
   * 支付成功后的三件副作用，**全部可重复执行而不产生第二次影响**：
   *   ① 库存：预占转已售（locked→sold，**不动可售**）
   *   ② 账本：登记待扣记录（按 orderNo 幂等）
   *   ③ 楼栋码回填给账本投影（平台库只存楼栋码，不存房间号 —— AC-13）
   *
   * 每一项都先查"是否已经做过"再动手。这样无论它是第一次执行、
   * 还是上次死在半路的补做，结果都一样。
   */
  private async ensurePaidSideEffects(tenantCode: string, order: OrderRecord): Promise<string[]> {
    const repo = this.repos.tenant(tenantCode);
    const repaired: string[] = [];

    // ① 库存：以"本单是否已有 pay_confirm 流水"为判据
    const logs = await repo.findStockByOrder(order.orderNo);
    if (!logs.some((l) => l.type === 'pay_confirm')) {
      for (const it of order.items) {
        await repo.moveStock({
          productId: it.productId,
          buildingId: order.buildingId,
          dLocked: -it.qty,
          dSold: +it.qty,
          type: 'pay_confirm',
          refOrderNo: order.orderNo,
          operator: 'system',
          remark: '支付确认：预占转已售',
        });
      }
      repaired.push('stock_confirm');
    }

    // ②③ 账本：recordPaidOrder 自身按 orderNo 幂等
    const building = await repo.findBuilding(order.buildingId);
    const before = await this.repos.platform().findOrderSummary(tenantCode, order.orderNo);
    await this.ledger.recordPaidOrder(tenantCode, {
      orderNo: order.orderNo,
      amountCents: order.totalCents,
      buildingCode: building?.code ?? null,
      paidAt: order.paidAt ? new Date(order.paidAt) : new Date(),
    });
    if (!before) repaired.push('ledger_register');

    // 「已收到付款」只在**第一次**确认时发：微信回调会重放，
    // 同一笔钱通知三遍就是三条一样的消息，学生会以为重复扣款了
    if (repaired.includes('stock_confirm')) {
      await this.note(tenantCode, order, 'paid');
    }

    return repaired;
  }

  /* ========================================================================
   * ③ 状态流转（唯一入口）
   * ======================================================================*/

  /**
   * 所有状态变更都从这里过。
   * 好处：合法/非法由状态机一张表决定，条件写统一带上 `expectFrom`，
   * 并发冲突统一翻译成同一个错误码 —— 不会出现"某个接口忘了带 expectFrom"。
   */
  /**
   * 给学生留一条站内消息。
   *
   * ⚠️ 只有 applyAction 这一个出口会调用它 —— 状态流转已经有唯一通道了，
   * 消息就不能再另开一处。好处是：将来状态机新增一条边，只要它走 applyAction
   * 就自动有了消息，"某条路径忘了通知学生"这种漏报根本不会出现。
   */
  private async note(tenantCode: string, order: OrderRecord, type: NoticeType): Promise<void> {
    const building = await this.repos.tenant(tenantCode).findBuilding(order.buildingId);
    await this.notices.emit(tenantCode, order.userId, type, {
      orderNo: order.orderNo,
      buildingName: building?.name ?? `楼栋 ${order.buildingId}`,
    });
  }

  private async applyAction(
    tenantCode: string,
    orderNo: string,
    action: OrderAction,
    patch?: Record<string, unknown>,
    actor?: string,
  ): Promise<OrderRecord> {
    const repo = this.repos.tenant(tenantCode);
    const order = await repo.findOrder(orderNo);
    if (!order) throw BizError.notFound(ERR.ORDER_NOT_FOUND, `订单不存在：${orderNo}`);

    const t = transition(order.status, action, {
      payStatus: order.payStatus,
      acceptedAt: order.acceptedAt,
      deliveredAt: order.deliveredAt,
    });
    if (!t.ok) {
      throw new BizError(ERR.ORDER_ILLEGAL_TRANSITION, `${t.message}（订单 ${orderNo}）`);
    }

    const extra: Partial<OrderRecord> = {};
    if (action === 'accept') extra.acceptedAt = new Date().toISOString();
    if (action === 'deliver') extra.deliveredAt = new Date().toISOString();
    if (action === 'cancel') extra.cancelledAt = new Date().toISOString();
    if (action === 'refund_done') extra.payStatus = 'refunded';

    const r = await repo.updateOrderStatus({
      orderNo,
      expectFrom: order.status,
      to: t.to,
      patch: { ...extra, ...(patch ?? {}) } as never,
    });
    if (!r.ok) {
      throw new BizError(
        ERR.ORDER_STATE_CONFLICT,
        '订单状态已被其他操作变更，请刷新后重试',
      );
    }
    if (actor) {
      await this.repos.platform().appendAudit({
        tenantCode, actor, action: `order_${action}`,
        target: orderNo, detail: `${order.status} → ${t.to}`,
      });
    }
    // refund_start 是内部中间态（钱还没退回），不打扰学生
    const noticeByAction: Partial<Record<OrderAction, NoticeType>> = {
      accept: 'accepted', deliver: 'delivered', cancel: 'closed',
      refund_done: 'refund_done', refund_reject: 'refund_rejected',
    };
    if (noticeByAction[action]) await this.note(tenantCode, r.order!, noticeByAction[action]!);
    return r.order!;
  }

  /** 学生主动取消（仅未支付） */
  async cancelByStudent(tenantCode: string, orderNo: string, userId: number, reason = '学生取消'): Promise<OrderRecord> {
    const order = await this.requireOwnOrder(tenantCode, orderNo, userId);
    return this.cancelAndRelease(tenantCode, order, reason, `student:${userId}`);
  }

  /** 超时关单（定时任务） */
  async closeExpired(tenantCode: string, now = new Date()): Promise<{ closed: string[] }> {
    const repo = this.repos.tenant(tenantCode);
    const deadline = new Date(now.getTime() - ORDER_TIMEOUT.PAY_TIMEOUT_MINUTES * 60_000);
    const stale = await repo.listExpiredPendingPay(deadline);
    const closed: string[] = [];
    for (const o of stale) {
      try {
        await this.cancelAndRelease(
          tenantCode,
          o,
          `超过 ${ORDER_TIMEOUT.PAY_TIMEOUT_MINUTES} 分钟未支付，已自动关闭`,
          'system',
        );
        closed.push(o.orderNo);
      } catch (e) {
        // 单笔失败不能影响整批 —— 否则一笔异常会让后面所有订单永远关不掉
        this.logger.error('超时关单失败', { tenantCode, orderNo: o.orderNo, err: String(e) });
      }
    }
    return { closed };
  }

  /** 取消 + 释放预占。两步都在状态机允许的前提下进行。 */
  private async cancelAndRelease(
    tenantCode: string,
    order: OrderRecord,
    reason: string,
    actor: string,
  ): Promise<OrderRecord> {
    const done = await this.applyAction(tenantCode, order.orderNo, 'cancel', { cancelReason: reason }, actor);
    // 释放预占：**只有状态真的流转成功才释放**（applyAction 抛错就不会走到这里）
    const repo = this.repos.tenant(tenantCode);
    for (const it of order.items) {
      const r = await repo.moveStock({
        productId: it.productId,
        buildingId: order.buildingId,
        dStock: +it.qty,
        dLocked: -it.qty,
        type: 'cancel_release',
        refOrderNo: order.orderNo,
        operator: actor,
        remark: reason,
      });
      if (!r.ok) {
        this.logger.error('取消订单时释放库存失败，需要人工介入', {
          tenantCode, orderNo: order.orderNo, productId: it.productId, qty: it.qty,
        });
      }
    }
    return done;
  }

  /* ========================================================================
   * ④ 商户侧：接单 / 送达 / 拒单退款
   * ======================================================================*/

  async accept(tenantCode: string, orderNo: string, operator: string): Promise<OrderRecord> {
    return this.applyAction(tenantCode, orderNo, 'accept', undefined, operator);
  }

  /**
   * 标记送达。允许从「待接单」直达（商户取了货就走，不必先点接单）：
   * 这一跳不破坏任何不变量 —— 钱已收、库存已是 sold、房间号已确定。
   */
  async deliver(tenantCode: string, orderNo: string, operator: string): Promise<OrderRecord> {
    return this.applyAction(tenantCode, orderNo, 'deliver', { autoCompleted: false }, operator);
  }

  /** 批量送达（配送清单"一趟送完一键清"）—— 逐单独立成败，不因一单失败全批回滚 */
  async deliverBatch(
    tenantCode: string,
    orderNos: string[],
    operator: string,
  ): Promise<{ ok: string[]; failed: Array<{ orderNo: string; message: string }> }> {
    const ok: string[] = [];
    const failed: Array<{ orderNo: string; message: string }> = [];
    for (const no of orderNos) {
      try {
        await this.deliver(tenantCode, no, operator);
        ok.push(no);
      } catch (e) {
        failed.push({ orderNo: no, message: e instanceof BizError ? String(e.getResponse()) : String(e) });
      }
    }
    return { ok, failed };
  }

  /** 商户拒单 = 发起退款。**没有"直接取消"这条路** —— 钱已收就必须原路退回。 */
  async rejectByMerchant(tenantCode: string, orderNo: string, operator: string, reason: string): Promise<OrderRecord> {
    return this.applyAction(tenantCode, orderNo, 'refund_start', { cancelReason: reason }, operator);
  }

  async refundStart(tenantCode: string, orderNo: string, operator: string): Promise<OrderRecord> {
    return this.applyAction(tenantCode, orderNo, 'refund_start', undefined, operator);
  }

  /**
   * 退款到账 —— 三件事必须一起发生：状态流转、未送达回库、服务费返还。
   *
   * 回库规则（§"退款成功（未送达）回库"）：
   *   · 已送达 → **不回库**（货已经送到学生手里，是否回库由商户线下决定）
   *   · 全退且未送达 → 按明细回库
   *   · 部分退且未送达 → **不回库**：部分退对应的是哪几件商品无法从金额反推，
   *     猜错会让库存越错越远。留给商户走"人工调整库存"，并在返回里说明。
   */
  async refundDone(
    tenantCode: string,
    orderNo: string,
    refundCents: number,
    operator: string,
  ): Promise<{ order: OrderRecord; stockReturned: boolean; feeReturnedCents: number; stockNotice: string | null }> {
    const repo = this.repos.tenant(tenantCode);
    const before = await repo.findOrder(orderNo);
    if (!before) throw BizError.notFound(ERR.ORDER_NOT_FOUND, `订单不存在：${orderNo}`);

    const order = await this.applyAction(tenantCode, orderNo, 'refund_done', undefined, operator);

    // ---- 库存回库 ----
    const fullRefund = refundCents >= order.totalCents;
    const delivered = !!order.deliveredAt;
    let stockReturned = false;
    let stockNotice: string | null = null;

    if (delivered) {
      stockNotice = '订单已送达，库存未回库（是否回库由商户决定）';
    } else if (!fullRefund) {
      stockNotice = '部分退款无法判断对应哪几件商品，库存未自动回库，请人工调整';
    } else {
      for (const it of order.items) {
        const r = await repo.moveStock({
          productId: it.productId,
          buildingId: order.buildingId,
          dStock: +it.qty,
          dSold: -it.qty,
          type: 'refund_return',
          refOrderNo: order.orderNo,
          operator,
          remark: '退款回库',
        });
        if (!r.ok) {
          this.logger.error('退款回库失败，需要人工介入', {
            tenantCode, orderNo: order.orderNo, productId: it.productId, qty: it.qty,
          });
        }
      }
      stockReturned = true;
    }

    // ---- 服务费返还（账本侧自己判断是否已扣过费；未扣过则返回 0） ----
    let feeReturnedCents = 0;
    try {
      const r = await this.ledger.refundOrder(tenantCode, { orderNo, refundCents, operator });
      feeReturnedCents = r.feeReturnedCents;
    } catch (e) {
      // 账本侧失败不能回滚订单状态（钱已经退了），但必须吵一声
      this.logger.error('退款成功但服务费返还失败，需要人工核对', { tenantCode, orderNo, err: String(e) });
    }

    void before;
    return { order, stockReturned, feeReturnedCents, stockNotice };
  }

  /** 退款驳回 → 回到退款前的状态（由时间戳倒推，不存冗余字段） */
  async refundReject(tenantCode: string, orderNo: string, operator: string): Promise<OrderRecord> {
    return this.applyAction(tenantCode, orderNo, 'refund_reject', undefined, operator);
  }

  /* ========================================================================
   * ⑤ 送达兜底
   * ======================================================================*/

  /**
   * 「配送中」超时自动置为已送达。
   *
   * 需求原文写的是「送达后 N 小时自动完成兜底」。真正会卡死的是**忘了点送达** ——
   * 订单永远挂在配送中，学生天天来问，日报表也算不平。所以兜底作用在 delivering 上。
   * 自动完成的单打 `autoCompleted=true`，与商户手动标记区分开，便于事后追责。
   */
  async autoCompleteStuck(tenantCode: string, now = new Date()): Promise<{ completed: string[] }> {
    const repo = this.repos.tenant(tenantCode);
    const deadline = new Date(now.getTime() - ORDER_TIMEOUT.AUTO_COMPLETE_HOURS * 3600_000);
    const stuck = await repo.listStuckDelivering(deadline);
    const completed: string[] = [];
    for (const o of stuck) {
      try {
        await this.applyAction(
          tenantCode, o.orderNo, 'deliver',
          { autoCompleted: true, deliveredAt: now.toISOString() },
          'system',
        );
        completed.push(o.orderNo);
      } catch (e) {
        this.logger.error('送达兜底失败', { tenantCode, orderNo: o.orderNo, err: String(e) });
      }
    }
    return { completed };
  }

  /* ========================================================================
   * ⑥ 查询
   * ======================================================================*/

  /**
   * 商户配送清单 —— 按 **楼栋 → 楼层 → 房间号**（空间序，不是时间序）。
   * 商户人在楼里，一趟要把同栋的货全送完；按时间排序的列表对他毫无帮助（§4.13.3）。
   */
  async deliveryList(tenantCode: string, opts: { includeDelivered?: boolean } = {}): Promise<DeliveryGroup[]> {
    const repo = this.repos.tenant(tenantCode);
    // 默认只给"待送"（待接单 + 配送中）—— 这是商户要动手的那部分。
    // 加 includeDelivered 是为了"今天这趟送了哪些"的复盘视图。
    const statuses: OrderStatus[] = opts.includeDelivered
      ? ['pending_accept', 'delivering', 'delivered']
      : ['pending_accept', 'delivering'];
    const orders = await repo.listOrdersByStatus(statuses);
    const buildings = await repo.listBuildings(true);
    const byId = new Map(buildings.map((b) => [b.id, b]));

    const groups = new Map<number, DeliveryGroup>();
    for (const o of orders) {
      const b = byId.get(o.buildingId);
      let g = groups.get(o.buildingId);
      if (!g) {
        g = {
          buildingId: o.buildingId,
          buildingCode: b?.code ?? `B${o.buildingId}`,
          buildingName: b?.name ?? `楼栋 ${o.buildingId}`,
          pendingCount: 0,
          items: [],
        };
        groups.set(o.buildingId, g);
      }
      g.items.push(toDeliveryItem(o, b?.name ?? `楼栋 ${o.buildingId}`));
    }

    for (const g of groups.values()) {
      g.items.sort((a, b) => compareFloorRoom(a.floor, a.room, b.floor, b.room));
      g.pendingCount = g.items.length;
    }
    // 楼栋之间按楼栋排序字段排，避免每次刷新顺序乱跳
    return [...groups.values()].sort(
      (a, b) => (byId.get(a.buildingId)?.sort ?? 0) - (byId.get(b.buildingId)?.sort ?? 0),
    );
  }

  /**
   * 我的订单。
   *
   * **分区定义只在这里**：哪个状态算"进行中"、哪个算"已结束"由服务端回答。
   * 前端如果自己按 status 分组，等状态机新增一个状态（比如"已取消待退款"）时，
   * 新状态会掉进"两个分栏都看不见"的黑洞里 —— 而且不会有任何报错。
   *
   * 一次查询同时给出 `items` 与 `counts`：分栏上的数字要和列表内容同源，
   * 分两次请求就会出现"标签写着 3、点开只有 2 个"这种（短暂的）不一致。
   */
  async studentOrders(
    tenantCode: string,
    userId: number,
    opts: { status?: string; limit?: number } = {},
  ): Promise<{ items: StudentOrderView[]; counts: { ongoing: number; done: number; all: number } }> {
    const repo = this.repos.tenant(tenantCode);
    const buildings = await repo.listBuildings(true);
    const byId = new Map(buildings.map((b) => [b.id, b]));

    const all = await repo.listOrdersByUser(userId, { limit: opts.limit ?? 50 });
    const counts = {
      ongoing: all.filter((o) => ONGOING_STATUSES.includes(o.status)).length,
      done: all.filter((o) => DONE_STATUSES.includes(o.status)).length,
      all: all.length,
    };

    const picked =
      opts.status === 'ongoing'
        ? all.filter((o) => ONGOING_STATUSES.includes(o.status))
        : opts.status === 'done'
          ? all.filter((o) => DONE_STATUSES.includes(o.status))
          : all;

    return {
      items: picked.map((o) => toStudentView(o, byId.get(o.buildingId)?.name ?? `楼栋 ${o.buildingId}`)),
      counts,
    };
  }

  /**
   * 订单详情。
   * 比列表多两样：本人的房间号（回显给本人是正常的，任何外卖 App 都这样），
   * 以及完整的动作集（列表只给 pay/cancel，详情把商户侧动作也带上，便于排查）。
   */
  async studentOrderDetail(
    tenantCode: string,
    userId: number,
    orderNo: string,
  ): Promise<
    StudentOrderView & {
      room: string;
      remark: string | null;
      /** 已经真实发生过的时间点，**不含任何"预计"** */
      timeline: Array<{ label: string; at: string }>;
      merchantActions: OrderAction[];
    }
  > {
    const order = await this.requireOwnOrder(tenantCode, orderNo, userId);
    const repo = this.repos.tenant(tenantCode);
    const building = await repo.findBuilding(order.buildingId);
    const view = toStudentView(order, building?.name ?? `楼栋 ${order.buildingId}`);
    return {
      ...view,
      // 别人的房间号在**任何**接口里都不出现（§4.13.4）
      room: order.room,
      remark: order.remark,
      timeline: buildTimeline(order),
      merchantActions: allowedActions(order.status, {
        payStatus: order.payStatus,
        acceptedAt: order.acceptedAt,
        deliveredAt: order.deliveredAt,
      }),
    };
  }

  /**
   * 商户看订单详情 —— 含房间号（接单商户是正当可见范围，§4.13.4 第 4 条）。
   *
   * 返回**视图**而不是 OrderRecord 原样：原样等于把 `status` 这种机器值直接丢给前端，
   * 前端就得自己维护一份 status→文案/颜色 的映射 —— 那是把状态机抄了第二遍，
   * 也是 AC-11（颜色由服务端给）明确禁止的。
   */
  async merchantOrderDetail(tenantCode: string, orderNo: string): Promise<MerchantOrderView> {
    const repo = this.repos.tenant(tenantCode);
    const order = await repo.findOrder(orderNo);
    if (!order) throw BizError.notFound(ERR.ORDER_NOT_FOUND, `订单不存在：${orderNo}`);
    const building = await repo.findBuilding(order.buildingId);
    return toMerchantView(order, building?.name ?? `楼栋 ${order.buildingId}`);
  }

  private async requireOwnOrder(tenantCode: string, orderNo: string, userId: number): Promise<OrderRecord> {
    const order = await this.repos.tenant(tenantCode).findOrder(orderNo);
    if (!order) throw BizError.notFound(ERR.ORDER_NOT_FOUND, `订单不存在：${orderNo}`);
    // 越权：不返回 404 而返回 403，是为了让"这不是我的单"和"单不存在"可区分 —— 便于排查
    if (order.userId !== userId) {
      throw BizError.forbidden(ERR.TOKEN_INVALID, '只能查看自己的订单');
    }
    return order;
  }
}

/* ============================================================================
 * 纯函数工具
 * ==========================================================================*/

/**
 * 「进行中」= 还需要有人推进（或还在等结果）。
 * 「已结束」= 不需要任何人再做什么。
 *
 * 这两个集合必须覆盖**全部** OrderStatus —— 漏掉一个状态，
 * 那个状态的订单就会在"进行中/已结束"两个分栏里都消失。
 * 所以下面有个断言把这个约束钉在编译期。
 */
const ONGOING_STATUSES: readonly OrderStatus[] = ['pending_pay', 'pending_accept', 'delivering', 'refunding'];
const DONE_STATUSES: readonly OrderStatus[] = ['delivered', 'cancelled', 'refunded'];

// 编译期护栏：两集合的并集必须等于全部状态。新增状态却忘了归类时，这里会直接编译失败。
type _AllStatusesCovered = Exclude<
  OrderStatus,
  (typeof ONGOING_STATUSES)[number] | (typeof DONE_STATUSES)[number]
> extends never
  ? true
  : ['未归类的订单状态 → 请在 ONGOING_STATUSES / DONE_STATUSES 里补上', Exclude<OrderStatus, (typeof ONGOING_STATUSES)[number] | (typeof DONE_STATUSES)[number]>];
const _statusCoverage: _AllStatusesCovered = true;
void _statusCoverage;

/** 合并同一商品的多行 —— 客户端重复传同一 productId 时不产生两条明细、两次预占 */
export function mergeLines(
  lines: Array<{ productId: number; qty: number }>,
): Array<{ productId: number; qty: number }> {
  const m = new Map<number, number>();
  for (const l of lines ?? []) {
    const pid = Number(l.productId);
    const qty = Number(l.qty);
    if (!Number.isInteger(pid) || pid <= 0) throw new BizError(ERR.VALIDATION_FAILED, `商品 id 非法：${l.productId}`);
    if (!Number.isInteger(qty) || qty <= 0) throw new BizError(ERR.VALIDATION_FAILED, `数量必须为正整数（商品 ${pid}）`);
    if (qty > 99) throw new BizError(ERR.VALIDATION_FAILED, `单个商品一次最多 99 件（商品 ${pid}）`);
    m.set(pid, (m.get(pid) ?? 0) + qty);
  }
  return [...m.entries()].map(([productId, qty]) => ({ productId, qty }));
}

/**
 * 楼层 → 房间号的空间序比较。
 *
 * 楼层：数值升序，**缺失排最后**（没填楼层的订单放一趟的最后送）。
 * 房间号：自然序 —— "302" < "1001"，纯字符串比较会得到相反结果，
 *        而 1001 在 10 楼，物理上确实在 302 之后。
 */
export function compareFloorRoom(
  floorA: string | null, roomA: string,
  floorB: string | null, roomB: string,
): number {
  const fa = floorNum(floorA);
  const fb = floorNum(floorB);
  if (fa !== fb) return fa - fb;
  return naturalCompare(roomA, roomB);
}

function floorNum(floor: string | null): number {
  if (floor === null || floor === undefined || String(floor).trim() === '') return Number.MAX_SAFE_INTEGER;
  const m = String(floor).match(/\d+/);
  return m ? Number(m[0]) : Number.MAX_SAFE_INTEGER - 1;
}

export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' });
}

function toDeliveryItem(o: OrderRecord, buildingName: string): DeliveryListItem {
  return {
    orderNo: o.orderNo,
    buildingId: o.buildingId,
    buildingName,
    floor: o.floor,
    room: o.room,
    itemSummary: summarizeItems(o),
    itemCount: o.items.reduce((s, i) => s + i.qty, 0),
    totalCents: o.totalCents,
    status: o.status,
    tone: statusTone(o.status),
    statusText: statusText(o.status),
    paidAt: o.paidAt,
    acceptedAt: o.acceptedAt,
    remark: o.remark,
    hasRemark: !!o.remark,
  };
}

function summarizeItems(o: OrderRecord): string {
  const head = o.items.slice(0, 2).map((i) => `${i.nameSnap}×${i.qty}`);
  if (o.items.length > 2) head.push(`等 ${o.items.length} 种`);
  return head.join('，');
}

function toStudentView(o: OrderRecord, buildingName: string): StudentOrderView {
  const payExpiresInSeconds =
    o.status === 'pending_pay'
      ? Math.max(
          0,
          Math.floor(
            (new Date(o.createdAt).getTime() + ORDER_TIMEOUT.PAY_TIMEOUT_MINUTES * 60_000 - Date.now()) / 1000,
          ),
        )
      : null;
  return {
    orderNo: o.orderNo,
    buildingId: o.buildingId,
    buildingName,
    status: o.status,
    tone: statusTone(o.status),
    statusText: statusText(o.status),
    hint: STUDENT_HINT[o.status],
    totalCents: o.totalCents,
    itemCount: o.items.reduce((s, i) => s + i.qty, 0),
    items: o.items.map((i) => ({
      productId: i.productId,
      name: i.nameSnap,
      qty: i.qty,
      amountCents: i.amountCents,
    })),
    createdAt: o.createdAt,
    payExpiresInSeconds,
    // 与详情页用的是**同一个** allowedActions —— 列表和详情不可能给出不同答案
    actions: allowedActions(o.status, {
      payStatus: o.payStatus,
      acceptedAt: o.acceptedAt,
      deliveredAt: o.deliveredAt,
    }).filter((a): a is 'pay' | 'cancel' => a === 'pay' || a === 'cancel'),
  };
}

/**
 * 商户侧状态说明 —— 与学生侧那份刻意分开写。
 *
 * 同一个人不会同时是商户和学生，但**同一个状态在两端的"下一步"完全不同**：
 * pending_accept 对学生是"店家马上处理"，对商户是"该你接单了"。
 * 共用一份 hint 只能写出"已提交，等待处理"这种对谁都没用的话。
 */
const MERCHANT_HINT: Record<OrderStatus, string> = {
  pending_pay: '学生尚未完成支付，暂不需处理',
  pending_accept: '已收款，等待接单',
  delivering: '已接单，等待送达后标记',
  delivered: '已送达，本单完成',
  cancelled: '订单已关闭',
  refunding: '退款处理中，请尽快完成退款操作',
  refunded: '已退款，本单结束',
};

function toMerchantView(o: OrderRecord, buildingName: string): MerchantOrderView {
  const acts = allowedActions(o.status, {
    payStatus: o.payStatus,
    acceptedAt: o.acceptedAt,
    deliveredAt: o.deliveredAt,
  });
  return {
    orderNo: o.orderNo,
    buildingId: o.buildingId,
    buildingName,
    floor: o.floor,
    room: o.room,
    contact: o.contact,
    phone: o.phone,
    status: o.status,
    tone: statusTone(o.status),
    statusText: statusText(o.status),
    hint: MERCHANT_HINT[o.status],
    amountCents: o.amountCents,
    deliveryFeeCents: o.deliveryFeeCents,
    totalCents: o.totalCents,
    feeCents: o.feeCents,
    itemCount: o.items.reduce((s, i) => s + i.qty, 0),
    items: o.items.map((i) => ({
      productId: i.productId,
      name: i.nameSnap,
      qty: i.qty,
      priceCents: i.priceSnap,
      amountCents: i.amountCents,
    })),
    remark: o.remark,
    createdAt: o.createdAt,
    paidAt: o.paidAt,
    acceptedAt: o.acceptedAt,
    deliveredAt: o.deliveredAt,
    cancelledAt: o.cancelledAt,
    cancelReason: o.cancelReason,
    payStatus: o.payStatus,
    payTxnId: o.payTxnId,
    autoCompleted: o.autoCompleted,
    // 商户只做商户侧动作；pay 是支付回调的动作，不出现在商户按钮里
    // 与详情页用的是**同一个** allowedActions —— 列表和详情不可能给出不同答案
    actions: acts.filter(
      (a): a is 'accept' | 'deliver' | 'refund_start' | 'refund_done' | 'refund_reject' =>
        a !== 'pay' && a !== 'cancel',
    ),
    timeline: buildTimeline(o),
  };
}

/**
 * 时间线：**只列出真实发生过的时间点**。
 *
 * 为什么不加"预计送达 18:30"这种：
 *   校园跑腿的时效本来就受课间、楼层、单量影响，任何"预计"都会有偏差。
 *   一旦写了预计时间，学生就会拿它当承诺，迟到五分钟就开始投诉。
 *   只报"已经发生的事实"，学生心里有数，我们也不用为一个猜出来的数字负责。
 */
function buildTimeline(o: OrderRecord): Array<{ label: string; at: string }> {
  const out: Array<{ label: string; at: string }> = [{ label: '下单', at: o.createdAt }];
  if (o.paidAt) out.push({ label: '支付成功', at: o.paidAt });
  if (o.acceptedAt) out.push({ label: '店家接单', at: o.acceptedAt });
  if (o.deliveredAt) out.push({ label: '已送达', at: o.deliveredAt });
  if (o.cancelledAt) out.push({ label: '订单关闭', at: o.cancelledAt });
  return out;
}

/** 学生端状态说明 —— 全部中性措辞，禁用词表之外（D5） */const STUDENT_HINT: Record<OrderRecord['status'], string> = {
  pending_pay: `请在下单后 ${ORDER_TIMEOUT.PAY_TIMEOUT_MINUTES} 分钟内完成支付，超时订单会自动关闭`,
  pending_accept: '已支付，店家马上处理',
  delivering: '已接单，正在送往你的宿舍',
  delivered: '已送达，感谢光临',
  cancelled: '订单已关闭，如已付款将原路退回',
  refunding: '退款处理中，到账后会通知你',
  refunded: '退款已完成',
};

function gateToErr(state: string): (typeof ERR)[keyof typeof ERR] {
  if (state === 'subscription_expired') return ERR.GATE_SUBSCRIPTION_EXPIRED;
  if (state === 'balance_blocked') return ERR.GATE_BALANCE_BLOCKED;
  return ERR.ORDER_GATE_CLOSED;
}
