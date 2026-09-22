import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { DeployService } from './deploy.service';
import { PipelineService } from './pipeline.service';
import { assertNoTenantPrivateFields } from '../core/logger';

/**
 * 上线流水线 / 返工队列（P-04 / P-05）。
 *
 * 平台侧路由统一挂 `/api/platform`，由 TenantRouterMiddleware 的 `x-platform-key` 把关。
 * ⚠️ 过渡方案：上线前换账号体系 + RBAC + 操作审计（与密钥、停用一起替换）。
 */
@Controller('api/platform/pipeline')
export class PlatformPipelineController {
  constructor(private readonly pipeline: PipelineService) {}

  /** 看板：全平台卡点总览 + 12 阶段定义（前端据此画横向步骤条） */
  @Get('board')
  async board() {
    return this.guard(await this.pipeline.board());
  }

  /** 返工队列：驳回未重提的单，按等待天数降序 */
  @Get('rework')
  async rework() {
    return this.guard(await this.pipeline.reworkQueue());
  }

  /** 单租户流水线 */
  @Get(':tenantCode')
  async ofTenant(@Param('tenantCode') tenantCode: string) {
    return this.guard(await this.pipeline.ofTenant(tenantCode));
  }

  /** 推进：完成某阶段 → 自动把下一阶段置为进行中 */
  @Post(':tenantCode/stages/:stageNo/complete')
  @HttpCode(200)
  async complete(
    @Param('tenantCode') tenantCode: string,
    @Param('stageNo') stageNo: string,
    @Body() body: { remark?: string | null },
  ) {
    return this.guard(await this.pipeline.complete(tenantCode, Number(stageNo), body?.remark ?? null));
  }

  /**
   * 驳回。
   * 界面上这条用**琥珀不用红** —— 驳回是正常流程，不是异常（§5 状态宪法）。
   */
  @Post(':tenantCode/stages/:stageNo/reject')
  @HttpCode(200)
  async reject(
    @Param('tenantCode') tenantCode: string,
    @Param('stageNo') stageNo: string,
    @Body() body: { reason: string },
  ) {
    return this.guard(await this.pipeline.reject(tenantCode, Number(stageNo), body?.reason ?? ''));
  }

  /** 重提：驳回 → 进行中，驳回原因保留作为返工依据 */
  @Post(':tenantCode/stages/:stageNo/resubmit')
  @HttpCode(200)
  async resubmit(@Param('tenantCode') tenantCode: string, @Param('stageNo') stageNo: string) {
    return this.guard(await this.pipeline.resubmit(tenantCode, Number(stageNo)));
  }

  /** 记录触达（催办）—— 推进权在商户手上，催办是平台唯一能做的事 */
  @Post(':tenantCode/stages/:stageNo/touch')
  @HttpCode(200)
  async touch(
    @Param('tenantCode') tenantCode: string,
    @Param('stageNo') stageNo: string,
    @Body() body: { note?: string | null },
  ) {
    return this.guard(await this.pipeline.touch(tenantCode, Number(stageNo), body?.note ?? null));
  }

  /**
   * AC-13 的最后一道闸：平台侧任何响应都不允许出现房间号 / 楼层字段。
   *
   * 放在控制器层而不是服务层，是因为**这里是出网的最后一站** ——
   * 将来有人加了一个新接口忘了过服务层的选择性构造，
   * 只要它经过这里就一定被拦下。护栏要在最窄的地方。
   */
  private guard<T>(payload: T): T {
    const leaks = assertNoTenantPrivateFields(payload);
    if (leaks.length) {
      throw new Error(`平台侧响应含租户私有字段，已阻断（AC-13）：${leaks.join(', ')}`);
    }
    return payload;
  }
}

/** 版本与发布看板 + 灰度推送（P-06 / P-07 / CP-03 / CP-04） */
@Controller('api/platform/deploy')
export class PlatformDeployController {
  constructor(private readonly deploy: DeployService) {}

  @Get('board')
  async board(@Query('filter') filter?: 'all' | 'stale' | 'unsubmitted' | 'failed') {
    return this.deploy.board(filter ?? 'all');
  }

  @Get('versions')
  async versions() {
    return { items: await this.deploy.listVersions() };
  }

  @Post('versions')
  @HttpCode(200)
  async createVersion(@Body() body: { version: string; note?: string | null }) {
    return this.deploy.createVersion(body?.version ?? '', body?.note ?? null);
  }

  @Get('batches')
  async batches() {
    return this.deploy.listBatches();
  }

  /** 灰度状态：批量推送的放行依据（前端据此显示"能不能全量了"） */
  @Get('versions/:versionId/gray-state')
  async grayState(@Param('versionId') versionId: string) {
    return this.deploy.grayStateOf(Number(versionId));
  }

  /** 推送（灰度最多 2 家；批量必须先灰度通过） */
  @Post('push')
  @HttpCode(200)
  async push(
    @Body()
    body: {
      versionId: number;
      tenantCodes: string[];
      exclude?: string[];
      kind: 'gray' | 'batch';
      operator?: string;
      confirmedGrayPassed?: boolean;
    },
  ) {
    return this.deploy.push({
      versionId: Number(body?.versionId),
      tenantCodes: body?.tenantCodes ?? [],
      exclude: body?.exclude ?? [],
      kind: body?.kind ?? 'gray',
      operator: body?.operator ?? 'platform',
      confirmedGrayPassed: body?.confirmedGrayPassed ?? false,
    });
  }

  @Post('batches/:batchId/rollback')
  @HttpCode(200)
  async rollback(
    @Param('batchId') batchId: string,
    @Body() body: { previousVersionId: number; operator?: string },
  ) {
    return this.deploy.rollback(Number(batchId), body?.operator ?? 'platform', Number(body?.previousVersionId));
  }

  /** 商户提审 / 发布后回填（推动权在商户，平台侧只能记） */
  @Post(':tenantCode/version/:version/submitted')
  @HttpCode(200)
  async submitted(@Param('tenantCode') tenantCode: string, @Param('version') version: string) {
    return this.deploy.markSubmitted(tenantCode, version);
  }

  @Post(':tenantCode/version/:version/published')
  @HttpCode(200)
  async published(@Param('tenantCode') tenantCode: string, @Param('version') version: string) {
    return this.deploy.markPublished(tenantCode, version);
  }
}
