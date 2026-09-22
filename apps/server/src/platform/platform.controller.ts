import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { TenantService, type CreateTenantDto } from './tenant.service';
import { TenantAdminService } from './tenant-admin.service';
import { assertNoTenantPrivateFields } from '../core/logger';

/**
 * 平台后台路由。
 * 归属「我方」，权限由 TenantRouterMiddleware 的 x-platform-key 把关（上线前换账号体系）。
 */
@Controller('api/platform')
export class PlatformController {
  constructor(
    private readonly tenants: TenantService,
    private readonly admin: TenantAdminService,
  ) {}

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

  /**
   * 租户详情（P-02）。
   *
   * 出参过 `assertNoTenantPrivateFields` —— AC-13 要在**接口层**成立，
   * 不是"前端不显示"：抓包能看到的话，护栏就是假的。
   */
  @Get('tenants/:tenantCode/detail')
  async detail(@Param('tenantCode') tenantCode: string) {
    return this.guard(await this.admin.detail(tenantCode));
  }

  /** 强制停用 / 恢复（CP-07）—— 锁单但保留数据 */
  @Post('tenants/:tenantCode/status')
  @HttpCode(200)
  async setStatus(
    @Param('tenantCode') tenantCode: string,
    @Body() body: { action: 'suspend' | 'recover'; reason?: string | null; operator?: string },
  ) {
    return this.guard(
      await this.admin.setStatus(tenantCode, body?.action, body?.reason ?? null, body?.operator ?? 'platform'),
    );
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

  /* ------------------------------------------------- 学校与楼栋模板（P-13） */

  @Get('schools/templates')
  async schoolsWithTemplates() {
    return { items: await this.admin.listSchoolsWithTemplates() };
  }

  @Post('schools/templates')
  @HttpCode(200)
  async saveSchool(
    @Body() body: { id?: number; name: string; region: string; city?: string | null; buildingNames?: string[] },
  ) {
    return this.admin.saveSchool(body);
  }

  /** 已被租户引用时拒绝删除 —— 否则那些租户的详情页会显示空白且没人知道为什么 */
  @Post('schools/templates/:id/delete')
  @HttpCode(200)
  async deleteSchool(@Param('id') id: string) {
    return this.admin.deleteSchool(Number(id));
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

  /**
   * AC-13 的最后一道闸：平台侧任何响应都不允许出现房间号 / 楼层字段。
   *
   * 放在控制器层而不是服务层，是因为**这里是出网的最后一站** ——
   * 将来有人加了一个新接口、忘了锁字段，只要它经过这里就一定被拦下。
   * 护栏要放在最窄的地方。
   */
  private guard<T>(payload: T): T {
    const leaks = assertNoTenantPrivateFields(payload);
    if (leaks.length) {
      throw new Error(`平台侧响应含租户私有字段，已阻断（AC-13）：${leaks.join(', ')}`);
    }
    return payload;
  }
}
