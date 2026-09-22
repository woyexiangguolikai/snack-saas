import { Module } from '@nestjs/common';
import { AuthStatusController, MerchantTokenController } from './auth.controller';

/**
 * 鉴权模块（控制器层）。
 *
 * `WechatService` 不在这里 provide —— 它由 @Global 的 CoreModule 提供
 *（因为 TenantService 也要用它）。这里只挂两个控制器：
 * 店主令牌签发、登录环境自检。
 */
@Module({
  controllers: [MerchantTokenController, AuthStatusController],
})
export class AuthModule {}
