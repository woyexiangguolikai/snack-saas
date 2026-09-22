import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ERR, BizError } from '../core/errors';
import { OrderService } from './order.service';

/**
 * 支付结果回调（**内部端点**，需平台密钥）。
 *
 * 为什么不直接暴露成微信能调的公网回调：
 * 微信的回调必须验签（`WXPay-Signature` + 平台证书），验签失败的一律不能进业务层。
 * 那一步属于**支付通道适配器**的职责，而"支付成功后订单该怎么动"属于订单域的职责。
 * 混在一起的结果是：业务层里散落着验签代码，而验签一旦漏一处就是白送钱。
 *
 * 所以现在这样切：
 *   微信 → [适配器：验签 + 解密 + 转成内部结构] → **本端点** → OrderService.onPayCallback
 * 适配器要等你的微信支付商户号下来后接（见 README 的"待接入"清单）。
 * 在此之前，本端点由平台密钥保护，用于联调与自动化验收 —— 它本身就是那条链路的末端，
 * 适配器接上后**不需要改这个文件**。
 *
 * ⚠️ 幂等与金额校验都在 OrderService 里，不在这一层做 ——
 * 换个入口（定时对账补单、人工补录）时同样需要这两道，放服务层才能都覆盖到。
 */
@Controller('api/platform/pay')
export class PayCallbackController {
  constructor(private readonly orders: OrderService) {}

  @Post(':tenantCode/callback')
  @HttpCode(200)
  async callback(
    @Param('tenantCode') tenantCode: string,
    @Body()
    body: { orderNo?: string; txnId?: string; amountCents?: number; paidAt?: string },
  ) {
    if (!body?.orderNo) throw new BizError(ERR.VALIDATION_FAILED, '缺少 orderNo');
    if (!body?.txnId) throw new BizError(ERR.VALIDATION_FAILED, '缺少支付流水号 txnId');
    if (!Number.isInteger(body?.amountCents)) {
      throw new BizError(ERR.VALIDATION_FAILED, '缺少或非法的 amountCents');
    }

    const r = await this.orders.onPayCallback(tenantCode, {
      orderNo: body.orderNo,
      txnId: body.txnId,
      amountCents: body.amountCents as number,
      paidAt: body.paidAt ? new Date(body.paidAt) : undefined,
    });

    // 微信要求回调响应体是 {code:'SUCCESS'} 之类的确认结构；
    // 这里同时带上我们的处理结果，便于联调时一眼看出是"首次处理"还是"重复回调"。
    return { code: 'SUCCESS', idempotent: r.idempotent, repaired: r.repaired, orderNo: r.order.orderNo, status: r.order.status };
  }
}
