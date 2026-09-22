/**
 * 中性文案的**唯一出处**。
 *
 * 为什么要有这个文件：
 *   账本相关的措辞一旦写成"你欠了平台的钱"，商户的感受就从"我该交服务费"
 *   变成"我被追债了" —— 这是产品判断，不是文案偏好。所以它必须是一条
 *   可机器审计的规则，而不是靠每个人写提示语时记得。
 *
 * 本文件是全仓库**唯一**允许出现禁用词的地方（因为要把它们列出来才能查）。
 * `npm run check:copy` 会扫描全库：禁用词只允许出现在本文件；
 * 出现在第二个文件就说明有人把它写进了对用户展示的字符串里 → 直接失败。
 */

/**
 * 禁用词表 —— 全部是"债"的语义。
 * 替换方向：服务费 / 服务期 / 余额 / 充值，这四组词已经够表达所有情况。
 */
export const BANNED_COPY = [
  '欠费',
  '欠款',
  '补缴',
  '催缴',
  '滞纳',
  '罚款',
  '停机',
  '拉黑',
  '封停',
] as const;

/** 对外的固定措辞。业务代码禁止手写这些句子，一律引用这里。 */
export const COPY = {
  /** 服务费余额低于预警线（不催、不吓，只陈述事实 + 给出下一步） */
  balanceWarnTitle: '服务费余额偏低',
  balanceWarnBody: (balanceYuan: string, warnYuan: string) =>
    `当前余额 ¥${balanceYuan}，低于预警线 ¥${warnYuan}，建议提前充值以免影响接单。`,

  /** 余额触底（= 应急额度）→ 停单。措辞：说"暂停承接"，不说"你被停了" */
  balanceBlockedTitle: '服务费余额已用完应急额度',
  balanceBlockedBody: '店铺已暂停承接新订单，充值后立即恢复。已下单的订单不受影响。',

  /** 订阅到期提醒：15 / 7 / 3 天，三段递进但都不带压力词 */
  subscriptionWarnTitle: (days: number) => `服务期还有 ${days} 天`,
  subscriptionWarnBody: (endDate: string) =>
    `本店服务期将于 ${endDate} 结束。续期后服务不中断，历史订单与数据全部保留。`,

  /** 服务期结束后：只降级到"可浏览不可下单"，不关店、不清数据 */
  subscriptionExpiredTitle: '本店服务期已结束',
  subscriptionExpiredBody: '商品仍可浏览，下单暂时关闭。续期后立即恢复。',

  /** 充值 */
  topupTitle: '服务费充值',
  topupMinHint: (minYuan: string) => `单次充值不低于 ¥${minYuan}`,

  /** 账本名 */
  walletName: '服务费余额',
  subscriptionName: '服务期',
} as const;
