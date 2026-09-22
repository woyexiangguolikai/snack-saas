import { HttpException, HttpStatus } from '@nestjs/common';

/** 业务错误码 —— 前端按 code 做分支，不解析文案 */
export const ERR = {
  TENANT_NOT_FOUND: 'TENANT_NOT_FOUND',           // AppID 未匹配 → 必须有「店铺未开通」页，不能白屏
  TENANT_SUSPENDED: 'TENANT_SUSPENDED',
  TOKEN_MISSING: 'TOKEN_MISSING',
  TOKEN_INVALID: 'TOKEN_INVALID',
  BUILDING_NOT_FOUND: 'BUILDING_NOT_FOUND',
  BUILDING_DELETE_FORBIDDEN: 'BUILDING_DELETE_FORBIDDEN', // 楼栋只能停用，不能删除
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  // ---- 账本（服务费通道）----
  TOPUP_BELOW_MIN: 'TOPUP_BELOW_MIN',           // 低于最低充值额
  TOPUP_AMOUNT_INVALID: 'TOPUP_AMOUNT_INVALID', // 非整数分 / 非正数
  SETTLEMENT_NOT_FOUND: 'SETTLEMENT_NOT_FOUND',
  ORDER_ALREADY_REFUNDED: 'ORDER_ALREADY_REFUNDED',
  GATE_SUBSCRIPTION_EXPIRED: 'GATE_SUBSCRIPTION_EXPIRED',
  GATE_BALANCE_BLOCKED: 'GATE_BALANCE_BLOCKED',
  // ---- 订单域 ----
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  /** 状态机不允许该动作 —— 前端按 allowedActions 预先禁用按钮，不该走到这里 */
  ORDER_ILLEGAL_TRANSITION: 'ORDER_ILLEGAL_TRANSITION',
  /** 条件写落库时发现别人已经改过（并发）—— 前端应刷新订单 */
  ORDER_STATE_CONFLICT: 'ORDER_STATE_CONFLICT',
  /** 回调金额与订单实付不符 —— **绝不落账**，单独打日志人工查 */
  ORDER_AMOUNT_MISMATCH: 'ORDER_AMOUNT_MISMATCH',
  ORDER_OUT_OF_STOCK: 'ORDER_OUT_OF_STOCK',
  ORDER_MIN_AMOUNT: 'ORDER_MIN_AMOUNT',
  /** 地址楼栋 ≠ 订单楼栋 —— 最贵的一类错误：货会送到学生不在的楼（CS-10） */
  ORDER_CROSS_BUILDING: 'ORDER_CROSS_BUILDING',
  ORDER_GATE_CLOSED: 'ORDER_GATE_CLOSED',
  ORDER_ADDRESS_REQUIRED: 'ORDER_ADDRESS_REQUIRED',
  ADDRESS_NOT_FOUND: 'ADDRESS_NOT_FOUND',
  // ---- 登录 ----
  /** 服务端尚未配置小程序 AppID/AppSecret —— 明确的配置错误，不是网络问题 */
  WECHAT_NOT_CONFIGURED: 'WECHAT_NOT_CONFIGURED',
  /** code2session 失败（code 过期 / 已用过 / 微信侧报错） */
  WECHAT_CODE_INVALID: 'WECHAT_CODE_INVALID',
  LOGIN_REQUIRED: 'LOGIN_REQUIRED',
  /**
   * 该微信身份不是本店店主。
   * 与学生登录失败分开，是因为两者的**处置完全不同**：
   * 学生登录失败 → 重试即可；不是店主 → 重试多少次都没用，界面要给一句
   * 「当前仅店主可登录」并退回学生端，而不是让人反复点"我是店家"。
   */
  NOT_MERCHANT: 'NOT_MERCHANT',

  // ---- 支付 ----
  /**
   * 服务端尚未配置微信支付商户号。
   * 与 WECHAT_NOT_CONFIGURED 分开，是因为这两件事**由不同的人在不同的时间提供**：
   * AppID/AppSecret 在"商户第一次接入"时就有，商户号/APIv3 密钥要等商户开通微信支付。
   * 合成一个错误码会让人以为"整个微信都没配好"，然后去查错的地方。
   */
  PAY_NOT_CONFIGURED: 'PAY_NOT_CONFIGURED',
  /** 该订单当前状态不可支付（已支付 / 已关闭 / 已退款） */
  PAY_ORDER_NOT_PAYABLE: 'PAY_ORDER_NOT_PAYABLE',

  INTERNAL: 'INTERNAL',
} as const;

export type ErrCode = (typeof ERR)[keyof typeof ERR];

export class BizError extends HttpException {
  readonly code: ErrCode;

  constructor(code: ErrCode, message: string, status: HttpStatus = HttpStatus.BAD_REQUEST) {
    super({ code, message }, status);
    this.code = code;
  }

  static notFound(code: ErrCode, message: string): BizError {
    return new BizError(code, message, HttpStatus.NOT_FOUND);
  }

  static forbidden(code: ErrCode, message: string): BizError {
    return new BizError(code, message, HttpStatus.FORBIDDEN);
  }

  static unauthorized(code: ErrCode, message: string): BizError {
    return new BizError(code, message, HttpStatus.UNAUTHORIZED);
  }
}
