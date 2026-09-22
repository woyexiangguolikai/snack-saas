import { Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { OwnerGuard } from '../core/owner.guard';
import { tenantOf } from '../core/tenant-scope';
import { TenantService } from '../platform/tenant.service';

/**
 * 商户会话动作 —— 目前只有一件事：为网页后台生成登录码。
 *
 * 挂在租户路径下并用 `OwnerGuard`：**生成登录码等价于签发一张 24 小时的店主令牌**，
 * 所以它和"改价""改库存"是同一档权限，绝不能让持学生令牌的人调到。
 */
@Controller('t/:tenantCode/api/merchant/session')
@UseGuards(OwnerGuard)
export class MerchantSessionController {
  constructor(private readonly tenants: TenantService) {}

  /**
   * 生成网页端登录码（6 位 · 5 分钟 · 一次性）。
   *
   * 返回里同时给出过期时间：只给一个码不给时间，店主不知道该快点敲还是可以慢慢来。
   */
  @Post('web-login-code')
  @HttpCode(200)
  async code(@Param('tenantCode') tenantCode: string) {
    const t = tenantOf(tenantCode);
    const r = await this.tenants.issueWebLoginCode(t);
    return { code: r.code, expiresAt: r.expiresAt, ttlSeconds: 300 };
  }
}
