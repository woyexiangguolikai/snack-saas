import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { NoticeModule } from '../notice/notice.module';
import { MerchantOrderController } from './merchant-order.controller';
import { OrderService } from './order.service';
import { PayCallbackController } from './pay-callback.controller';
import { AddressController, StudentOrderController } from './student-order.controller';

/**
 * 订单模块 —— 交易闭环。
 *
 * import LedgerModule 是因为**退款要返还服务费**：退款成功时订单域必须能调用
 * 账本的返还入口。这是唯一一处订单域反向依赖账本的地方，方向是明确且必要的
 *（反过来的话账本要懂"订单状态"，那才是错的）。
 * import NoticeModule 是因为**每次状态流转都要给学生留一条站内消息**（CS-13）：
 * 把写消息的动作放在触发方自己 dispatcher 里，迟早会有某条路径漏掉 ——
 * 而漏掉的路径不报错，只是"学生不知道货到了"。
 */
@Module({
  imports: [LedgerModule, NoticeModule],
  controllers: [
    StudentOrderController,
    AddressController,
    MerchantOrderController,
    PayCallbackController,
  ],
  providers: [OrderService],
  exports: [OrderService],
})
export class OrderModule {}
