/**
 * 平台后台的会话。
 *
 * 与商户端会话**完全独立**：两个 store、两个 localStorage key、两个请求头。
 * 不合并成一个"统一登录"的理由很实在 —— 合并之后，
 * 「在商户后台里点进平台页，结果拿着店主令牌去调平台接口」这件事
 * 会在开发者毫无察觉的情况下发生，而它失败的方式是 401，
 * 看起来像"密钥过期了"，于是又去重新生成一次。
 *
 * ⚠️ 过渡实现：密钥是**手填的平台密钥**（服务端 PLATFORM_ADMIN_KEY）。
 * 上线前必须替换为账号密码 / 扫码 + RBAC + 操作审计。
 */
import { reactive } from 'vue';
import { bindPlatformKey } from '@/api/http';

const KEY = 'snack.platform.key';

interface PlatformSessionState {
  key: string;
  /** 操作人名字，仅用于审计留痕（过渡期没有账号体系） */
  operator: string;
  ready: boolean;
}

export const platformSession = reactive<PlatformSessionState>({
  key: '',
  operator: '',
  ready: false,
});

export function isPlatformLoggedIn(): boolean {
  return platformSession.key.length > 0;
}

export function restorePlatform(): void {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw) as { key?: string; operator?: string };
      platformSession.key = saved?.key ?? '';
      platformSession.operator = saved?.operator ?? '';
    }
  } catch {
    localStorage.removeItem(KEY);
  }
  platformSession.ready = true;
}

export function platformLogin(key: string, operator: string): void {
  platformSession.key = key.trim();
  platformSession.operator = operator.trim() || '平台运维';
  localStorage.setItem(KEY, JSON.stringify({ key: platformSession.key, operator: platformSession.operator }));
}

export function platformLogout(): void {
  platformSession.key = '';
  localStorage.removeItem(KEY);
}

bindPlatformKey(() => platformSession.key);
