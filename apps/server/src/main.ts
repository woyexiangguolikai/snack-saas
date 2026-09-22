import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { env, isProd } from './core/env';
import { AllExceptionsFilter } from './core/exception.filter';
import { AppLogger } from './core/logger';
import { createRepoFactory } from './core/repo.factory';

async function bootstrap(): Promise<void> {
  if (isProd && env.dbMode === 'memory') {
    throw new Error('生产环境禁止 DB_MODE=memory —— 内存仓储不提供任何持久化保证');
  }

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = app.get(AppLogger);
  app.useLogger(logger);
  app.useGlobalFilters(new AllExceptionsFilter(logger));

  // 小程序端不需要 CORS；商户网页与平台后台同域部署，开发期放开便于本地联调
  if (!isProd) app.enableCors({ origin: true, credentials: true });

  await app.listen(env.port, '0.0.0.0');

  const repos = createRepoFactory();
  logger.log(`服务已启动 http://127.0.0.1:${env.port}`, {
    dbMode: env.dbMode,
    repos: repos.describe(),
    tenantPathPrefix: `${env.tenantPathPrefix}/{tenantCode}/api`,
  });
}

void bootstrap();
