# 校园零食多租户 SaaS

4 端（学生端小程序 / 商户端小程序 / 商户网页 / 平台后台）+ 上线流水线 + SKU×楼栋库存矩阵 + 宿舍内履约动线。

依据：《校园零食多租户小程序 · 需求与设计 v0.4》（业务规则唯一真相源）
　　　《校园零食小程序 · 全量页面与闭环 v3.0》（42 闭环 / 51 页 / 20 条 AC，验收依据）

工程规范：**`docs/CODE_REVIEW.md`**（代码审查标准与流程 —— 分级 / 五维判据 / 门禁 / 红线 / 事故账本）
速查卡：`docs/code-review-cheatsheet.html`（可打印）

---

## 当前进度

| 阶段 | 范围 | 状态 |
|---|---|---|
| **S0 地基** | Token 单一真相源 · 双端工程骨架 · 26 个原子组件 · 组件 Playground | ✅ 完成 |
| **S1 多租户底座 + 楼栋模型** | 租户识别 · 一键建租户 · 配置下发 · 楼栋 CRUD · `config_override` | ✅ 完成 |
| **S2 双账本 + 两道闸门 + 库存域** | 订阅/余额双账本 · 每日汇总扣减 · 退款返还 · 下单 6 项 AND 闸门 · 到期 15/7/3 提醒 · 商品三态 · 零超卖 · 库存流水 · 两个同步语义 | ✅ 完成 |
| **S4 订单域（后端）** | 7 态状态机（穷举转移表）· 库存预占/释放 · 支付回调幂等 · 学生登录链路 · 退款回库规则 · 超时关单 · 送达兜底 | ✅ 完成 |
| **S3 学生端 15 页** | 启动三态 · 首页/分类/搜索 · 购物车/结算/支付结果 · 订单列表/详情 · 地址簿 · 我的 · **消息中心** | ✅ 完成 |
| S4 商户端小程序 · S5 商户网页后台 | 配送清单 UI · 11 页 + 库存矩阵 + Excel 导入 | 待开工 |
| S6 平台后台 + 推送 | 13 页 + 流水线 + 灰度推送 | 待开工 |
| S7–S8 边界兜底 + 总验收 | 42 闭环 + 20 AC | 待开工 |

**验收节点 V1：7/7 通过**（服务端冒烟 30/30 · 前端双端构建 · 类型检查零错误 · AC-04 硬编码色值扫描零命中）

**验收节点 V2：全部通过**（服务端冒烟 **71/71** · 24 个测试分组 · 200 笔跨日订单扣减差额 0 · 库存逐格核对差额 0 · 中性文案全站 0 命中）

**验收节点 V3：全部通过**（服务端冒烟 **108/108** · 33 个测试分组 · 学生端 14 页 mp-weixin 构建通过 ·
类型检查零错误 · AC-04 硬编码色值 0 命中 · Token 引用完整性 1292 处全有定义 · 产物组件注册 0 缺失 ·
中性文案 129 文件 0 命中）

**验收节点 V4：全部通过**（服务端冒烟 **114/114** · 38 个测试分组 · 学生端 15 页 mp-weixin 构建通过 ·
类型检查零错误 · AC-04 硬编码色值 0 命中 · Token 引用完整性 1346 处全有定义 · 产物组件注册 0 缺失 ·
中性文案 135 文件 0 命中）

V4 相较 V3 补的两块（都是 CS 闭环里原本会漏的一环）：
- **「再来一单」（S-12）**：订单详情按**当前货架**补货 —— 数量不照抄历史订单，
  缺货/下架的点名告知；顺序上先换栋再补货（购物车绑楼栋，反过来会自己清空自己）。
- **消息兜底（CS-13）**：每次状态流转落一条**站内消息**。微信订阅消息有三条绕不过的限制
  （一次授权只发一条 / 学生可永久拒收 / 未认证无模板资格），所以推送只做增强，站内消息才是主通道。
  授权结果原样入库，且在发送通道未就绪时**不消耗**一次性授权。

S2 的两半：**钱**（`src/ledger/`）与**货**（`src/catalog/`）。两者平行、互不依赖 ——
订单域将来会同时用它们，但货和钱之间不该有依赖，否则会出现"改库存要注入账本"这种荒唐依赖。

---

## 目录结构

```
snack-saas/
├── docs/
│   ├── CODE_REVIEW.md          # 代码审查标准与流程（分级 / 判据 / 门禁 / 红线 / 事故账本）
│   └── code-review-cheatsheet.html   # 一页速查卡（可打印）
├── scripts/
│   ├── check-copy.mjs          # 中性文案守卫（禁用词只能存在于词表）
│   └── seed-dev.mjs            # 一键铺本机开发环境（建租户 + 上架商品）
├── packages/tokens/            # 设计系统 Token —— 全站唯一真相源（AC-04）
│   ├── src/tokens.css          # 唯一容器；由 apps/mini 脚本派生出 :root,page 版本
│   ├── src/theme.ts            # 换肤护栏（AC-06）：九级色阶 + 对比度强制
│   └── src/index.ts            # 语义色表 + 状态→语义色唯一映射
├── apps/server/                # 多租户服务端（NestJS）
│   ├── prisma/schema.prisma        # 平台库（只存钱不存人，绝无房间号）
│   ├── prisma/tenant/schema.prisma # 租户库（每商户一套，房间号只存在这里）
│   └── src/
│       ├── core/                   # config-resolver / time-window / repository / logger / jwt
│       ├── platform/               # 平台后台（建租户 / 学校字典 / 闸门总览）
│       └── tenant/                 # 租户域（楼栋 / 配置 / 时间窗）
├── apps/mini/                  # 前端（uni-app + Vue3 + Vite + TS）
│   ├── scripts/
│   │   ├── sync-tokens.mjs     # Token 派生（:root → :root,page）+ --check 守护
│   │   ├── check-tokens.mjs    # AC-04 强制检查：全库不得出现硬编码色值
│   │   └── check-build.mjs     # 产物级守卫：组件注册 + 接口地址不得是本机（--release 卡口）
│   └── src/
│       ├── styles/tokens.generated.css   # 生成物，勿手改
│       ├── styles/base.css               # 重置 / 滚动防塌陷 / 安全区
│       ├── composables/useNavMetrics.ts  # 状态栏 + 胶囊几何（顶部安全区唯一来源）
│       ├── components/Sn*.vue            # 26 个原子组件（A-01 ~ A-14）
│       ├── stores/theme.ts               # 租户换肤（两条结构性护栏：零换肤 / 平台中性锁）
│       ├── utils/amount.ts               # A-09 金额排版（全站唯一实现）
│       ├── mock/theme-samples.ts         # 换肤演示数据（非样式来源）
│       └── pages/playground/index.vue    # 组件可视化核对台 + 12 项自检面板
└── deploy/
    ├── baota/README.md         # 宝塔 2C4G 部署（当前生产路径）
    ├── docker-compose.yml      # 备用：迁移到云时用
    └── nginx.conf              # 单域名 + 路径前缀（绝不每租户子域名）
```

---

## 运行

```bash
npm install

# ---- 服务端 ----
npm run build:server    # 必须先编 tokens 再编 server
npm run smoke           # 真实起服务 + 真实打 HTTP + 119 项断言
npm run dev:server      # 开发模式（node --watch），默认 3000 端口
npm run start:server    # 直接起编译产物

# ---- 本机联调铺数据（必须做，否则小程序端只会看到「店铺未开通」）----
# DB_MODE=memory 启动时是零租户，且**每次重启都清空** —— 重启服务端后重跑一次即可
npm run seed:dev        # 用 apps/server/.env.local 的 WECHAT_APPID 建租户 + 上架 5 个商品

# ---- 前端 ----
npm run build:mini      # Token 派生 + mp-weixin + h5 双端构建
npm run verify -w @snack/mini
                        # 前端四条验收一次跑完：
                        #   ① Token 单一真相源无漂移（sync --check）
                        #   ② 全库无硬编码色值（AC-04）
                        #   ③ vue-tsc 零类型错误
                        #   ④ mp-weixin 构建 + 「被引用但未注册的组件」产物级守卫
                        #      + 「产物里不得含本机地址」守卫（--release 时为发布卡口）
npm run dev:mp          # 小程序开发模式（产物用微信开发者工具打开）
npm run dev:h5          # 网页端开发模式（默认 5180 端口）

# ---- 全量 ----
npm run typecheck       # tokens + server + mini 三个包
```

### 开发者工具里连不上后端？

```
POST http://127.0.0.1:3000/api/tenant/resolve net::ERR_CONNECTION_REFUSED
```

这是**网络层拒绝**，不是接口错。按顺序查两件事：

1. **服务端起了吗** —— `ERR_CONNECTION_REFUSED` 只有一个意思：3000 端口没人监听。
   在另一个终端跑 `npm run dev:server`。开发者工具里的请求由工具进程发出，
   所以 `127.0.0.1` 指的就是你这台电脑，**不需要**局域网 IP、也不需要 https。
2. **连上了但显示「店铺未开通」** —— 服务端起来了，但这个 AppID 在内存库里没有对应租户。
   跑 `npm run seed:dev`（它会读 `apps/server/.env.local` 里的 `WECHAT_APPID`）。

真机预览 / 体验版 / 正式版另说：**必须是 https + 已备案域名**，IP + 端口在真机上一定不通
（把 `apps/mini/.env.local` 的 `VITE_API_BASE` 换成局域网 IP 可让**同一 WiFi 下的真机**连本机服务，
服务端已监听 `0.0.0.0`，无需改代码）。提审前跑一次
`npm run check:build -w @snack/mini -- --release` —— 产物里带着本机地址时它会直接拦下来。

### 持久化模式

| 模式 | 用途 | 状态 |
|---|---|---|
| `DB_MODE=memory`（默认） | 单元测试 / 本机冒烟 / CI，可真实跑完整 HTTP 链路 | ✅ 可用 |
| `DB_MODE=mysql` | 生产：平台库 1 个 + 每租户独立库（D3） | ⏳ S2 随 MySQL 环境接入 |

`DB_MODE=mysql` 目前会**明确报错并列出接入步骤**，而不是静默降级或返回未验证的数据。
理由：本机无 Docker / MySQL，任何 Prisma 实现都无法执行哪怕一次；交付一段从未运行过的
数据库访问层，比明确标记"未交付"更危险 —— 它会让人误以为库存扣减、租户路由这些
最不可返工的部分已经验证过了。

### 四端是怎么来的

一套 uni-app 代码出两个构建目标：

```
apps/mini/src
  ├── build:mp-weixin ──▶ 微信小程序（一个 AppID / 一个包）
  │       ├── 学生端 17 页（主包）
  │       └── 商户端 10 页（分包 /pages-merchant/）
  └── build:h5 ─────────▶ 网页端（同一域名 /admin、/platform）
          ├── 商户网页 11 页
          └── 平台后台 13 页
```

不引第三方 UI 库 —— 否则 AC-04（Token 单一源）、AC-05（语义色零换肤）、AC-06（换肤护栏）
都无法保证。26 个原子组件全部自研。

---

## 核心接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查（含流水线阶段数、dbMode） |
| POST | `/api/tenant/resolve` | **小程序启动第一跳**：AppID → 租户 + 楼栋清单 + 令牌 |
| GET | `/api/platform/schools` | 学校字典 + 楼栋模板 |
| GET | `/api/platform/tenants` | 租户列表：**两个账本同屏**（订阅剩余天数 + 余额） |
| POST | `/api/platform/tenants` | **一键建租户**：建库 + 初始化 + 带出楼栋模板 + 开户 + 生成 12 阶段流水线 |
| POST | `/api/platform/theme` | 设置主题色（必过对比度护栏，AC-06） |
| GET | `/t/{tenant}/api/config` | **配置下发**：店铺 + 楼栋 + 时间窗 + 闸门 + 服务端时间 |
| GET | `/t/{tenant}/api/config/gate` | 某楼栋此刻能否下单（服务端判定，AC-14） |
| GET | `/t/{tenant}/api/buildings` | 楼栋列表（含停用 + 每个字段的来源标记） |
| POST | `/t/{tenant}/api/buildings` | 新增楼栋（**立即生效，无需发版**） |
| PATCH | `/t/{tenant}/api/buildings/:id` | 改楼栋（改名 / 排序 / 时间窗 / 提示语） |
| POST | `/t/{tenant}/api/buildings/:id/disable` | 停用楼栋 |
| DELETE | `/t/{tenant}/api/buildings/:id` | **一律 403** —— 楼栋只能停用不能删除 |
| GET | `/t/{tenant}/api/time-window/preview` | 时间窗预览：自动算截单时间 + 收窄提示 |
| POST | `/t/{tenant}/api/time-window/bulk` | **一键配置全部楼栋** |

鉴权：租户侧 `Authorization: Bearer <token>`；平台侧 `x-platform-key`。

---

## 已落地的产品铁律（写进代码，不靠自觉）

1. **楼栋只能停用不能删除** —— `DELETE` 直接 403，不是权限问题，是这条路径不该存在
2. **配置缺省即继承店铺** —— 所有读取必须走 `ConfigResolver`，业务代码自行 fallback 会让"加配置项不改表"失效
3. **时间只有一个真相源** —— 能否下单全由服务端判定并下发 `serverTime`，前端只做倒计时
4. **「已截单」用灰不用红** —— 状态→语义色映射集中在 `tokens/index.ts`，业务代码不得自行选色
5. **提交色永不直通** —— 主题色必须过 `guardThemeColor`，算法保证深端白字可读
6. **房间号不出商户库** —— 平台库结构里没有该列；平台侧接口出参过 `assertNoTenantPrivateFields` 断言；日志过脱敏中间件
7. **日志必带 tenant_code** —— 由 AsyncLocalStorage 注入，不靠人工传参
8. **样式只能引用 Token** —— `npm run lint:styles -w @snack/mini` 会扫描全库，出现硬编码色值即失败
9. **换肤只改 brand 变量** —— 语义色（ok/warn/danger/info/off）零换肤；平台后台 `lockNeutral()` 后任何主题色都进不来
10. **默认品牌色只存在于 tokens.css** —— 前端 store 不存副本；无租户主题时注入空串，让 Token 生效
11. **组件"被引用"不等于"被注册"** —— uni-app 对模板里用了但没 import 的组件**不报错**，
    只把标签写进 wxml 而不写进 usingComponents，编译全绿、真机才炸。
    `npm run check:build -w @snack/mini` 直接在产物上核对每个 wxml 用到的自定义标签是否都已注册，
    这是 vue-tsc 和 uni 编译器都覆盖不到的死角（已真实踩过一次：A-14 吸底栏）
12. **顶部安全区没有 CSS 解** —— `env(safe-area-inset-top)` 在小程序 webview 里恒为 0，
    且页面样式表在 `app.wxss` 之后加载、同优先级的 `padding` 简写会覆盖掉 class 里的 `padding-top`。
    所以顶部一律走 `composables/useNavMetrics.ts`（实测状态栏高度 + `getMenuButtonBoundingClientRect()`），
    并且**必须写成行内样式**。`base.css` 里故意只有 `.sn-safe-bottom`，没有 `.sn-safe-top`
13. **产物里不得出现本机地址** —— `VITE_API_BASE` 未配置时会静默落到 `http://127.0.0.1:3000`，
    构建全绿、类型全绿，只有真机才炸，而且第一反应会去查域名备案。
    `check:build` 会扫产物并报警，加 `--release` 时直接失败（发布卡口）

---

## 已知限制

- `DB_MODE=mysql` 未接入（Prisma 仓储层在 S2 补齐；接口契约已由内存实现钉死）
- 平台后台鉴权是单密钥过渡方案，**上线前必须替换为账号体系 + RBAC + 操作审计**
- **商户端页面尚未开工**（订单/库存/账本的接口与状态机已就绪，缺 UI）
- **S-15 退款申请页按需求未做**：需求 v0.4 把退款定义为**商户功能**（S18），
  学生侧没有退款入口 —— 已支付的单只能由商户发起退款（状态机不变量 ①：
  钱收了就不能直接取消，必须走退款）。学生遇到问题的出路是在订单详情联系店家
- **订阅消息只登记、不发送**：`wx.requestSubscribeMessage` 的授权结果已入库
  （`POST /api/subscriptions`），订单进展也已全量落站内消息；但真正的 `subscribeMessage.send`
  只差公众平台申请的**模板 ID**（AppSecret 已就位），拿到后填进配置即可，**未连线**。
  刻意在这条分支里不消耗一次性授权 —— 否则学生在上线前授权的额度会被"假装发了一次"烧掉。
  模板 ID 就位后只需补 `NoticeService.attemptPush` 的 `senderReady`
- 微信登录链路已就绪，本机已注入 AppID / AppSecret（`apps/server/.env.local`，不入库），
  但**真机尚未验证**：真机要求后端是 https + 已备案域名，IP + 端口在真机上一定不通。
  提审前用 `npm run check:build -w @snack/mini -- --release` 卡一道，防止本机地址被打进包。
  凭据未注入时下单明确报 `WECHAT_NOT_CONFIGURED`，**不会静默降级成匿名下单**
- 支付是**契约级**实现：`POST /orders/:no/pay` 与支付回调的幂等已按 10 次重放验证，
  但微信商户号（mchid / 证书 / APIv3 密钥）未接入，未配置时返回"订单已保留 + 提示"，
  订单仍等倒计时关单 —— **不做假成功**，也不假装已支付
- 依赖交互的状态（输入框聚焦外发光、按钮按压缩放、开关过渡）**在 Playground 里只能说"代码正确"，
  真机手感需在微信开发者工具 + 手机上确认**
- 服务端生产用 `tsc` 编译 + node 运行；dev 用 `node --watch`
  （**不要改用 esbuild/tsx** —— 它们不产出 `emitDecoratorMetadata`，NestJS 构造函数注入会静默失效）
- uni-app 版本固定在 `3.0.0-alpha-5020720260921001`（`vue3` dist-tag），vite 固定 `5.2.8`，
  vue 固定 `3.4.21`，pinia 固定 `2.1.7`。升级前先读 `vite-plugin-uni` 的 `peerDependencies`，
  它把 vite 写成精确版本，放宽会导致构建期静默错配。

---

## 部署

见 **`deploy/baota/README.md`**（2 核 4G 宝塔单机：MySQL 调参 / PM2 / Nginx / 备份 / 上线自检清单）。
`deploy/docker-compose.yml` 保留为将来迁移到云时的备用路径。
