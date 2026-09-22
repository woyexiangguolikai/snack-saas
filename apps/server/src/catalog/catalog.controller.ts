import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ERR, BizError } from '../core/errors';
import { currentContext } from '../core/logger';
import { OwnerWriteGuard } from '../core/owner.guard';
import { tenantOf } from '../core/tenant-scope';
import { ProductService } from './product.service';
import { StockService } from './stock.service';
import type { ProductRecord } from '../core/types';

/**
 * 商户端商品与库存接口 —— **一套 API 同时服务商户小程序与商户网页端**（§1）。
 *
 * 路由前缀沿用 `t/:tenantCode/api/...`：租户号在 URL 里，所以每个方法第一件事
 * 都是 `tenantOf()` 做作用域断言，没有例外。
 *
 * `OwnerWriteGuard`：写接口要求店主身份。改价、改库存、上下架这些**绝不能**
 * 让持学生令牌的人调到 —— 之前只校验租户，等于把定价权开放给了所有学生。
 * 读接口（`storefront` 学生要用、`matrix` 商户要看）放行，见 guard 的注释。
 */
@Controller('t/:tenantCode/api/catalog')
@UseGuards(OwnerWriteGuard)
export class CatalogController {
  constructor(
    private readonly products: ProductService,
    private readonly stock: StockService,
  ) {}

  /* ------------------------------------------------------------------ 品类 */

  @Get('categories')
  async categories(@Param('tenantCode') tenantCode: string) {
    return { items: await this.products.listCategories(tenantOf(tenantCode)) };
  }

  /* ------------------------------------------------------------------ 商品 */

  @Get('products')
  async listProducts(
    @Param('tenantCode') tenantCode: string,
    @Query('includeOff') includeOff?: string,
  ) {
    const items = await this.products.listProducts(tenantOf(tenantCode), {
      includeOff: includeOff === '1' || includeOff === 'true',
    });
    return { items };
  }

  @Post('products')
  async createProduct(
    @Param('tenantCode') tenantCode: string,
    @Body()
    body: {
      name: string;
      spec?: string | null;
      cover?: string | null;
      priceCents: number;
      categoryId?: number | null;
      sort?: number;
      buildingIds?: number[];
    },
  ) {
    return { product: await this.products.create(tenantOf(tenantCode), body) };
  }

  @Patch('products/:id')
  async updateProduct(
    @Param('tenantCode') tenantCode: string,
    @Param('id', ParseIntPipe) id: number,
    @Body()
    body: Partial<Pick<ProductRecord, 'name' | 'spec' | 'cover' | 'priceCents' | 'categoryId' | 'sort' | 'status'>>,
  ) {
    return { product: await this.products.update(tenantOf(tenantCode), id, body) };
  }

  /** 全局上架 / 下架（区别于"某栋下架"） */
  @Post('products/:id/status')
  async setProductStatus(
    @Param('tenantCode') tenantCode: string,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { status: 'active' | 'off' },
  ) {
    if (body?.status !== 'active' && body?.status !== 'off') {
      throw new BizError(ERR.VALIDATION_FAILED, 'status 只能是 active / off');
    }
    return { product: await this.products.setStatus(tenantOf(tenantCode), id, body.status) };
  }

  /* ------------------------------------------------------- 库存矩阵与流水 */

  /** 商户后台核心页：商品 × 楼栋 一张表，含三态与双重编码 */
  @Get('matrix')
  async matrix(@Param('tenantCode') tenantCode: string, @Query('includeOff') includeOff?: string) {
    return this.stock.matrix(tenantOf(tenantCode), {
      includeOff: includeOff === '1' || includeOff === 'true',
    });
  }

  /** 学生端取该栋商品列表（hidden 一律过滤） */
  @Get('storefront')
  async storefront(
    @Param('tenantCode') tenantCode: string,
    @Query('buildingId', ParseIntPipe) buildingId: number,
    @Query('categoryId') categoryId?: string,
    @Query('keyword') keyword?: string,
  ) {
    return {
      items: await this.stock.listForBuilding(tenantOf(tenantCode), buildingId, {
        categoryId: categoryId ? Number(categoryId) : undefined,
        keyword,
      }),
    };
  }

  @Get('stock-logs')
  async logs(
    @Param('tenantCode') tenantCode: string,
    @Query('productId') productId?: string,
    @Query('buildingId') buildingId?: string,
    @Query('limit') limit?: string,
  ) {
    return {
      items: await this.stock.logs(tenantOf(tenantCode), {
        productId: productId ? Number(productId) : undefined,
        buildingId: buildingId ? Number(buildingId) : undefined,
        limit: limit ? Number(limit) : undefined,
      }),
    };
  }

  /** 库存自洽核对 —— 差额必须为 0，等价于账本那一条 */
  @Get('stock-reconcile')
  async reconcile(@Param('tenantCode') tenantCode: string, @Query('buildingId') buildingId?: string) {
    return this.stock.reconcile(tenantOf(tenantCode), buildingId ? Number(buildingId) : undefined);
  }

  /* ------------------------------------------------------------ 库存迁移操作 */

  /** 下单预占（正式下单流程会由订单服务调用；此处也开出来便于联调与后台补录） */
  @Post('stocks/hold')
  async hold(
    @Param('tenantCode') tenantCode: string,
    @Body() body: { productId: number; buildingId: number; qty: number; orderNo: string },
  ) {
    return { cell: await this.stock.hold(tenantOf(tenantCode), body) };
  }

  @Post('stocks/confirm-paid')
  async confirmPaid(
    @Param('tenantCode') tenantCode: string,
    @Body() body: { productId: number; buildingId: number; qty: number; orderNo: string },
  ) {
    return { cell: await this.stock.confirmPaid(tenantOf(tenantCode), body) };
  }

  @Post('stocks/release')
  async release(
    @Param('tenantCode') tenantCode: string,
    @Body() body: { productId: number; buildingId: number; qty: number; orderNo: string; by: 'user' | 'timeout' },
  ) {
    return { cell: await this.stock.release(tenantOf(tenantCode), body) };
  }

  @Post('stocks/refund-return')
  async refundReturn(
    @Param('tenantCode') tenantCode: string,
    @Body() body: { productId: number; buildingId: number; qty: number; orderNo: string },
  ) {
    return { cell: await this.stock.returnOnRefund(tenantOf(tenantCode), body) };
  }

  /** 人工调整（盘点纠偏）—— 必带理由与操作人。低频、影响面大，必须说得清是谁为什么改的 */
  @Post('stocks/adjust')
  async adjust(
    @Param('tenantCode') tenantCode: string,
    @Body() body: { productId: number; buildingId: number; stock: number; reason: string; operator: string },
  ) {
    return { cell: await this.stock.adjust(tenantOf(tenantCode), body) };
  }

  /**
   * 手机端「库存快改」（CM-05）—— 与上面的 `adjust` **刻意分成两个接口**。
   *
   * 为什么不给 adjust 加一个"理由可缺省"的开关：
   *   理由可缺省意味着"库存对不上时查不到是谁为什么改的"，而这条纪律正是
   *   为了在月底对账时能回答这个问题。为了省一个弹窗把它开掉，是拿可追溯性换手感。
   *
   * 分成两个接口后，纪律两边都成立：
   *   · `adjust` —— 网页端盘点纠偏，理由必填；
   *   · `quick-set` —— 手机端快改，理由由服务端固定为「快速修改」、操作人取当前店主。
   *     仍然是**留痕**的，只是不要求人手填 —— 因为它是高频、小幅、当场可逆的动作。
   */
  @Post('stocks/quick-set')
  async quickSet(
    @Param('tenantCode') tenantCode: string,
    @Body() body: { productId: number; buildingId: number; stock: number },
  ) {
    if (!Number.isInteger(body?.stock) || body.stock < 0) {
      throw new BizError(ERR.VALIDATION_FAILED, '库存必须为非负整数');
    }
    return {
      cell: await this.stock.adjust(tenantOf(tenantCode), {
        productId: body.productId,
        buildingId: body.buildingId,
        stock: body.stock,
        reason: '快速修改',
        operator: ownerLabel(),
      }),
    };
  }

  /** 跨栋调拨（例外不是常态 —— 入口做成次级，不放在矩阵主操作位） */
  @Post('stocks/transfer')
  async transfer(
    @Param('tenantCode') tenantCode: string,
    @Body()
    body: { productId: number; fromBuildingId: number; toBuildingId: number; qty: number; operator?: string },
  ) {
    return this.stock.transfer(tenantOf(tenantCode), body);
  }

  /* --------------------------------------------------- 两个"同步"语义（AC-10） */

  /**
   * 同步上架 —— 只改上下架状态，**不改库存数值**。
   * 返回值里带 `doesNotChange`，界面必须把它显示出来。
   */
  @Post('sync/publish')
  async syncPublish(
    @Param('tenantCode') tenantCode: string,
    @Body() body: { productId: number; targetBuildingIds?: number[]; status: 'on' | 'off' },
  ) {
    return this.stock.syncPublish(tenantOf(tenantCode), body);
  }

  /**
   * 同步库存 —— 只改库存数值，**不改上下架状态**。
   * 未上架的楼栋会被跳过并在 `skipped` 里说明原因。
   */
  @Post('sync/stock')
  async syncStock(
    @Param('tenantCode') tenantCode: string,
    @Body()
    body: { productId: number; fromBuildingId: number; targetBuildingIds?: number[]; mode?: 'value' | 'delta' },
  ) {
    return this.stock.syncStock(tenantOf(tenantCode), body);
  }

  /** 一键配置多栋（建商品后的常态操作） */
  @Post('bulk')
  async bulk(
    @Param('tenantCode') tenantCode: string,
    @Body()
    body: { productId: number; buildingIds: number[]; stock?: number; status?: 'on' | 'off'; warnStock?: number | null },
  ) {
    return this.stock.bulkUpsert(tenantOf(tenantCode), body);
  }
}

/** 操作人标识（进库存流水）。缺省时用它，保证"谁改的"永远有答案 */
function ownerLabel(): string {
  const ctx = currentContext();
  return ctx?.tenantCode ? `owner:${ctx.tenantCode}` : 'owner';
}
