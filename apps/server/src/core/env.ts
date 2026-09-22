import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** 极简 .env 加载（不引 dotenv，避免为一个 20 行的功能加依赖） */
function loadDotEnv(): void {
  for (const name of ['.env.local', '.env']) {
    const p = resolve(process.cwd(), name);
    if (!existsSync(p)) continue;
    for (const raw of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      let v = line.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (process.env[k] === undefined) process.env[k] = v;
    }
  }
}

loadDotEnv();

function required(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v && v.length) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`缺少必需的环境变量：${name}`);
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3000),

  /**
   * 持久化模式。
   * memory —— 单元测试 / 本地冒烟 / CI（本机无 MySQL / Docker 时的真实可跑路径）
   * mysql  —— 生产：平台库 1 个 + 每租户独立库（D3）
   */
  dbMode: (process.env.DB_MODE ?? 'memory') as 'memory' | 'mysql',

  platformDatabaseUrl: process.env.PLATFORM_DATABASE_URL ?? '',
  /** 租户库连接模板：{db} 会被替换成 tenants.db_name */
  tenantDatabaseUrlTemplate:
    process.env.TENANT_DATABASE_URL_TEMPLATE ?? 'mysql://root:root@127.0.0.1:3306/{db}',

  /** 签发小程序会话 token 的密钥。生产必须用环境变量注入，绝不允许硬编码默认值上线。 */
  jwtSecret: required('JWT_SECRET', 'dev-only-secret-change-me'),

  /** 单域名 + AppID 换租户；兜底路径前缀 /t/{tenant_code}/api（§2.2） */
  apiPrefix: process.env.API_PREFIX ?? '/api',
  tenantPathPrefix: process.env.TENANT_PATH_PREFIX ?? '/t',

  /**
   * 平台后台访问密钥。
   * ⚠️ 过渡方案：上线前必须替换为账号体系 + RBAC + 操作审计。
   */
  platformAdminKey: required('PLATFORM_ADMIN_KEY', 'dev-platform-key'),

  logLevel: process.env.LOG_LEVEL ?? 'info',

  /**
   * 微信小程序凭据（学生登录用）。
   *
   * 学生身份的建立链路：`wx.login()` 拿 code → 服务端 `code2session` 换 openid
   * → 在**该租户库**里 upsert 用户 → 签发带 `sub`（用户 id）的会话 token。
   *
   * 未配置时**只有登录会失败，浏览/下单以外的功能不受影响**，且失败信息是明确的
   * `WECHAT_NOT_CONFIGURED`，而不是一个看起来像"网络错误"的模糊报错 ——
   * 后者会让人花半天去查网络。
   */
  wechat: {
    appId: process.env.WECHAT_APPID ?? '',
    appSecret: process.env.WECHAT_APPSECRET ?? '',
    /**
     * 是否允许直接提交 openid 登录（跳过 code2session）。
     * 这个开关存在的唯一理由是本地冒烟与自动化测试需要造学生身份 ——
     * 生产环境默认关闭，**打开它等于任何人可以冒充任何人**。
     */
    allowInsecureOpenid:
      (process.env.WECHAT_ALLOW_INSECURE_OPENID ??
        (process.env.NODE_ENV === 'production' ? 'false' : 'true')) === 'true',
  },

  /**
   * 微信支付（JSAPI）商户凭据。
   *
   * 与上面的 `wechat`（AppID/AppSecret）**分开配置**，因为获取时机不同：
   * AppID/AppSecret 商户接入当天就有；商户号要等商户自己开通微信支付并完成签约。
   * 混在一起会让人误以为"要么全配好、要么都没配"。
   *
   * 未配置时的行为是明确的：发起支付返回 `PAY_NOT_CONFIGURED`，
   * 订单**留在待支付**并保留 30 分钟预占 —— 不清单、不假装成功。
   */
  wechatPay: {
    mchId: process.env.WECHATPAY_MCHID ?? '',
    /** APIv3 密钥（32 位） */
    apiV3Key: process.env.WECHATPAY_APIV3_KEY ?? '',
    /** 商户 API 证书序列号 */
    serialNo: process.env.WECHATPAY_SERIAL_NO ?? '',
    /** apiclient_key.pem 的**内容**（不是路径）—— 避免把私钥文件放进镜像层 */
    privateKey: process.env.WECHATPAY_PRIVATE_KEY ?? '',
    /** 支付结果通知地址基址（必须是公网 HTTPS） */
    notifyBaseUrl: process.env.WECHATPAY_NOTIFY_BASE_URL ?? '',
  },

  /**
   * 开发用的「模拟支付成功」开关。
   *
   * 为什么必须存在：没有商户号就无法真机支付，但那意味着
   * 接单 → 配送 → 送达 → 退款整条链路在商户拿到商户号之前**完全无法验证**。
   * 这个开关让本地/预发能把闭环跑通。
   *
   * ⚠️ **生产环境必须为 false**：打开它等于任何人可以把任意订单标记为已支付。
   * 所以默认值直接绑定 NODE_ENV，而不是给一个"记得关"的默认 true。
   */
  devPaySimulate:
    (process.env.DEV_PAY_SIMULATE ?? (process.env.NODE_ENV === 'production' ? 'false' : 'true')) === 'true',

  /**
   * 定时任务的开关与节奏。
   *
   * 为什么自己写 setInterval 而不是装 @nestjs/schedule：
   *   ① 2C4G 的机器上少一个依赖少一份内存；
   *   ② 更重要的是**可测性** —— 每个任务都必须能"注入 now 手动跑一次"，
   *      否则"跨日扣减分毫不差"这种验收就只能靠等一天。
   *      定时器只是触发方式，真正的逻辑在 LedgerService 里，可被直接调用。
   */
  jobsEnabled: (process.env.JOBS_ENABLED ?? 'true') === 'true',
  /** 每日扣减的执行时刻（中国时区小时数，0–23） */
  settlementHour: Number(process.env.SETTLEMENT_HOUR ?? 1),
  /** 巡检间隔（分钟）：到期状态刷新 + 提醒 */
  patrolIntervalMinutes: Number(process.env.PATROL_INTERVAL_MINUTES ?? 30),
} as const;

export const isProd = env.nodeEnv === 'production';
