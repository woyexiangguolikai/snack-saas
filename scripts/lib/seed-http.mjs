/**
 * 种子脚本的公共底座：环境解析 + 请求封装 + 拿令牌。
 *
 * 为什么抽出来：
 *   `seed-dev.mjs`（本机开发最小数据）与 `seed-demo.mjs`（演示/送审数据）
 *   要做的前三步完全一样 —— 探活、找/建租户、取店主令牌。
 *   抄两份的代价不是多写几十行，而是**两份会各自漂移**：
 *   哪天 .env 解析规则改了、或令牌接口换了头，必然只改到一个脚本，
 *   另一个在某个深夜 quietly 失败。所以公共部分只留一份。
 *
 * 这里只放"两个脚本都要用"的东西，各自的业务数据留在各自文件里。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const SERVER_DIR = path.join(ROOT, 'apps', 'server');

export function argOf(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** 极简 .env 解析：只认 KEY=VALUE，够用且不引依赖（与服务端 core/env.ts 同策略） */
export function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

export function envOf() {
  const fileEnv = { ...readEnvFile(path.join(SERVER_DIR, '.env')), ...readEnvFile(path.join(SERVER_DIR, '.env.local')) };
  const port = process.env.PORT ?? fileEnv.PORT ?? '3000';
  return {
    base: (argOf('server') ?? process.env.SNACK_SERVER ?? `http://127.0.0.1:${port}`).replace(/\/+$/, ''),
    appid: argOf('appid') ?? process.env.WECHAT_APPID ?? fileEnv.WECHAT_APPID ?? '',
    adminKey: process.env.PLATFORM_ADMIN_KEY ?? fileEnv.PLATFORM_ADMIN_KEY ?? '',
  };
}

/**
 * 请求封装。
 *
 * 连不上时**直接退出并给出可执行的下一步** —— 种子脚本最常见的失败
 * 就是"服务端没起"，让它报一个 fetch 堆栈等于没帮上忙。
 */
export function makeCaller(base) {
  return async function call(method, url, { body, token, platformKey } = {}) {
    const header = { 'content-type': 'application/json' };
    if (token) header.authorization = `Bearer ${token}`;
    if (platformKey) header['x-platform-key'] = platformKey;

    let res;
    try {
      res = await fetch(`${base}${url}`, { method, headers: header, body: body ? JSON.stringify(body) : undefined });
    } catch (e) {
      console.error(
        `[seed] 连不上 ${base} —— ${e.message}\n` +
          '  服务端没起。先在另一个终端跑：npm run dev:server（或在仓库根跑 npm run start:server）',
      );
      process.exit(1);
    }
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    return { status: res.status, body: data };
  };
}

export const ok = (r) => r.status >= 200 && r.status < 300;

/** 短说明：把错误响应压成一行，方便逐条打印 */
export function brief(r) {
  const b = r.body;
  const msg = b?.error?.message ?? b?.message ?? b?.raw ?? JSON.stringify(b);
  return `HTTP ${r.status} ${typeof msg === 'string' ? msg.slice(0, 120) : ''}`;
}

/**
 * 探活。放在最前面：否则要等到第 4 步才发现服务没起，
 * 那时已经输出了一堆半截信息，看起来像"脚本有问题"。
 */
export async function requireHealthy(call) {
  const h = await call('GET', '/api/health');
  if (!ok(h)) {
    console.error(`[seed] 健康检查失败（${brief(h)}）`);
    process.exit(1);
  }
  console.log(`[seed] 服务健康：dbMode=${h.body.dbMode} nodeEnv=${h.body.nodeEnv}`);
  return h.body;
}

/**
 * 找租户，没有就建（需要平台密钥）。
 * 幂等：第二次跑会识别出已存在并复用 —— 种子脚本必须能反复跑，
 * 否则每次重跑都多一家店，最后自己都分不清哪个是要演示的那个。
 */
export async function ensureTenant(call, { appid, adminKey, shopName }) {
  const existing = await call('POST', '/api/tenant/resolve', { body: { appid } });
  if (ok(existing)) {
    console.log(`[seed] 该 AppID 已开店：${existing.body.tenantCode}（${existing.body.shopName}），复用`);
    return { tenantCode: existing.body.tenantCode, created: false, body: existing.body };
  }
  if (existing.body?.error?.code !== 'TENANT_NOT_FOUND') {
    console.error(`[seed] resolve 异常（${brief(existing)}）`);
    process.exit(1);
  }
  if (!adminKey) {
    console.error(
      '[seed] 建租户需要平台密钥。在 apps/server/.env.local 里配 PLATFORM_ADMIN_KEY，\n' +
        '       或用环境变量：PLATFORM_ADMIN_KEY=xxx node scripts/seed-dev.mjs',
    );
    process.exit(1);
  }
  const created = await call('POST', '/api/platform/tenants', {
    platformKey: adminKey,
    body: {
      shopName,
      orgName: '演示用经营主体',
      appid,
      schoolId: 1,
      region: '广西',
      contactName: '演示店主',
      contactPhone: '13800000000',
    },
  });
  if (!ok(created)) {
    console.error(`[seed] 建租户失败（${brief(created)}）`);
    process.exit(1);
  }
  console.log(
    `[seed] 已建租户 ${created.body.tenant.tenantCode}（${created.body.tenant.shopName}），` +
      `带出 ${created.body.buildings.length} 个楼栋`,
  );
  return { tenantCode: created.body.tenant.tenantCode, created: true, body: created.body };
}

/** 店主令牌（目录域：建商品 / 铺库存 / 改楼栋都要求店主身份） */
export async function ownerToken(call, { tenantCode, adminKey }) {
  const r = await call('POST', '/api/platform/merchant/token', { platformKey: adminKey, body: { tenantCode } });
  if (!ok(r)) {
    console.error(`[seed] 取店主令牌失败（${brief(r)}）\n  多半是 PLATFORM_ADMIN_KEY 与服务端不一致。`);
    process.exit(1);
  }
  return r.body.token;
}

/**
 * 把营业时段放宽到近乎全天。
 *
 * 为什么需要它：默认营业时间是 06:30–22:30，于是凌晨跑脚本会拿到
 * "店家还没开始营业"、深夜跑会拿到"今日营业已结束"。
 * 这两个状态本身都是对的（AC-02 的灰态），但**演示与压测都必须挑不出时段**，
 * 所以脚本要把时段撑开；真要演示营业节律，在店铺设置页改一眼就能改回来。
 *
 * ⚠️ 顺序不能改，也不能合并：营业时间会被门禁窗口**自动截断**，
 *    三条请求里任何一条提前，都会导致"设了但没生效" —— 接口照样 200，
 *    saved 里却是旧值。所以必须 楼栋门禁 → 店铺门禁 → 营业时间。
 */
export async function widenBusinessHours(call, { tenantCode, owner }) {
  const T = `/t/${tenantCode}/api`;
  const r1 = await call('POST', `${T}/time-window/bulk`, {
    token: owner,
    body: { accessibleFrom: '00:00', accessibleTo: '23:59' },
  });
  const r2 = await call('POST', `${T}/config`, {
    token: owner,
    body: { accessibleFrom: '00:00', accessibleTo: '23:59' },
  });
  const r3 = await call('POST', `${T}/config`, {
    token: owner,
    body: { openTime: '00:00', closeTime: '23:59', cutoffLeadMinutes: 10 },
  });
  return { ok: ok(r1) && ok(r2) && ok(r3), detail: [r1, r2, r3].map(brief).join(' / ') };
}

/**
 * 学生令牌。
 *
 * 走 `resolve` 直传 openid：服务端只在**非生产**放开这条路径
 * （`env.wechat.allowInsecureOpenid`），真机上是 wx.login 拿 code。
 * 种子脚本本来就是本机/演示用途，用它是恰当的 —— 但要先探一下开关，
 * 关着就直接说清楚原因，而不是发一个必然 403 的请求。
 */
export async function studentToken(call, { appid, openid, nickname }) {
  const status = await call('GET', '/api/tenant/auth/status');
  if (ok(status) && status.body?.insecureOpenidAllowed === false) {
    console.error(
      '[seed] 服务端未放开 openid 直传（ALLOW_INSECURE_OPENID 未开），无法造学生身份。\n' +
        '  本机/演示环境在 apps/server/.env.local 里配 ALLOW_INSECURE_OPENID=true。',
    );
    process.exit(1);
  }
  const r = await call('POST', '/api/tenant/resolve', { body: { appid, openid, nickname } });
  if (!ok(r)) {
    console.error(`[seed] 取学生令牌失败（${brief(r)}）`);
    process.exit(1);
  }
  return r.body.token;
}
