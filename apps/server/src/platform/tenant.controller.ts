import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { TenantService } from './tenant.service';
import { assertNoTenantPrivateFields } from '../core/logger';

/**
 * 全局路由（不需要租户令牌）—— 租户识别入口（§2.2）
 *
 * 小程序启动 → wx.getAccountInfoSync().miniProgram.appId
 *            → POST /api/tenant/resolve { appid }
 *            → { tenant_code, config, buildings[], token }
 *
 * 异常：AppID 未匹配 → TENANT_NOT_FOUND → 前端渲染「店铺未开通」页，**不能白屏**。
 */
@Controller('api/tenant')
export class TenantResolveController {
  constructor(private readonly tenants: TenantService) {}

  /**
   * 租户识别 +（可选）登录，一步完成。
   *
   * 传 `code`（来自 wx.login）→ 服务端 code2session → 建立学生身份 → 令牌带 userId。
   * 不传 → 只给浏览令牌，下单类接口会要求先登录。
   * `openid` 直传只在非生产环境放开，见 `env.wechat.allowInsecureOpenid`。
   */
  @Post('resolve')
  @HttpCode(200)
  async resolve(
    @Body()
    body: {
      appid?: string;
      code?: string;
      openid?: string;
      nickname?: string;
      avatar?: string;
    },
  ) {
    const result = await this.tenants.resolveByAppId(body?.appid ?? '', {
      code: body?.code,
      openid: body?.openid,
      nickname: body?.nickname,
      avatar: body?.avatar,
    });

    // 这是学生端也能拿到的公开接口 —— 出参绝不允许出现房间号 / 楼层（AC-13）
    const leaks = assertNoTenantPrivateFields(result);
    if (leaks.length) {
      throw new Error(`resolve 出参含租户私有字段，已阻断：${leaks.join(', ')}`);
    }
    return result;
  }

  /**
   * 网页后台用登录码换店主令牌。
   *
   * 码由店主本人在小程序里生成（5 分钟有效、一次性、按租户限流），
   * 所以**这个接口不需要任何先验凭据** —— 码本身就是凭据。
   */
  @Post('merchant/web-login')
  @HttpCode(200)
  async webLogin(@Body() body: { tenantCode?: string; code?: string }) {
    return this.tenants.redeemWebLoginCode(body?.tenantCode ?? '', body?.code ?? '');
  }

  /**
   * 商户登录（CM-01）：学生端「我是店家」入口走这一条。
   *
   * 与学生登录**同域、不同路径**：同一个 AppID 下，学生的微信身份若是本店店主，
   * 这里返回店主令牌；否则 403 NOT_MERCHANT —— 前端据此显示「当前仅店主可登录」
   * 并退回学生端，**不给重试入口**（重试多少次结果都一样）。
   */
  @Post('merchant/login')
  @HttpCode(200)
  async merchantLogin(
    @Body() body: { appid?: string; code?: string; openid?: string; nickname?: string; avatar?: string },
  ) {
    return this.tenants.loginMerchant(body?.appid ?? '', {
      code: body?.code,
      openid: body?.openid,
      nickname: body?.nickname,
      avatar: body?.avatar,
    });
  }
}
