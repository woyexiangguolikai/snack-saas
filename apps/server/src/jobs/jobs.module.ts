import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { OrderModule } from '../order/order.module';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';

/**
 * 调度模块（S7）。
 *
 * 它**同时**依赖账本域与订单域，所以放在两者之上 —— 这正好是它的职责：
 * "什么时候该跑什么"这个问题的答案，天生要看到两个域。
 *
 * 依赖方向：JobsModule → OrderModule → LedgerModule，单一方向，无环。
 * 反向（把调度塞进任一域）会立刻形成 Ledger ↔ Order 循环依赖。
 */
@Module({
  imports: [LedgerModule, OrderModule],
  controllers: [JobsController],
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}
