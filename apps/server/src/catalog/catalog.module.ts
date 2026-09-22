import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { ProductService } from './product.service';
import { StockService } from './stock.service';

/**
 * 商品与库存模块。
 *
 * 拆成独立模块的理由：它是"货"的边界，与账本（"钱"）平行。
 * 订单域将来会同时依赖这两个模块 —— 下单要占货（StockService）也要判钱（LedgerService），
 * 但货和钱彼此不该互相依赖，否则会出现"改库存要注入账本"这种荒唐依赖。
 */
@Module({
  controllers: [CatalogController],
  providers: [ProductService, StockService],
  exports: [ProductService, StockService],
})
export class CatalogModule {}
