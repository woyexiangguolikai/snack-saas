import { Injectable } from '@nestjs/common';
import { env } from '../core/env';
import { ERR, BizError } from '../core/errors';
import { AppLogger } from '../core/logger';

/* ============================================================================
 * 微信登录（code2session）
 * ----------------------------------------------------------------------------
 * 用 Node 内置的全局 fetch（Node 18+），不引第三方 SDK：
 * 这个交互就是一次 GET，装一个包只是多一份要跟着升的依赖。
 *
 * ⚠️ AppSecret 出现在**请求 URL 里**，所以这个函数的日志与异常信息
 *    一律不得包含完整 URL —— 否则密钥会顺着日志流出去。
 * ==========================================================================*/

export interface Code2SessionResult {
  openid: string;
  unionid: string | null;
  sessionKey: string | null;
}

/** 微信错误码 → 人话。查不到的直接给原始码，方便去微信文档对。 */
const WECHAT_ERR: Record<number, string> = {
  '-1': '微信服务繁忙，请稍后重试',
  40029: '登录凭证已失效，请重新授权',
  45011: '操作过于频繁，请稍后再试',
  40226: '当前账号被微信标记为高风险，暂无法登录',
  40013: 'AppID 无效（请检查 WECHAT_APPID 是否与小程序一致）',
  40125: 'AppSecret 无效（请检查 WECHAT_APPSECRET）',
};

@Injectable()
export class WechatService {
  constructor(private readonly logger: AppLogger) {}

  /** 是否已配置凭据。未配置时登录接口会明确报错，而不是报"网络错误"。 */
  get configured(): boolean {
    return Boolean(env.wechat.appId && env.wechat.appSecret);
  }

  /** 供健康检查 / 排障页展示（**只暴露是否配置与 AppID 尾 4 位，绝不暴露 Secret**） */
  describe(): { configured: boolean; appIdTail: string | null; appSecretSet: boolean } {
    return {
      configured: this.configured,
      appIdTail: env.wechat.appId ? env.wechat.appId.slice(-4) : null,
      appSecretSet: Boolean(env.wechat.appSecret),
    };
  }

  async code2session(code: string): Promise<Code2SessionResult> {
    if (!this.configured) {
      throw new BizError(
        ERR.WECHAT_NOT_CONFIGURED,
        '服务端尚未配置小程序凭据：请在 .env 中设置 WECHAT_APPID 与 WECHAT_APPSECRET',
      );
    }
    const c = String(code ?? '').trim();
    if (!c) throw new BizError(ERR.VALIDATION_FAILED, '缺少 code（前端需先调用 wx.login）');

    const url =
      'https://api.weixin.qq.com/sns/jscode2session' +
      `?appid=${encodeURIComponent(env.wechat.appId)}` +
      `&secret=${encodeURIComponent(env.wechat.appSecret)}` +
      `&js_code=${encodeURIComponent(c)}` +
      '&grant_type=authorization_code';

    let data: {
      openid?: string;
      unionid?: string;
      session_key?: string;
      errcode?: number;
      errmsg?: string;
    };
    try {
      const resp = await fetch(url, { method: 'GET' });
      data = (await resp.json()) as typeof data;
    } catch (e) {
      // 只记错误本身，**不记 URL**（URL 里有 secret）
      this.logger.error('code2session 请求失败', { err: String(e) });
      throw new BizError(ERR.WECHAT_CODE_INVALID, '连接微信服务失败，请稍后重试');
    }

    if (data.errcode) {
      const hint = WECHAT_ERR[data.errcode] ?? data.errmsg ?? '未知错误';
      this.logger.warn('code2session 被微信拒绝', { errcode: data.errcode, errmsg: data.errmsg });
      throw new BizError(ERR.WECHAT_CODE_INVALID, `微信登录失败：${hint}（${data.errcode}）`);
    }
    if (!data.openid) {
      this.logger.error('code2session 返回缺少 openid', { errmsg: data.errmsg });
      throw new BizError(ERR.WECHAT_CODE_INVALID, '微信未返回用户标识，请重试');
    }

    return {
      openid: data.openid,
      unionid: data.unionid ?? null,
      sessionKey: data.session_key ?? null,
    };
  }
}
