import { env, isProd } from './env';
import { MemoryRepoFactory } from './memory.repository';
import type { RepoFactory } from './repository';

/**
 * 仓储工厂的构造入口。
 *
 * DB_MODE=memory（默认）—— 内存实现，本机 / CI 可真实跑完整 HTTP 链路。
 * DB_MODE=mysql        —— 生产实现，本阶段**尚未交付**（见下方说明）。
 *
 * 为什么 mysql 分支先抛错而不是"写了但没验证"：
 *   本机无 Docker、无 MySQL（已实测），任何 Prisma 实现都无法在此执行哪怕一次。
 *   交付一段从未运行过的数据库访问层，比明确标记"未交付"更危险 ——
 *   它会让人以为库存扣减、租户路由这些最不可返工的部分已经验证过了。
 *   D2 接入 MySQL 后补齐，届时接口与行为契约已由内存实现钉死。
 */
export function createRepoFactory(): RepoFactory {
  if (env.dbMode === 'memory') {
    return new MemoryRepoFactory();
  }

  throw new Error(
    [
      'DB_MODE=mysql 尚未交付：Prisma 仓储层将在 D2 随 MySQL 环境一起接入。',
      `当前 PLATFORM_DATABASE_URL = ${env.platformDatabaseUrl || '(空)'}`,
      '接入步骤：',
      '  1) 起 MySQL 8（deploy/docker-compose.yml 已就绪）',
      '  2) npm run db:generate -w @snack/server   # 生成 platform / tenant 两套 client',
      '  3) npm run db:migrate:platform -w @snack/server',
      '  4) 每个租户库执行 npm run db:migrate:tenant -w @snack/server',
      isProd ? '   5) 生产环境禁止使用 memory 模式' : '',
    ].filter(Boolean).join('\n'),
  );
}

export const REPO_FACTORY = Symbol('REPO_FACTORY');
