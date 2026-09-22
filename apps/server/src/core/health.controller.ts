import { Controller, Get } from '@nestjs/common';
import { env } from './env';
import { currentContext } from './logger';
import { PIPELINE_STAGES } from './pipeline-stages';

@Controller('api/health')
export class HealthController {
  @Get()
  health() {
    const ctx = currentContext();
    return {
      ok: true,
      dbMode: env.dbMode,
      nodeEnv: env.nodeEnv,
      requestId: ctx?.requestId ?? null,
      // 流水线 12 阶段定义随健康检查暴露，方便前端/运维核对阶段未被改动
      pipelineStages: PIPELINE_STAGES.length,
      serverTime: new Date().toISOString(),
    };
  }
}
