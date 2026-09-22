import { createHmac, timingSafeEqual } from 'node:crypto';

/* ============================================================================
 * 轻量 HS256 JWT
 * ----------------------------------------------------------------------------
 * 不引第三方库：实现就 20 行，且能少一个供应链依赖。
 * 载荷只放 tenantCode / role / exp —— **绝不放房间号或任何学生个人信息**。
 * ==========================================================================*/

export interface TokenPayload {
  tenantCode: string;
  role: 'student' | 'owner' | 'platform';
  /**
   * 用户 id（学生/店主）。**只有完成过 code2session 的会话才有值** ——
   * 纯浏览令牌没有 sub，下单类接口据此拒绝"匿名浏览者"。
   * 用 sub（标准声明）而不是自造 userId 字段：将来换签发库时不用改载荷结构。
   */
  sub?: number;
  iat: number;
  exp: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function issueToken(
  payload: Omit<TokenPayload, 'iat' | 'exp'>,
  secret: string,
  ttlSeconds = 7 * 24 * 3600,
): { token: string; expiresAt: string } {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ttlSeconds;
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ ...payload, iat, exp }));
  const token = `${header}.${body}.${sign(`${header}.${body}`, secret)}`;
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

export type VerifyResult =
  | { ok: true; payload: TokenPayload }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

export function verifyToken(token: string, secret: string): VerifyResult {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [header, body, sig] = parts as [string, string, string];

  const expected = sign(`${header}.${body}`, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, payload };
}
