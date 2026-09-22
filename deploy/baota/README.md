# 宝塔面板部署指南（2 核 4G 单机）

> 目标：一台已装宝塔的 2C4G 服务器承载全部后端 + 数据库 + 网页端；小程序代码由本机推送到商户小程序。

---

## 0. 为什么不用 Docker

原计划的 `deploy/docker-compose.yml` 保留（换大机器或上云时可切），但**当前这台不用**：

| 维度 | Docker Compose | 宝塔原生 |
|---|---|---|
| 2C4G 内存开销 | 多一层运行时 + 每个容器的基础占用，实测多吃 300–500MB | 无额外开销，**4G 内存下这是决定性因素** |
| 运维界面 | 全命令行 | 宝塔有面板（日志、计划任务、备份、SSL 一键） |
| 与现网共存 | 需处理端口与网络 | 直接共用已装的 Nginx / MySQL |
| 代价 | — | 环境靠文档约束，**不是靠镜像固化** → 本文档就是那份约束 |

**结论**：这台机器上用宝塔原生部署，Node 进程由 PM2 托管。docker-compose.yml 保留作为「将来迁移到云」的备用路径，不删。

---

## 1. 软件安装（宝塔 → 软件商店）

| 软件 | 版本 | 说明 |
|---|---|---|
| Nginx | 1.24+ | 已在用 |
| MySQL | **8.0** | 必须 8.0（租户库要 `utf8mb4_0900_ai_ci` 与窗口函数） |
| Redis | 7.x | 幂等键、库存去抖、BullMQ 队列 |
| Node.js 版本管理器 | — | 装 **Node 20 LTS**（本项目要求 `node >= 20`） |
| PM2 管理器 | — | 进程守护 + 开机自启 + 日志切分 |

> MySQL 与 Redis **只监听 127.0.0.1**（宝塔默认如此，别改）。数据库不对外网开放。

---

## 2. 内存调参（2C4G 上这一步不能省）

MySQL 默认配置在 4G 机器上会吃满内存导致 OOM。宝塔 → 数据库 → 配置修改：

```ini
# ---- /etc/my.cnf 关键项 ----
innodb_buffer_pool_size = 512M      # 默认可能到 1G+，2C4G 上要压到 512M
performance_schema = OFF            # 省 200–300MB，本项目不用它
max_connections = 100
table_open_cache = 256
innodb_log_file_size = 128M
innodb_flush_log_at_trx_commit = 2  # 牺牲极小概率的 1s 数据窗口换写入吞吐
```

Redis（宝塔 → Redis → 配置修改）：

```conf
maxmemory 128mb
maxmemory-policy allkeys-lru
appendonly no
save 900 1
```

**预算核对（4G）**：MySQL ≤1.2G · Redis ≤0.2G · Node API + Worker ≤0.6G · Nginx + 宝塔面板 ≤0.4G · 系统 ≤0.3G ≈ **2.7G**，留 1.3G 余量。

---

## 3. 目录结构

```
/www/wwwroot/snack/
├── server/        # 后端（git 拉取 + 构建产物）
│   ├── dist/
│   ├── .env       # 不进 git
│   └── logs/
├── web/
│   ├── admin/     # 商户网页（H5 构建产物）
│   └── platform/  # 平台后台（H5 构建产物）
├── tenants/       # 每租户数据库备份
└── uploads/       # 商品图（本机存储；量大后迁对象存储）
```

```bash
mkdir -p /www/wwwroot/snack/{server,web/admin,web/platform,tenants,uploads}
```

---

## 4. 数据库

```sql
-- 平台库：1 个
CREATE DATABASE snack_platform
  DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

-- 应用专用账号：只授权平台库与「租户库命名前缀」
-- 注意：不给 GRANT ALL ON *.*，应用不需要动别的库
CREATE USER 'snack_app'@'127.0.0.1' IDENTIFIED BY '<强密码>';
GRANT ALL PRIVILEGES ON `snack_platform`.* TO 'snack_app'@'127.0.0.1';
GRANT ALL PRIVILEGES ON `snack\_t%`.* TO 'snack_app'@'127.0.0.1';
FLUSH PRIVILEGES;
```

- **租户库（`snack_t000001` …）不手工建**，由「一键开新户」流水线自动 `CREATE DATABASE` + 跑租户库迁移。
  → 所以上面必须给 `snack\_t%` 前缀授权，否则新开租户会失败。
- 平台库与租户库的建表脚本在 `apps/server/prisma/`（两份 schema，分开 migrate）。

---

## 5. 后端部署

```bash
cd /www/wwwroot/snack/server
# 首次：拉代码（或本机 rsync 上传，排除 node_modules）
git clone <repo> . && git checkout <tag>

npm ci --omit=dev=false
npm run build -w @snack/tokens
npm run build -w @snack/server

# 数据库迁移（平台库）
npx prisma migrate deploy --schema prisma/schema.prisma

# 启动（PM2）
pm2 start dist/main.js --name snack-api -i 2 --max-memory-restart 400M
pm2 start dist/worker.js --name snack-worker -i 1 --max-memory-restart 300M
pm2 save && pm2 startup
```

> `-i 2`：2 核开 2 个 API 实例（cluster 模式）。**Worker 只能 1 实例** ——
> 定时任务（关单 / 日扣费 / 送达自动完成）多实例会重复执行，靠 Redis 分布式锁兜底但没必要主动引入。

`server/.env`（**权限 600，属主 root**）：

```ini
NODE_ENV=production
PORT=3000
DB_MODE=mysql

# 平台库
PLATFORM_DATABASE_URL="mysql://snack_app:<强密码>@127.0.0.1:3306/snack_platform"
# 租户库连接模板：{db} 会被替换成 snack_t000001
TENANT_DATABASE_URL_TEMPLATE="mysql://snack_app:<强密码>@127.0.0.1:3306/{db}"

JWT_SECRET="<openssl rand -hex 32 生成>"

# 平台后台过渡期鉴权（上线前必须换账号体系 + RBAC）
PLATFORM_ADMIN_KEY="<强随机串>"

# 微信登录：AppID 与小程序端 manifest.json 保持一致，AppSecret 只在这里出现
WECHAT_APPID=wxa36284295094324e
WECHAT_APPSECRET="<公众平台生成的小程序密钥>"
# 生产必须为 false —— 打开它等于任何人可以冒充任意学生
WECHAT_ALLOW_INSECURE_OPENID=false

# 微信支付：商户号未开通前留空，接口返回 PAY_NOT_CONFIGURED（订单留在待支付，不假装成功）
WECHATPAY_MCHID=
WECHATPAY_APIV3_KEY=
WECHATPAY_SERIAL_NO=
WECHATPAY_PRIVATE_KEY=
WECHATPAY_NOTIFY_BASE_URL=https://<域名>
# 商户号就绪前用它跑通闭环；**生产必须 false**
DEV_PAY_SIMULATE=false
LOG_LEVEL=info

# ⚠️ 变量名以 apps/server/src/core/env.ts 为准。文档与代码不一致时，以代码为准 ——
#    照着文档配出一个代码根本不读的变量，是部署期最难查的一类故障。

```

---

## 6. 网页端（商户网页 / 平台后台）

```bash
# 本机构建后上传，或服务器上构建
npm run build:h5 -w @snack/mini
# 产物：apps/mini/dist/build/h5
rsync -a apps/mini/dist/build/h5/ root@<server>:/www/wwwroot/snack/web/admin/
```

> 商户网页与平台后台是同一个 H5 产物、按路由分区（`/#/admin/...` 与 `/#/platform/...`）。
> 上线前若拆成两个站点，只需改 `location` 的 alias 指向，前端不用改。

---

## 7. Nginx 站点配置

宝塔 → 网站 → 添加站点 → 绑定**已备案域名** → 申请 Let's Encrypt 证书 → 开启「强制 HTTPS」。

在配置文件里加入：

```nginx
upstream snack_api {
    server 127.0.0.1:3000;
    keepalive 32;
}

server {
    listen 443 ssl http2;
    server_name <你的已备案域名>;
    charset utf-8;
    client_max_body_size 20m;          # Excel 批量导入（含楼栋列）

    # ---- 小程序统一入口：AppID → 租户 ----
    location /api/ {
        proxy_pass http://snack_api;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    # ---- 兜底路径前缀（AppID 不可用时的退路） ----
    location ~ ^/t/[A-Za-z0-9_-]+/api/ {
        proxy_pass http://snack_api;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # ---- 商户网页 ----
    location /admin/ {
        alias /www/wwwroot/snack/web/admin/;
        try_files $uri $uri/ /admin/index.html;
    }

    # ---- 平台后台 ----
    # 四色中性、永不接受租户主题色（AC-12）；
    # 过渡期双重保护：① 应用侧 x-platform-key ② 这里再加一层 Basic 认证。
    # 上线前必须换成真实账号体系 + RBAC + 操作审计，Basic 认证只是挡路人。
    location /platform/ {
        alias /www/wwwroot/snack/web/platform/;
        try_files $uri $uri/ /platform/index.html;
        auth_basic "Restricted";
        auth_basic_user_file /www/server/panel/vhost/nginx/.platform_htpasswd;
    }

    location / { return 404; }        # 不暴露其他任何路径

    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header Strict-Transport-Security "max-age=31536000" always;
}
```

生成 Basic 认证账号：

```bash
printf "admin:%s\n" "$(openssl passwd -apr1 '<强密码>')" \
  > /www/server/panel/vhost/nginx/.platform_htpasswd
chmod 600 /www/server/panel/vhost/nginx/.platform_htpasswd
```

---

## 8. 小程序代码推送

小程序 request 合法域名填 **`https://<已备案域名>`**（只需一个域名、一条记录 —— 这正是「绝不每租户一个子域名」的原因）。

代码上传密钥（只有小程序**管理员**能生成）：

1. 微信公众平台 → 开发 → 开发设置 → 小程序代码上传 → 生成密钥 → 下载 `private.<appid>.key`
2. **配置 IP 白名单 = 本机公网出口 IP**（不是服务器 IP，因为推送是从开发机发起的）
3. 密钥放 `~/.wx-ci/private.<appid>.key`，**权限 600，绝不入库**

```bash
npx miniprogram-ci upload \
  --appid <测试小程序 AppID> \
  --project-path apps/mini/dist/build/mp-weixin \
  --private-key-path ~/.wx-ci/private.<appid>.key \
  --upload-version 1.0.0 \
  --upload-desc "首次联调"
```

> `miniprogram-ci` **只能上传/预览，不能提审发布** —— 提审仍需管理员在公众平台点一下。
> 因此 `DeployProvider` 抽象保留，够 30–50 家后再评估迁第三方平台。

---

## 9. 备份（宝塔计划任务）

| 任务 | 频率 | 命令 |
|---|---|---|
| 平台库全量 | 每日 03:00 | `mysqldump snack_platform \| gzip > /www/wwwroot/snack/tenants/platform_$(date +\%F).sql.gz` |
| **每租户库单独导出** | 每日 03:30 | 脚本遍历 `snack_t%` 逐库导出 —— **租户库能独立恢复是本项目选「每租户独立库」的核心收益，备份必须兑现它** |
| 上传目录 | 每日 04:00 | 宝塔「文件备份」 |

保留 7 日 + 每周日一份留 4 周。备份目录绑定到对象存储或另一台机器，**不要只留在同一块盘上**。

---

## 10. 上线自检清单

- [ ] `curl https://<域名>/api/health` 返回 200，且响应体不含任何租户私有字段
- [ ] `curl https://<域名>/api/health` 的日志行**带 `tenant_code`**（平台侧为 `-`）
- [ ] `/platform/` 直接访问返回 401（Basic 认证生效）
- [ ] MySQL / Redis 端口从公网 `telnet` 不通
- [ ] `.env` 权限 600；`JWT_SECRET` 是随机值且已单独异地备份
- [ ] `PLATFORM_ADMIN_KEY` 不是默认值 `dev-platform-key`
- [ ] `WECHAT_APPID` 与小程序端 `manifest.json` 完全一致；`WECHAT_ALLOW_INSECURE_OPENID=false`
- [ ] `DEV_PAY_SIMULATE=false`（生产打开它 = 任何人可以把任意订单标记已支付）
- [ ] 微信支付 5 个变量要么全配、要么全空（半配会导致"能下单不能退款"）
- [ ] 建一个新租户，确认 `snack_tXXXXXX` 自动创建成功（验证 `snack\_t%` 授权）
- [ ] 关掉 MySQL 再启动，PM2 里的 API 能自动重连（不是崩溃退出）
- [ ] 备份任务跑过一次且文件非空

---

## 11. 凭据落在哪（唯一清单 —— 不要出现第二份）

| 凭据 | 落地位置 | 可否入库 |
|---|---|---|
| 小程序 AppID `wxa36284295094324e` | `apps/mini/src/manifest.json`（顶层 `appid` **与** `mp-weixin.appid` 两处）+ 服务端 `WECHAT_APPID` | ✅ 可入库（非机密） |
| 小程序 AppSecret | **只**在服务端环境变量（本机 `apps/server/.env.local`，生产 `.env`） | ❌ 绝不入库 |
| JWT_SECRET | 服务端环境变量，每环境独立随机 | ❌ |
| 宝塔面板账号 | 不进仓库、不进聊天截图 | ❌ |

> ⚠️ **AppSecret 出现在这份清单之外的地方（聊天记录、截图、issue、日志）就等于已泄露。**
> 处置方式只有一个：公众平台【开发 → 开发管理 → 开发设置 → 重置 AppSecret】。
> 重置后旧密钥立即失效，必须同步更新服务端环境变量 —— 这也解释了为什么它
> 只允许存在一个位置：位置多了就一定漏改。

### 11.1 微信开发者工具（本地联调必装）

| 场景 | 需要开发者工具吗 |
|---|---|
| 改代码看效果 / 真机预览 / 上传体验版 | **需要**（或用 `miniprogram-ci` + 上传密钥走 CI，见 §8） |
| 只调后端接口（curl / 冒烟） | 不需要 |

导入步骤：

1. 装「微信开发者工具 稳定版 Windows 64」
2. 导入目录 `apps/mini/dist/dev/mp-weixin`（`npm run dev:mp` 产出，改代码热更新）
   —— 不是 `apps/mini/src`，那是 uni-app 源码，微信工具不认识 `.vue`
3. AppID 填 `wxa36284295094324e`（也可选「测试号」，但拿不到真实 openid）
4. 详情 → 本地设置 → 勾 **「不校验合法域名、web-view、TLS 版本」**
   —— 否则 `http://127.0.0.1:3000` 会被域名校验拦掉
5. 后端地址由 `apps/mini/.env.local` 的 `VITE_API_BASE` 决定（默认 `http://127.0.0.1:3000`）

**真机预览的硬门槛**：真机（非开发者工具模拟器）走真实域名校验，
所以 `VITE_API_BASE` 必须是 **https + 已备案域名**，且该域名已加入
公众平台【request 合法域名】。纯 IP + 端口在真机上永远不通 ——
这是微信小程序的规定，不是本项目能绕过的。
