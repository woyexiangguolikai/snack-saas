import { Controller, Get, Param, Query } from '@nestjs/common';
import { LedgerService } from './ledger.service';
import { AppLogger, assertNoTenantPrivateFields } from '../core/logger';
import { tenantOf } from '../core/tenant-scope';

/**
 * 商户端账单路由（商户看自己的钱）。
 *
 * 路由前缀必须与其它租户侧控制器一致：`t/:tenantCode/api/billing`。
 * 这里不重复做归属判断 —— tenantOf() 是唯一的实现（中间件已校验路径/令牌一致，
 * 它是第二道显式断言）。多个实现迟早会出现"某个控制器用了较松的那份"。
 *
 * 另外：账单里**绝不能出现房间号**（AC-13）。平台库的订单汇总只到楼栋级，
 * 这里出参再过一遍私有字段断言 —— 防止将来有人在账单里加"配送地址"。
 */
@Controller('t/:tenantCode/api/billing')
export class TenantBillingController {
  constructor(
    private readonly ledger: LedgerService,
    private readonly logger: AppLogger,
  ) {}

  /** 账单首页：余额 / 服务期 / 待结算 / 流水 / 结算批次 */
  @Get()
  async billing(@Param('tenantCode') pathTenant: string, @Query('txnLimit') txnLimit?: string) {
    const tenantCode = tenantOf(pathTenant);
    const view = await this.ledger.billingView(tenantCode, { txnLimit: txnLimit ? Number(txnLimit) : 50 });
    return this.guardOutput(view);
  }

  /** 待结算（尚未扣服务费的订单） */
  @Get('pending')
  async pending(@Param('tenantCode') pathTenant: string) {
    return this.ledger.pendingFees(tenantOf(pathTenant));
  }

  /** 流水明细，可按类型过滤 */
  @Get('txns')
  async txns(
    @Param('tenantCode') pathTenant: string,
    @Query('type') type?: string,
    @Query('limit') limit?: string,
  ) {
    const tenantCode = tenantOf(pathTenant);
    const view = await this.ledger.billingView(tenantCode, { txnLimit: limit ? Number(limit) : 100 });
    return { items: type ? view.txns.filter((t) => t.type === type) : view.txns };
  }

  /** 结算批次列表 */
  @Get('runs')
  async runs(@Param('tenantCode') pathTenant: string) {
    const view = await this.ledger.billingView(tenantOf(pathTenant));
    return { items: view.runs };
  }

  /** 展开某个批次的订单明细 —— 「这笔服务费扣的是哪些单」 */
  @Get('runs/:runId')
  async runDetail(@Param('tenantCode') pathTenant: string, @Param('runId') runId: string) {
    return this.ledger.expandRun(tenantOf(pathTenant), Number(runId));
  }

  /** 账期账单 */
  @Get('statements')
  async statements(@Param('tenantCode') pathTenant: string, @Query('period') period?: string) {
    const tenantCode = tenantOf(pathTenant);
    if (period) return { statement: await this.ledger.buildStatement(tenantCode, period) };
    return { items: await this.ledger.listStatements(tenantCode) };
  }

  /** 出参兜底：账单不该出现任何租户私有字段（房间号 / 楼层 / 门牌，AC-13） */
  private guardOutput<T>(payload: T): T {
    const leaks = assertNoTenantPrivateFields(payload);
    if (leaks.length) {
      this.logger.error('账单出参含租户私有字段，已阻断', { leaks });
      throw new Error(`账单出参含租户私有字段：${leaks.join(', ')}`);
    }
    return payload;
  }
}
