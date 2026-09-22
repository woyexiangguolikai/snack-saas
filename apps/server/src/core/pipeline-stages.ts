import type { PipelineOwner } from './types';

/**
 * 上线流水线 12 阶段（§5）。
 * 三个**非代码瓶颈**都在这里显式建模，不进代码就会变成"卡了没人知道"：
 *   ① 审核会驳回 → 必须有 rejected 状态 + 驳回原因 + 返工队列
 *   ② 商户号必须本人办理（代不了）→ 记录卡在哪一步、卡了几天
 *   ③ 密钥与版本运维 → 密钥失效告警 + 版本看板
 */
export interface PipelineStageDef {
  no: number;
  name: string;
  owner: PipelineOwner;
  /** 期望耗时（工作日），用于卡点判定 */
  slaDays: number;
  /** 该阶段不可控（外部因素），卡点不视为我方问题 */
  external: boolean;
}

export const PIPELINE_STAGES: readonly PipelineStageDef[] = [
  { no: 1,  name: '资料收集（执照 / 法人身份证 / 店铺名 / logo）', owner: 'partner',  slaDays: 1,  external: false },
  { no: 2,  name: '办执照 / 食品备案',                            owner: 'partner',  slaDays: 5,  external: true  },
  { no: 3,  name: '小程序注册 + 微信认证（300 元/年）',            owner: 'renter',   slaDays: 3,  external: true  },
  { no: 4,  name: '小程序 ICP 备案',                              owner: 'renter',   slaDays: 20, external: true  },
  { no: 5,  name: '微信支付商户号申请 + 绑定 AppID',               owner: 'renter',   slaDays: 7,  external: true  },
  { no: 6,  name: '服务类目申请（食品）',                          owner: 'renter',   slaDays: 5,  external: true  },
  { no: 7,  name: '取得代码上传密钥 + IP 白名单 + 项目成员权限',   owner: 'renter',   slaDays: 1,  external: false },
  { no: 8,  name: '平台侧创建租户（建库 / 初始化 / 带出楼栋模板）', owner: 'system',   slaDays: 0,  external: false },
  { no: 9,  name: '推送代码（灰度：先 1–2 家，再批量）',           owner: 'system',   slaDays: 1,  external: false },
  { no: 10, name: '商户提审 + 发布',                              owner: 'renter',   slaDays: 3,  external: true  },
  { no: 11, name: '商户充值 → 开通',                              owner: 'system',   slaDays: 1,  external: false },
  { no: 12, name: '商户维护楼栋 + 配置商品库存 + 设置时间窗 → 营业', owner: 'renter', slaDays: 2,  external: false },
] as const;

/**
 * 流水线完成到第 12 阶段才算"可营业"。
 * 第 8 阶段（建库）是**系统自动完成**的 —— 它由创建租户向导触发，不等人工。
 */
export const SYSTEM_AUTO_STAGE_NO = 8;
