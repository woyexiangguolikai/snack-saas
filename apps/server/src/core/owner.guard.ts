import { Injectable, type CanActivate } from '@nestjs/common';
import { requireOwner } from './logger';

/* ============================================================================
 * 店主守卫
 * ----------------------------------------------------------------------------
 * 为什么用守卫而不是在每个处理器里写一行 `requireOwner()`：
 *
 * 后者的问题不是"啰嗦"，而是**默认不安全** —— 新加一个接口时忘了写那一行，
 * 它就默默对学生开放了。这种事不会在开发时暴露（你测试时用的就是店主令牌），
 * 要等某个学生发现"我能改价格"才炸。
 *
 * 守卫是**默认拒绝**：整个控制器挂上去，写了才例外。
 * 新增接口时如果方法不是 GET，就自动受保护 —— 不需要记得做任何事。
 *
 * 只读方法（GET/HEAD/OPTIONS）放行，因为学生端必须能读配置、读楼栋、读商品。
 * ⚠️ 代价是"读接口里的商户专属字段"没有保护（比如库存矩阵里的 `sold` 累计）。
 *    这一项留给 S7 边界兜底：需要的是**字段级**裁剪，而不是另一个守卫。
 * ==========================================================================*/

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** 写操作需要店主身份；读操作放行。用于商户端与学生端共用同一控制器的场景。 */
@Injectable()
export class OwnerWriteGuard implements CanActivate {
  canActivate(ctx: import('@nestjs/common').ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ method?: string }>();
    if (READ_METHODS.has(String(req?.method ?? 'GET').toUpperCase())) return true;
    requireOwner();
    return true;
  }
}

/** 全部方法都要求店主身份（用于纯粹商户端、学生根本不该碰的接口） */
@Injectable()
export class OwnerGuard implements CanActivate {
  canActivate(): boolean {
    requireOwner();
    return true;
  }
}
