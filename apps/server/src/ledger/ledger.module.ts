import { Module } from '@nestjs/common';
import { LedgerService } from './ledger.service';
import { PlatformLedgerController } from './platform-ledger.controller';
import { TenantBillingController } from './tenant-billing.controller';

/**
 * 账本模块 —— **我方唯一的收钱通道**。
 *
 * 放在独立模块（而不是塞进 CoreModule）的理由：账本是有边界的一块，
 * 入口只有"充值 / 扣减 / 返还 / 对账"四条；独立成模块后，
 * 谁在动钱一眼能从依赖图上看出来。
 *
 * 它依赖 CoreModule 提供的 REPO_FACTORY 与 AppLogger（全局模块），所以这里不 import 任何东西。
 *
 * 定时任务（JobsService）在 S7 搬到了 `src/jobs/`：那个调度器要同时看账本域与订单域，
 * 留在本模块会与 OrderModule 形成循环依赖。**账本模块因此变得只有"钱"**，
 * 这反而更接近它原本的边界。
 */
@Module({
  controllers: [PlatformLedgerController, TenantBillingController],
  providers: [LedgerService],
  exports: [LedgerService],
})
export class LedgerModule {}
