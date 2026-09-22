import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { env } from '../core/env';
import { ERR, BizError } from '../core/errors';
import { issueToken } from '../core/jwt';
import { REPO_FACTORY } from '../core/repo.factory';
import type { RepoFactory } from '../core/repository';
import { WechatService } from './wechat.service';
import { TenantService } from '../platform/tenant.service';

/**
 * 店主令牌签发。
 *
 * v1 是单管理员模式（D10）：店主身份由**平台授予**，不走微信授权 ——
 * 因为店主登录要考虑"换手机了怎么办""店员离职了怎么收回"，
 * 那是账号体系的活；而 v1 你方运营可以直接在平台后台发一张令牌给店主。
 *
 * 位于 `/api/platform/*` 下，因此天然被平台密钥保护
 *（见 TenantRouterMiddleware.assertPlatformKey）。
 * ⚠️ 上线前应替换为平台后台的账号体系 + RBAC（与平台密钥一起替换）。
 */
@Controller('api/platform/merchant')
export class MerchantTokenController {
  constructor(
    @Inject(REPO_FACTORY) private readonly repos: RepoFactory,
    private readonly tenants: TenantService,
  ) {}

  @Post('token')
  @HttpCode(200)
  async issue(@Body() body: { tenantCode?: string }) {
    const code = String(body?.tenantCode ?? '').trim();
    if (!code) throw new BizError(ERR.VALIDATION_FAILED, '缺少 tenantCode');

    const tenant = await this.repos.platform().findTenantByCode(code);
    if (!tenant) throw BizError.notFound(ERR.TENANT_NOT_FOUND, `租户不存在：${code}`);
    if (tenant.status === 'suspended') {
      throw BizError.forbidden(ERR.TENANT_SUSPENDED, '本店已暂停服务');
    }

    const { token, expiresAt } = issueToken(
      { tenantCode: tenant.tenantCode, role: 'owner' },
      env.jwtSecret,
      // 商户端操作的是钱和货，会话有效期比学生端短
      24 * 3600,
    );
    // 发令牌是敏感操作 —— 留痕，且**不记录令牌本身**
    await this.repos.platform().appendAudit({
      tenantCode: code, actor: 'platform', action: 'issue_merchant_token', target: code,
      detail: `有效期至 ${expiresAt}`,
    });
    return { tenantCode: tenant.tenantCode, shopName: tenant.shopName, token, expiresAt, role: 'owner' };
  }

  /**
   * 绑定店主微信（平台运营动作）。
   *
   * 这一步必须是**显式**的：如果改成"第一个进商户端的人自动成为店主"，
   * 那么任何一个先点了「我是店家」的学生都会拿到定价权 —— 这是最贵的一类越权，
   * 而且不会有任何报错。绑定可重复调用（换店长 / 店员离职时替换）。
   *
   * 位于 `/api/platform/*` 下，天然被平台密钥保护。
   */
  @Post('owner')
  @HttpCode(200)
  async bindOwner(@Body() body: { tenantCode?: string; openid?: string; nickname?: string }) {
    return this.tenants.bindOwner(body?.tenantCode ?? '', String(body?.openid ?? ''), body?.nickname ?? null);
  }
}

/**
 * 登录环境自检。
 * 用来回答一个非常具体的问题：**"登录调不通，是我的 AppID 配错了，还是服务器没配？"**
 * 这个信息在排障时的价值远大于多加一个业务接口。
 */
@Controller('api/tenant/auth')
export class AuthStatusController {
  constructor(private readonly wechat: WechatService) {}

  @Get('status')
  status() {
    const w = this.wechat.describe();
    return {
      wechat: w,
      /** 前端据此决定登录按钮是直接调 wx.login 还是先提示"服务端未配置" */
      loginReady: w.configured,
      insecureOpenidAllowed: env.wechat.allowInsecureOpenid,
      hint: w.configured
        ? '微信登录已就绪（AppID 尾 ' + w.appIdTail + '）'
        : '服务端尚未配置 WECHAT_APPID / WECHAT_APPSECRET，学生登录不可用',
    };
  }
}
