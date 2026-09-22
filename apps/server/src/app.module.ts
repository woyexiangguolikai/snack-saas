import { MiddlewareConsumer, Module, RequestMethod, type NestModule } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { CatalogModule } from './catalog/catalog.module';
import { CoreModule } from './core/core.module';
import { HealthController } from './core/health.controller';
import { LedgerModule } from './ledger/ledger.module';
import { NoticeModule } from './notice/notice.module';
import { OrderModule } from './order/order.module';
import { PlatformController } from './platform/platform.controller';
import { TenantResolveController } from './platform/tenant.controller';
import { BuildingController } from './tenant/building.controller';
import { ConfigController, TimeWindowController } from './tenant/config.controller';
import { TenantRouterMiddleware } from './tenant/tenant-router.middleware';

/**
 * 模块划分按"谁能动什么"来切，而不是按技术分层：
 *   CoreModule     —— 仓储 / 日志 / 租户上下文（每个请求都要）
 *   AuthModule     —— 登录与令牌
 *   LedgerModule   —— **我方唯一的收钱通道**
 *   CatalogModule  —— 商品 / 库存
 *   OrderModule    —— 订单状态机（唯一会同时动库存和钱的地方）
 *   NoticeModule   —— 站内消息兜底 + 订阅消息授权凭证（依赖方：OrderModule）
 * 这样"钱被谁动过"在依赖图上是一眼可见的。
 */
@Module({
  imports: [CoreModule, AuthModule, LedgerModule, CatalogModule, NoticeModule, OrderModule],
  controllers: [
    HealthController,
    TenantResolveController,
    PlatformController,
    BuildingController,
    ConfigController,
    TimeWindowController,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // TenantRouter 覆盖全部路由：它同时负责 requestId、租户解析、令牌校验与请求日志
    consumer.apply(TenantRouterMiddleware).forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}
