import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { DeployService } from './deploy.service';
import { MonitorService } from './monitor.service';
import { PipelineService } from './pipeline.service';
import {
  PlatformDeployController,
  PlatformPipelineController,
} from './platform-pipeline.controller';
import {
  PlatformAlertController,
  PlatformSecretController,
  PlatformTicketController,
} from './platform-ops.controller';
import { SecretService } from './secret.service';
import { TenantAdminService } from './tenant-admin.service';
import { TicketService } from './ticket.service';

/**
 * 平台侧模块（S6）。
 *
 * 独立成模块而不是继续堆在 AppModule：这里的每一件东西的**使用者只有我方**，
 * 与学生端 / 商户端毫无交集。分开之后，"平台能碰什么"在依赖图上是一眼可见的 ——
 * 这也是 AC-13（房间号不出租户库）能被审查的前提。
 *
 * 依赖方向：PlatformModule → LedgerModule（要读账本做闸门与对账）。
 * **绝不反向**：账本模块不该知道"平台后台"这个东西存在。
 */
@Module({
  imports: [LedgerModule],
  controllers: [
    PlatformPipelineController,
    PlatformDeployController,
    PlatformSecretController,
    PlatformAlertController,
    PlatformTicketController,
  ],
  providers: [PipelineService, DeployService, SecretService, MonitorService, TicketService, TenantAdminService],
  exports: [PipelineService, DeployService, SecretService, MonitorService, TicketService, TenantAdminService],
})
export class PlatformModule {}
