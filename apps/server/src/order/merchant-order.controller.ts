import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ERR, BizError } from '../core/errors';
import { currentContext } from '../core/logger';
import { OwnerGuard } from '../core/owner.guard';
import { tenantOf } from '../core/tenant-scope';
import { OrderService } from './order.service';

/**
 * 商户端订单接口（M-01~M-10 的数据来源）。
 *
 * 整个控制器挂 `OwnerGuard`（不是 OwnerWriteGuard）—— 商户端**连读**都不该让学生碰：
 * 配送清单里带着别人的房间号（§4.13.4）。
 *
 * 房间号在**这一端是正当可见的**（接单商户要送货），但仅此一端：
 * 平台库、平台后台、日志、报表里都没有它（AC-13）。
 */
@Controller('t/:tenantCode/api/merchant/orders')
@UseGuards(OwnerGuard)
export class MerchantOrderController {
  constructor(private readonly orders: OrderService) {}

  /**
   * 配送清单 —— 按 **楼栋 → 楼层 → 房间号**（空间序）。
   *
   * ⚠️ 这条必须声明在 `@Get(':orderNo')` 之前：两者都是一段路径，
   * Nest 按声明顺序匹配，反过来的话 `/delivery` 会被当成订单号。
   */
  @Get('delivery')
  async delivery(
    @Param('tenantCode') tenantCode: string,
    @Query('includeDelivered') includeDelivered?: string,
  ) {
    const t = tenantOf(tenantCode);
    const groups = await this.orders.deliveryList(t, {
      includeDelivered: includeDelivered === 'true' || includeDelivered === '1',
    });
    return {
      groups,
      totalPending: groups.reduce((s, g) => s + g.pendingCount, 0),
    };
  }

  /** 订单详情（含房间号） */
  @Get(':orderNo')
  async detail(@Param('tenantCode') tenantCode: string, @Param('orderNo') orderNo: string) {
    return { order: await this.orders.merchantOrderDetail(tenantOf(tenantCode), orderNo) };
  }

  @Post(':orderNo/accept')
  @HttpCode(200)
  async accept(@Param('tenantCode') tenantCode: string, @Param('orderNo') orderNo: string) {
    return { order: await this.orders.accept(tenantOf(tenantCode), orderNo, actor()) };
  }

  /** 标记送达。允许从「待接单」直达（商户取了货就走），不必先点接单。 */
  @Post(':orderNo/deliver')
  @HttpCode(200)
  async deliver(@Param('tenantCode') tenantCode: string, @Param('orderNo') orderNo: string) {
    return { order: await this.orders.deliver(tenantOf(tenantCode), orderNo, actor()) };
  }

  /** 批量送达（配送清单"一趟送完一键清"）：逐单独立成败，不因一单失败全批回滚 */
  @Post('deliver-batch')
  @HttpCode(200)
  async deliverBatch(@Param('tenantCode') tenantCode: string, @Body() body: { orderNos?: string[] }) {
    const list = (body?.orderNos ?? []).filter(Boolean);
    if (!list.length) throw new BizError(ERR.VALIDATION_FAILED, '请选择要标记送达的订单');
    if (list.length > 100) throw new BizError(ERR.VALIDATION_FAILED, '一次最多标记 100 单');
    return this.orders.deliverBatch(tenantOf(tenantCode), list, actor());
  }

  /**
   * 拒单。
   * **没有"直接取消"这条路** —— 钱已收就必须原路退回，所以它等价于发起退款。
   * 这是状态机不变量 ① 在接口层的体现。
   */
  @Post(':orderNo/reject')
  @HttpCode(200)
  async reject(
    @Param('tenantCode') tenantCode: string,
    @Param('orderNo') orderNo: string,
    @Body() body: { reason?: string },
  ) {
    return {
      order: await this.orders.rejectByMerchant(
        tenantOf(tenantCode), orderNo, actor(), body?.reason ?? '商户拒单',
      ),
    };
  }

  @Post(':orderNo/refund/start')
  @HttpCode(200)
  async refundStart(@Param('tenantCode') tenantCode: string, @Param('orderNo') orderNo: string) {
    return { order: await this.orders.refundStart(tenantOf(tenantCode), orderNo, actor()) };
  }

  /** 退款到账：状态流转 + 未送达回库 + 服务费返还，三件事一起发生 */
  @Post(':orderNo/refund/done')
  @HttpCode(200)
  async refundDone(
    @Param('tenantCode') tenantCode: string,
    @Param('orderNo') orderNo: string,
    @Body() body: { refundCents: number },
  ) {
    const cents = Number(body?.refundCents);
    if (!Number.isInteger(cents) || cents <= 0) {
      throw new BizError(ERR.VALIDATION_FAILED, '退款金额必须为正整数分');
    }
    return this.orders.refundDone(tenantOf(tenantCode), orderNo, cents, actor());
  }

  @Post(':orderNo/refund/reject')
  @HttpCode(200)
  async refundReject(@Param('tenantCode') tenantCode: string, @Param('orderNo') orderNo: string) {
    return { order: await this.orders.refundReject(tenantOf(tenantCode), orderNo, actor()) };
  }

  /* ------------------------------------------------------------------ 定时任务手动触发 */

  /**
   * 手动跑一次"超时关单"。
   * 定时任务必须能手动触发 —— 否则验证「30 分钟未支付自动关闭」只能真的等 30 分钟，
   * 那种验证实际上永远不会被执行。
   */
  @Post('jobs/close-expired')
  @HttpCode(200)
  async closeExpired(@Param('tenantCode') tenantCode: string, @Query('now') now?: string) {
    return this.orders.closeExpired(tenantOf(tenantCode), injectedNow(now));
  }

  /** 手动跑一次"送达兜底"（配送中超时自动置为已送达） */
  @Post('jobs/auto-complete')
  @HttpCode(200)
  async autoComplete(@Param('tenantCode') tenantCode: string, @Query('now') now?: string) {
    return this.orders.autoCompleteStuck(tenantOf(tenantCode), injectedNow(now));
  }
}

/** 操作人标识（进审计日志）。店主令牌没有用户 id，用角色 + 租户标识。 */
function actor(): string {
  const ctx = currentContext();
  return ctx?.tenantCode ? `owner:${ctx.tenantCode}` : 'owner';
}

/**
 * 定时任务的 `now` 注入。
 * 只为了让"30 分钟未支付自动关闭""12 小时没点送达自动完成"这两条能被真实验收 ——
 * 否则只能干等 30 分钟 / 12 小时，那种验证实际永远不会被执行。
 * 业务时间敏感判断（能不能下单）仍然只用服务端时间，不开放注入。
 */
function injectedNow(raw?: string): Date {
  if (!raw) return new Date();
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new BizError(ERR.VALIDATION_FAILED, `now 不是合法时间：${raw}`);
  return d;
}
