import { currentTenantCode } from './logger';
import { ERR, BizError } from './errors';

/**
 * 租户作用域校验 —— 租户侧所有控制器共用的第一道闸。
 *
 * 为什么必须有：租户路由形如 `t/:tenantCode/api/...`，**租户号是 URL 里的入参**。
 * 如果控制器直接信任这个入参，那"改一下 URL 就能读别家的数据"。
 * 中间件已保证路径租户与令牌租户一致，这里是第二道显式断言 ——
 * 两道都便宜，而漏一道的后果是跨租户泄漏。
 *
 * 放在 core 而不是各控制器里各写一份：这条规则一旦有两个实现，
 * 迟早出现"某个控制器用了较松的那份"。
 */
export function tenantOf(pathTenant: string): string {
  const ctxTenant = currentTenantCode();
  if (!ctxTenant) throw BizError.unauthorized(ERR.TOKEN_MISSING, '缺少租户上下文');
  if (pathTenant !== ctxTenant) {
    throw BizError.forbidden(ERR.TOKEN_INVALID, '路径租户与令牌租户不一致');
  }
  return ctxTenant;
}
