import { Module } from '@nestjs/common';
import { NoticeController, SubscriptionController } from './notice.controller';
import { NoticeService } from './notice.service';

/**
 * 消息模块。
 *
 * 只依赖 CoreModule 里已导出的 REPO_FACTORY / WechatService，
 * 由被依赖方（OrderModule）import —— 方向是"订单 → 消息"，
 * 反过来让消息模块知道订单状态机才是错的。
 */
@Module({
  controllers: [NoticeController, SubscriptionController],
  providers: [NoticeService],
  exports: [NoticeService],
})
export class NoticeModule {}
