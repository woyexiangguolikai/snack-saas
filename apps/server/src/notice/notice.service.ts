import { Inject, Injectable } from '@nestjs/common';
import { AppLogger } from '../core/logger';
import { NoticeType, NoticeRecord } from '../core/repository';
import type { RepoFactory } from '../core/repository';
import { REPO_FACTORY } from '../core/repo.factory';
import { WechatService } from '../auth/wechat.service';

/* ============================================================================
 * 站内消息 + 订阅消息推送授权（CS-13）
 * ----------------------------------------------------------------------------
 * 这一层存在的意义，是把**两件事严格分开**：
 *
 *   A. 站内消息 —— 订单每次流转都写一条，**永远可靠**。
 *   B. 微信订阅消息 —— 依赖 AppID/AppSecret + 模板 + 学生授权，**三条缺一就不成立**。
 *
 * 常见的错误做法是"订单进展靠订阅消息通知"。它有三个绕不过的限制：
 *   ① 一次授权只能发一条（不是一次长期订阅）；
 *   ② 学生勾了「总是保持以上选择，不再询问」之后，我们连弹的机会都没有；
 *   ③ 未认证 / 未备案的小程序根本没有模板资格。
 * 这三条意味着**一定有人收不到**。所以把 A 做成主通道，B 只做增强。
 * ==========================================================================*/

/**
 * 各状态的站内消息文案。
 *
 * 措辞全部中性（AC-05 / D5 禁用词表）：
 * 「你的订单已送达」而不是「订单完成了！🎉」——后者一旦晚到就会变成嘲讽。
 */
const NOTICE_COPY: Record<NoticeType, (ctx: { orderNo: string; buildingName: string }) => { title: string; body: string }> = {
  paid: (c) => ({
    title: '已收到付款',
    body: `订单 ${c.orderNo} 已付款，正在等店家接单。`,
  }),
  accepted: (c) => ({
    title: '店家已接单',
    body: `订单 ${c.orderNo} 店家已接单，正在为你备货。`,
  }),
  delivered: (c) => ({
    title: '已送达',
    body: `订单 ${c.orderNo} 已送到你填写的位置（${c.buildingName}）。`,
  }),
  closed: (c) => ({
    title: '订单已关闭',
    body: `订单 ${c.orderNo} 未在时间内完成支付，已自动关闭，占用的库存已释放。`,
  }),
  refund_done: (c) => ({
    title: '退款已处理',
    body: `订单 ${c.orderNo} 的退款已处理，款项按原路退回。`,
  }),
  refund_rejected: (c) => ({
    title: '退款未通过',
    body: `订单 ${c.orderNo} 的退款申请未通过，请把具体问题反馈给店家。`,
  }),
};

@Injectable()
export class NoticeService {
  constructor(
    @Inject(REPO_FACTORY) private readonly repos: RepoFactory,
    private readonly wechat: WechatService,
    private readonly logger: AppLogger,
  ) {}

  /**
   * 写一条站内消息。**失败不能影响主流程** ——
   * 订单已经状态变更成功了，却因为"消息没写成"让接口报错，是最糟的失败方式。
   */
  async emit(
    tenantCode: string,
    userId: number,
    type: NoticeType,
    ctx: { orderNo: string; buildingName: string },
  ): Promise<NoticeRecord | null> {
    try {
      const repo = this.repos.tenant(tenantCode);
      const copy = NOTICE_COPY[type](ctx);
      return await repo.addNotice({ userId, type, ...copy, orderNo: ctx.orderNo });
    } catch (e) {
      this.logger.warn({
        msg: '站内消息写入失败（不阻断订单流程）',
        code: 'NOTICE_WRITE_FAILED',
        err: (e as Error).message,
      });
      return null;
    }
  }

  /**
   * 尝试用掉一条一次性授权去发订阅消息。
   *
   * 关键细节：**发送条件不满足时要把授权退回去**（consumedAt 恢复为 null）。
   * 否则在还没配置 AppID 的阶段，学生的每一次授权都会被"假装发了一次"而烧掉 ——
   * 等真正上线时，他早就显示"已用掉"，而实际上他一条消息都没收到。
   * 这类 bug 只在上线当天暴露，属于花钱才买得到的教训，所以在这里写死防范措施。
   */
  async attemptPush(tenantCode: string, userId: number, tmplId: string, orderNo: string) {
    if (!this.wechat.configured) return { sent: false, reason: 'WECHAT_NOT_CONFIGURED' };
    if (!this.senderReady) return { sent: false, reason: 'SENDER_NOT_WIRED' };

    // 走到这一步才去取授权：前两个分支都在还未烧掉授权时就返回了
    const grant = await this.repos.tenant(tenantCode).consumePushGrant(userId, tmplId, orderNo);
    if (!grant) return { sent: false, reason: 'NO_VALID_GRANT' };

    // 真正的发送需要 access_token 轮换与模板参数组装，等拿到 AppSecret 后在这里接上；
    // 此处先把"不白烧授权"这条不变量守住。
    return { sent: false, reason: 'SENDER_NOT_WIRED' };
  }

  /**
   * 发送通道是否就绪。
   *
   * 目前恒为 false：AppID + 模板 ID 还没配。**授权凭证比想象中宝贵**——
   * 一次性授权如果在"发不出去"的情况下被消耗，学生就永久失去了这次机会，
   * 而 App 上完全看不出异常。所以宁可冒充未就绪，也不冒进一步消耗。
   */
  private get senderReady(): boolean {
    return false;
  }

  /* ------------------------------------------------------------- 读取侧 */

  async list(tenantCode: string, userId: number, limit = 50) {
    const repo = this.repos.tenant(tenantCode);
    const items = await repo.listNotices(userId, { limit });
    return { items, unread: await repo.countUnreadNotices(userId) };
  }

  async unreadCount(tenantCode: string, userId: number): Promise<number> {
    return this.repos.tenant(tenantCode).countUnreadNotices(userId);
  }

  /** 返回**本次真正标为已读的行数**，供前端精确扣减红点 */
  async markRead(tenantCode: string, userId: number, ids?: number[]): Promise<number> {
    return this.repos.tenant(tenantCode).markNoticesRead(userId, ids);
  }

  /**
   * 记录学生在小程序端 `wx.requestSubscribeMessage` 的结果。
   *
   * `result` 原样落库（accept / reject / ban / filter），不压成布尔值。
   * 只记成功的看起来省事，但那样永远不知道"是这次拒绝了还是永久拒收"，
   * 结果就是对着勾了「不再询问」的学生反复弹窗。
   */
  async recordPushGrants(
    tenantCode: string,
    userId: number,
    orderNo: string | null,
    grants: Array<{ tmplId: string; result: string }>,
  ): Promise<number> {
    if (!Array.isArray(grants) || !grants.length) return 0;
    const repo = this.repos.tenant(tenantCode);
    for (const g of grants) {
      if (!g?.tmplId || typeof g.result !== 'string') continue;
      await repo.addPushGrant({ userId, tmplId: g.tmplId, result: g.result, orderNo });
    }
    return grants.length;
  }
}
