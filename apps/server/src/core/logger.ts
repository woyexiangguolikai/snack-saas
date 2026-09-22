import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, type LoggerService as NestLoggerService } from '@nestjs/common';
import { ERR, BizError } from './errors';

/* ============================================================================
 * 请求上下文（TenantRouter 的载体）
 * ----------------------------------------------------------------------------
 * 用 AsyncLocalStorage 而不是把 tenantCode 一路当参数传：
 * 后者迟早会漏传一次，而漏传的后果是"日志混在一起"（细节 34）甚至跨租户读到数据。
 * ==========================================================================*/

export interface RequestContext {
  requestId: string;
  tenantCode: string | null;
  role: 'student' | 'owner' | 'platform' | 'anonymous';
  /**
   * 当前用户 id。**只有完成过登录的会话才有值**（纯浏览令牌为 null）。
   * 下单 / 地址 / 我的订单这类接口必须要求它非空 —— 否则任何人都能
   * 通过"不带登录"的方式写入数据，而那些数据后来会挂在一个不存在的用户名下。
   */
  userId: number | null;
  dbMode: 'memory' | 'mysql';
}

/**
 * 取当前用户 id。
 * 未登录时**抛 401**，而不是返回 null —— 返回 null 就迟早有人忘了判，
 * 于是数据被写进一个不存在的用户名下，事后无法追溯归属。
 */
export function requireUserId(): number {
  const id = ctxStore.getStore()?.userId;
  if (!id) throw BizError.unauthorized(ERR.LOGIN_REQUIRED, '请先登录后再操作');
  return id;
}

/** 要求店主身份。商户端全部接口都过这一道 —— 学生令牌不能接单、不能看别家订单。 */
export function requireOwner(): void {
  const ctx = ctxStore.getStore();
  if (ctx?.role !== 'owner') {
    throw BizError.forbidden(ERR.TOKEN_INVALID, '需要店主身份');
  }
}

export const ctxStore = new AsyncLocalStorage<RequestContext>();

export function currentContext(): RequestContext | undefined {
  return ctxStore.getStore();
}

export function currentTenantCode(): string | null {
  return ctxStore.getStore()?.tenantCode ?? null;
}

/* ============================================================================
 * 房间号 / 楼层脱敏（D16 / AC-13）
 * ----------------------------------------------------------------------------
 * 这是**第二道**防线：第一道是平台库与平台侧接口在结构上就不存在这些字段。
 * 两道都要有 —— 只靠"不查"挡不住一次误加的 join。
 * ==========================================================================*/

export const FORBIDDEN_IN_PLATFORM = [
  'room', 'roomNo', 'room_no', 'roomNumber', 'room_number', 'roomSnap', 'room_snap',
  'floor', 'floorNo', 'floor_no',
  '房间号', '房间', '楼层', '门牌',
] as const;

const FORBIDDEN_SET = new Set<string>(FORBIDDEN_IN_PLATFORM.map((k) => k.toLowerCase()));

/** 形如「2 栋 602 室」「3栋308」的地址串 */
const ADDRESS_PATTERN = /(\d+\s*栋)\s*([A-Za-z]?-?\d{2,4})\s*(室|号)?/g;

export function redactString(s: string): string {
  return s
    .replace(ADDRESS_PATTERN, (_m, dong: string) => `${dong}***`)
    .replace(/(房间号|楼层|门牌)[:：]?\s*\S+/g, '$1***');
}

/**
 * 递归脱敏任何准备写日志 / 出平台接口的对象。
 * 注意是**删除键**而不是替换成 ***：让它在日志里"可见地缺席"比留个占位符更能暴露实现问题。
 */
export function sanitizeForLog<T>(input: T, depth = 0): T {
  if (depth > 8 || input === null || input === undefined) return input;
  if (typeof input === 'string') return redactString(input) as unknown as T;
  if (Array.isArray(input)) return input.map((v) => sanitizeForLog(v, depth + 1)) as unknown as T;
  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (FORBIDDEN_SET.has(k.toLowerCase())) continue;
      out[k] = sanitizeForLog(v, depth + 1);
    }
    return out as unknown as T;
  }
  return input;
}

/** 断言对象中不含房间号类字段 —— 用于平台侧接口出参的单测断言 */
export function assertNoTenantPrivateFields(value: unknown, path = '$'): string[] {
  const hits: string[] = [];
  const walk = (v: unknown, p: string, d: number) => {
    if (d > 8 || v === null || v === undefined) return;
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${p}[${i}]`, d + 1));
    if (typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (FORBIDDEN_SET.has(k.toLowerCase())) hits.push(`${p}.${k}`);
        walk(val, `${p}.${k}`, d + 1);
      }
    }
  };
  walk(value, path, 0);
  return hits;
}

/* ============================================================================
 * 结构化日志
 * 每条日志必带 requestId + tenantCode —— 否则 100 个租户的日志混在一起没法查
 * ==========================================================================*/

@Injectable()
export class AppLogger implements NestLoggerService {
  private write(level: 'INFO' | 'WARN' | 'ERROR', message: unknown, ...rest: unknown[]): void {
    const ctx = currentContext();
    const line = {
      ts: new Date().toISOString(),
      level,
      rid: ctx?.requestId ?? '-',
      tenant: ctx?.tenantCode ?? '-',
      msg: typeof message === 'string' ? redactString(message) : sanitizeForLog(message),
      extra: rest.length ? sanitizeForLog(rest) : undefined,
    };
    const text = JSON.stringify(line);
    if (level === 'ERROR') process.stderr.write(`${text}\n`);
    else process.stdout.write(`${text}\n`);
  }

  log(message: unknown, ...rest: unknown[]): void { this.write('INFO', message, ...rest); }
  info(message: unknown, ...rest: unknown[]): void { this.write('INFO', message, ...rest); }
  warn(message: unknown, ...rest: unknown[]): void { this.write('WARN', message, ...rest); }
  error(message: unknown, ...rest: unknown[]): void { this.write('ERROR', message, ...rest); }
  debug(message: unknown, ...rest: unknown[]): void { this.write('INFO', message, ...rest); }
  verbose(message: unknown, ...rest: unknown[]): void { this.write('INFO', message, ...rest); }
}
