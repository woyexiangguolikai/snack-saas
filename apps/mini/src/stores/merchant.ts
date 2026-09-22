import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { currentAppId } from '../utils/appid';
import { ApiFailure, bindMerchantSession, request } from '../utils/request';
import { wxCode } from './session';

/* ============================================================================
 * 商户（店主）身份（CM-01）
 * ----------------------------------------------------------------------------
 * 与学生会话**并存**，不互相顶替：店主自己也在店里下单，两套令牌
 * （商户 24h / 学生 7d）各走各的请求出口，见 `utils/request.ts` 的注释。
 *
 * 一条硬约束：**不是店主就是不是店主，不给"游客版商户端"**。
 * 服务端对非店主返回 403 NOT_MERCHANT，前端据此显示一句明确的话并退回学生端，
 * 不提供重试入口 —— 重试多少次结果都一样，给按钮只是让人多失望几次。
 * ==========================================================================*/

const STORAGE_KEY = 'snack.merchant';

export type MerchantLoginFail = {
  code: string;
  message: string;
  /** 是不是"你不是店主" —— 这个失败重试无用，界面必须换一套说法 */
  notMerchant: boolean;
};

interface Persisted {
  tenantCode: string;
  token: string;
  expiresAt: string;
  shopName: string;
  nickname: string | null;
}

export const useMerchantStore = defineStore('merchant', () => {
  const tenantCode = ref('');
  const token = ref('');
  const expiresAt = ref('');
  const shopName = ref('');
  const nickname = ref<string | null>(null);

  /** 上一次登录的失败原因 —— 商户入口页据此决定说什么，而不是一律「登录失败」 */
  const lastFail = ref<MerchantLoginFail | null>(null);

  const ready = computed(() => !!token.value && !!tenantCode.value);

  function persist(): void {
    if (!token.value || !tenantCode.value) return;
    uni.setStorageSync(STORAGE_KEY, {
      tenantCode: tenantCode.value,
      token: token.value,
      expiresAt: expiresAt.value,
      shopName: shopName.value,
      nickname: nickname.value,
    } satisfies Persisted);
  }

  function restore(): boolean {
    try {
      const raw = uni.getStorageSync(STORAGE_KEY) as Persisted | '' | null;
      if (!raw || typeof raw !== 'object' || !raw.token) return false;
      // 本地先判一次过期，省掉一次注定 401 的请求（服务端仍会再判一次）
      if (raw.expiresAt && new Date(raw.expiresAt).getTime() < Date.now() + 60_000) return false;
      tenantCode.value = raw.tenantCode;
      token.value = raw.token;
      expiresAt.value = raw.expiresAt;
      shopName.value = raw.shopName ?? '';
      nickname.value = raw.nickname ?? null;
      return true;
    } catch {
      return false;
    }
  }

  function clear(): void {
    tenantCode.value = '';
    token.value = '';
    expiresAt.value = '';
    nickname.value = null;
    uni.removeStorageSync(STORAGE_KEY);
  }

  /**
   * 店主登录：wx.login → code → 服务端校验是不是本店店主 → 签发店主令牌。
   *
   * 与学生登录共用 `wxCode()`（同一个 code 只能换一次 session），
   * 但**不复用** `/api/tenant/resolve` —— 那是学生身份的入口，
   * 把两种身份塞进一个接口，就得靠入参区分权限，那是把鉴权藏进参数。
   */
  async function login(): Promise<boolean> {
    lastFail.value = null;
    const code = await wxCode();
    if (!code) {
      lastFail.value = { code: 'LOGIN_CANCELLED', message: '未获取到微信登录凭证，请重试', notMerchant: false };
      return false;
    }

    try {
      const r = await request<{
        tenantCode: string; shopName: string; token: string; expiresAt: string; role: 'owner'; nickname: string | null;
      }>('/api/tenant/merchant/login', {
        method: 'POST',
        data: { appid: currentAppId(), code },
        // 登录接口本身不能走"401 自动重登"，否则递归
        noRetry: true,
      });
      tenantCode.value = r.tenantCode;
      token.value = r.token;
      expiresAt.value = r.expiresAt;
      shopName.value = r.shopName;
      nickname.value = r.nickname ?? null;
      persist();
      return true;
    } catch (e) {
      const err = e instanceof ApiFailure ? e : null;
      const code2 = err?.code ?? 'NETWORK';
      lastFail.value = {
        code: code2,
        message: code2 === 'NOT_MERCHANT' ? '当前仅店主可登录' : (err?.message ?? '登录没有完成，请重试'),
        notMerchant: code2 === 'NOT_MERCHANT',
      };
      return false;
    }
  }

  /** 已登录则直接通过；否则走一遍登录（商户页面进入时调用） */
  async function ensure(): Promise<boolean> {
    if (ready.value) return true;
    if (restore()) return true;
    return login();
  }

  /** 401 之后的重登：拿不到就清空，让页面回到"请先登录店主身份" */
  async function relogin(): Promise<boolean> {
    clear();
    return login();
  }

  function logout(): void {
    clear();
  }

  bindMerchantSession({
    tenantCode: () => tenantCode.value,
    token: () => token.value,
    relogin,
  });

  return {
    tenantCode, token, expiresAt, shopName, nickname, lastFail,
    ready, restore, login, ensure, relogin, logout, clear,
  };
});
