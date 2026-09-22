import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { requireUserId } from '../core/logger';
import { tenantOf } from '../core/tenant-scope';
import { NoticeService } from './notice.service';

/* ============================================================================
 * 站内消息 / 推送授权（学生端，CS-13）
 * ----------------------------------------------------------------------------
 * 全部接口都要求**已登录**（requireUserId）——消息是私人信箱，
 * 匿名令牌能读到别人信箱内容的后果，远重于"多看一个商品"。
 * ==========================================================================*/

@Controller('t/:tenantCode/api/notices')
export class NoticeController {
  constructor(private readonly notices: NoticeService) {}

  /** 列表 + 未读数一起返回：省掉一次往返，红点不会比列表晚一拍 */
  @Get()
  async list(@Param('tenantCode') tenantCode: string, @Query('limit') limit?: string) {
    const userId = requireUserId();
    const n = limit ? Math.min(200, Math.max(1, Number(limit) || 50)) : 50;
    return this.notices.list(tenantOf(tenantCode), userId, n);
  }

  /** 未读数量 —— TabBar / 「我的」的红点只认这个数 */
  @Get('unread')
  async unread(@Param('tenantCode') tenantCode: string) {
    return { unread: await this.notices.unreadCount(tenantOf(tenantCode), requireUserId()) };
  }

  /**
   * 标记已读。不传 ids = 全部已读。
   * 返回**本次真正改掉的行数**：前端据此精确扣减，不要自己假设"减 1"。
   */
  @Patch('read')
  @HttpCode(200)
  async read(@Param('tenantCode') tenantCode: string, @Body() body: { ids?: number[] }) {
    const userId = requireUserId();
    const ids = Array.isArray(body?.ids) ? body.ids.filter((n) => Number.isInteger(n)) : undefined;
    return { marked: await this.notices.markRead(tenantOf(tenantCode), userId, ids) };
  }
}

@Controller('t/:tenantCode/api/subscriptions')
export class SubscriptionController {
  constructor(private readonly notices: NoticeService) {}

  /**
   * 上报 `wx.requestSubscribeMessage` 的授权结果。
   *
   * ⚠️ 这个接口不"开订阅"，它只是**把微信给的一次性授权凭证交到服务端保管**。
   * 拿到凭证 ≠ 能发出去（还差 access_token 与模板），
   * 但不交过来，学生点「允许」那一下就白白丢掉了。
   */
  @Post()
  @HttpCode(201)
  async record(
    @Param('tenantCode') tenantCode: string,
    @Body() body: { orderNo?: string | null; grants?: Array<{ tmplId: string; result: string }> },
  ) {
    const userId = requireUserId();
    const recorded = await this.notices.recordPushGrants(
      tenantOf(tenantCode),
      userId,
      body?.orderNo ?? null,
      body?.grants ?? [],
    );
    return { recorded };
  }
}
