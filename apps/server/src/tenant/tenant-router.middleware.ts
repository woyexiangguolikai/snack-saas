import { Injectable, type NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../core/env';
import { ERR, BizError } from '../core/errors';
import { verifyToken } from '../core/jwt';
import { ctxStore, AppLogger, type RequestContext } from '../core/logger';

/**
 * TenantRouter —— 每个请求的入口（§2.2）
 *
 * 单域名 + AppID 换租户；**绝不每租户一个子域名**（request 合法域名有数量上限，细节 25）。
 * 兜底路径前缀：/t/{tenant_code}/api/...
 *
 * 职责：
 *   1) 生成 requestId 并写入 AsyncLocalStorage（此后所有日志自动带 tenant_code，细节 34）
 *   2) 解析租户（路径前缀 > 请求头 > 无）
 *   3) 校验 token 与路径租户一致 —— 防止跨租户访问
 */
@Injectable()
export class TenantRouterMiddleware implements NestMiddleware {
  constructor(private readonly logger: AppLogger) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const requestId = (req.headers['x-request-id'] as string) || randomUUID();
    res.setHeader('x-request-id', requestId);

    const path = req.originalUrl.split('?')[0] ?? '';
    const m = new RegExp(`^${env.tenantPathPrefix}/([^/]+)/api(?:/|$)`).exec(path);
    const pathTenant = m?.[1] ?? null;
    const headerTenant = (req.headers['x-tenant-code'] as string) || null;

    const isPlatformRoute = path.startsWith(`${env.apiPrefix}/platform`);
    const isGlobalRoute = path.startsWith(`${env.apiPrefix}/tenant`) || path.startsWith(`${env.apiPrefix}/health`);

    const ctx: RequestContext = {
      requestId,
      tenantCode: pathTenant ?? headerTenant,
      role: 'anonymous',
      userId: null,
      dbMode: env.dbMode,
    };

    ctxStore.run(ctx, () => {
      try {
        if (isPlatformRoute) {
          this.assertPlatformKey(req);
          ctx.role = 'platform';
          ctx.tenantCode = null;
        } else if (!isGlobalRoute && ctx.tenantCode) {
          const payload = this.assertTenantToken(req);
          if (pathTenant && payload.tenantCode !== pathTenant) {
            this.logger.warn('跨租户访问被拦截', { tokenTenant: payload.tenantCode, pathTenant });
            throw BizError.forbidden(ERR.TOKEN_INVALID, '租户与令牌不匹配');
          }
          ctx.tenantCode = payload.tenantCode;
          ctx.role = payload.role;
          // 浏览令牌没有 sub —— 保持 null，让需要登录的接口自己拒绝
          ctx.userId = typeof payload.sub === 'number' ? payload.sub : null;
        }

        const started = Date.now();
        res.on('finish', () => {
          this.logger.log('http', {
            method: req.method,
            path: this.maskPath(path),
            status: res.statusCode,
            ms: Date.now() - started,
          });
        });
        next();
      } catch (e) {
        next(e);
      }
    });
  }

  /** 平台侧路径不含任何租户私有信息，直接打日志；但防止把 token 之类带出去 */
  private maskPath(path: string): string {
    return path.replace(/\/t\/[^/]+\//, '/t/{tenant}/');
  }

  private assertTenantToken(req: Request) {
    const raw = req.headers.authorization ?? '';
    const token = raw.startsWith('Bearer ') ? raw.slice(7) : '';
    if (!token) throw BizError.unauthorized(ERR.TOKEN_MISSING, '缺少会话令牌');
    const r = verifyToken(token, env.jwtSecret);
    if (!r.ok) throw BizError.unauthorized(ERR.TOKEN_INVALID, `会话令牌无效（${r.reason}）`);
    return r.payload;
  }

  /**
   * 平台后台鉴权。
   * ⚠️ 当前是单密钥方案，**上线前必须替换为账号体系 + RBAC + 操作审计**；
   * 之所以现在就加，是因为平台后台能建租户、推代码、停单，裸奔风险远大于开发便利。
   */
  private assertPlatformKey(req: Request): void {
    const key = (req.headers['x-platform-key'] as string) || '';
    if (key !== env.platformAdminKey) {
      throw BizError.unauthorized(ERR.TOKEN_INVALID, '平台密钥无效');
    }
  }
}
