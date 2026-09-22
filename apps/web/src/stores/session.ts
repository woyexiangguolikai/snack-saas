/**
 * 网页后台的会话。
 *
 * 令牌只存在 localStorage —— 不放 cookie。理由：后台是同源单页应用，
 * 用 Authorization 头传令牌就不会被 CSRF 利用；反过来若放 cookie，
 * 反而要额外做一套 CSRF 防护。
 *
 * ⚠️ 这是**过渡实现**：登录靠小程序生成的 6 位登录码，上线前必须替换为
 * 账号密码 / 扫码 + RBAC + 操作审计（与服务端的 PLATFORM_ADMIN_KEY 一起换）。
 * 在账号体系到位之前，登录码比"网页端直接输密码"更强 —— 它把"证明我是店主"
 * 交给了已经验证过的微信身份，而不是新造一个密码。
 */
import { reactive } from 'vue';
import { api, setTenant } from '@/api';
import { bindAuth } from '@/api/http';
import type { OwnerSession } from '@/api/types';

const KEY = 'snack.web.session';

interface SessionState {
  tenantCode: string;
  shopName: string;
  token: string;
  expiresAt: string;
  operator: string;
  ready: boolean;
}

export const session = reactive<SessionState>({
  tenantCode: '',
  shopName: '',
  token: '',
  expiresAt: '',
  operator: '',
  ready: false,
});

export function isLoggedIn(): boolean {
  return !!session.token && !!session.tenantCode;
}

export function restore(): void {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as SessionState;
    if (!saved?.token || !saved?.tenantCode) return;
    // 过期了就当作没登录 —— 留着一个必然 401 的令牌，只会让用户看到一串报错
    if (saved.expiresAt && new Date(saved.expiresAt).getTime() <= Date.now()) {
      localStorage.removeItem(KEY);
      return;
    }
    Object.assign(session, saved);
    setTenant(session.tenantCode);
  } catch {
    localStorage.removeItem(KEY);
  }
  session.ready = true;
}

export async function login(tenantCode: string, code: string, operator: string): Promise<OwnerSession> {
  const s = await api.webLogin(tenantCode.trim(), code.trim());
  Object.assign(session, {
    tenantCode: s.tenantCode,
    shopName: s.shopName,
    token: s.token,
    expiresAt: s.expiresAt,
    operator: operator.trim() || '店主',
    ready: true,
  });
  setTenant(s.tenantCode);
  localStorage.setItem(KEY, JSON.stringify({ ...session }));
  return s;
}

export function logout(): void {
  Object.assign(session, {
    tenantCode: '',
    shopName: '',
    token: '',
    expiresAt: '',
    operator: '',
    ready: true,
  });
  setTenant('');
  localStorage.removeItem(KEY);
}

bindAuth({
  token: () => session.token,
  onUnauthorized: () => {
    // 401 = 令牌失效。清掉会话让路由守卫把人送回登录页，
    // 而不是让每个页面各自弹一个"请求失败"
    if (isLoggedIn()) logout();
  },
});
