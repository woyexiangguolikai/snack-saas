import { Global, Module } from '@nestjs/common';
import { createRepoFactory, REPO_FACTORY } from './repo.factory';
import { AppLogger } from './logger';
import { WechatService } from '../auth/wechat.service';
import { TenantService } from '../platform/tenant.service';
import { BuildingService } from '../tenant/building.service';

/**
 * 核心模块：仓储工厂 + 日志 + 跨端共享的服务。
 * 设为 @Global 是因为**每一个**请求处理都需要租户上下文与日志，
 * 逐模块 import 只会让人在某处漏掉一次（而漏掉的后果是跨租户读到数据）。
 */
@Global()
@Module({
  providers: [
    AppLogger,
    { provide: REPO_FACTORY, useFactory: createRepoFactory },
    // 微信登录是叶子服务（只依赖日志），且 TenantService 要用它 ——
    // 放这里而不是单独开模块，是为了避免 CoreModule ↔ AuthModule 的循环依赖
    WechatService,
    TenantService,
    BuildingService,
  ],
  exports: [AppLogger, REPO_FACTORY, WechatService, TenantService, BuildingService],
})
export class CoreModule {}
