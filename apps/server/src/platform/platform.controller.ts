import { Body, Controller, Get, Post } from '@nestjs/common';
import { TenantService, type CreateTenantDto } from './tenant.service';

/**
 * 平台后台路由。
 * 归属「我方」，权限由 TenantRouterMiddleware 的 x-platform-key 把关（上线前换账号体系）。
 */
@Controller('api/platform')
export class PlatformController {
  constructor(private readonly tenants: TenantService) {}

  /** 学校字典 + 楼栋模板（建租户向导第一步） */
  @Get('schools')
  async schools() {
    return { items: await this.tenants.listSchools() };
  }

  /** 租户列表 —— 两个账本状态同屏：订阅剩余天数 + 余额 */
  @Get('tenants')
  async list() {
    return { items: await this.tenants.listTenantsWithGates() };
  }

  /** 一键建租户：建库 → 初始化 → 带出学校楼栋模板 → 开户 → 生成 12 阶段流水线 */
  @Post('tenants')
  async create(@Body() body: CreateTenantDto) {
    const { tenant, buildings } = await this.tenants.createTenant(body);
    return {
      tenant,
      buildings,
      // 单楼栋商户自动降级提示（§4.9）
      singleBuildingMode: buildings.length <= 1,
    };
  }

  /** 设置商户主题色（必过对比度护栏，AC-06） */
  @Post('theme')
  async setTheme(@Body() body: { tenantCode: string; color: string }) {
    const guard = await this.tenants.setThemeColor(body.tenantCode, body.color);
    return {
      deepened: guard.deepened,
      submittedContrast: guard.submittedContrast,
      finalContrast: guard.finalContrast,
      notice: guard.notice,
      scale: guard.scale,
    };
  }
}
