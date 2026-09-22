#!/usr/bin/env node
/**
 * 一键把「本机开发环境」铺到能真跑起来的状态。
 *
 * 为什么需要它：服务端默认 `DB_MODE=memory`，进程一停数据就没了，
 * 而内存库启动时是**零租户**。于是 `POST /api/tenant/resolve` 对任何 AppID
 * 都只会回 `TENANT_NOT_FOUND` —— 小程序端连上了后端，看到的却是「店铺未开通」，
 * 很容易被误判成"接口还没写完"。
 *
 * 这个脚本做三件事（可重复执行，第二次会识别出已存在并跳过）：
 *   ① 用 `apps/server/.env.local` 里的真实 AppID 建一个租户（自动带出学校楼栋模板）
 *   ② 建几个商品并在每个楼栋铺上库存 —— 否则首页是空态，等于没验证
 *   ③ 打印下一步操作（怎么在开发者工具里看到商品）
 *
 * 用法：
 *   node scripts/seed-dev.mjs                 # 用 .env.local 里的 WECHAT_APPID
 *   node scripts/seed-dev.mjs --appid wxXXX   # 指定 AppID（多台机器/多个小程序）
 *   node scripts/seed-dev.mjs --server http://192.168.1.7:3000
 *
 * 前置：服务端已在运行（`npm run dev:server` 或 `npm run start:server`）。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const SERVER_DIR = path.join(ROOT, 'apps', 'server');

/* ------------------------------------------------------------ 参数与环境 */

function argOf(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** 极简 .env 解析：只认 KEY=VALUE，够用且不引依赖（与服务端 core/env.ts 同策略） */
function readEnvFile(file) {
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

const fileEnv = { ...readEnvFile(path.join(SERVER_DIR, '.env')), ...readEnvFile(path.join(SERVER_DIR, '.env.local')) };
const PORT = process.env.PORT ?? fileEnv.PORT ?? '3000';
const BASE = (argOf('server') ?? process.env.SNACK_SERVER ?? `http://127.0.0.1:${PORT}`).replace(/\/+$/, '');
const APPID = argOf('appid') ?? process.env.WECHAT_APPID ?? fileEnv.WECHAT_APPID ?? '';
const ADMIN_KEY = process.env.PLATFORM_ADMIN_KEY ?? fileEnv.PLATFORM_ADMIN_KEY ?? '';

if (!APPID) {
  console.error(
    '[seed] 缺 AppID。三种给法（任选其一）：\n' +
      '  · node scripts/seed-dev.mjs --appid wx1234567890abcdef\n' +
      '  · 在 apps/server/.env.local 里配 WECHAT_APPID=wx...\n' +
      '  · 环境变量 WECHAT_APPID=wx... node scripts/seed-dev.mjs',
  );
  process.exit(1);
}

/* ---------------------------------------------------------------- 请求封装 */

async function call(method, url, { body, token, platformKey } = {}) {
  const header = { 'content-type': 'application/json' };
  if (token) header.authorization = `Bearer ${token}`;
  if (platformKey) header['x-platform-key'] = platformKey;

  let res;
  try {
    res = await fetch(`${BASE}${url}`, { method, headers: header, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    console.error(
      `[seed] 连不上 ${BASE} —— ${e.message}\n` +
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
}

const ok = (r) => r.status >= 200 && r.status < 300;

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  console.log(`[seed] 目标服务：${BASE}`);
  console.log(`[seed] 目标 AppID：${APPID}`);

  // 0. 健康检查：先确认后端真的活着，而不是等到第 3 步才发现
  const health = await call('GET', '/api/health');
  if (!ok(health)) {
    console.error(`[seed] 健康检查失败（HTTP ${health.status}）：${JSON.stringify(health.body)}`);
    process.exit(1);
  }
  console.log(`[seed] 服务健康：dbMode=${health.body.dbMode} nodeEnv=${health.body.nodeEnv}`);

  // 1. 已有租户就直接复用（这个脚本要能反复跑）
  let tenantCode = '';
  const existing = await call('POST', '/api/tenant/resolve', { body: { appid: APPID } });
  if (ok(existing)) {
    tenantCode = existing.body.tenantCode;
    console.log(`[seed] 该 AppID 已开店：${tenantCode}（${existing.body.shopName}），跳过建租户`);
  } else {
    if (existing.body?.error?.code !== 'TENANT_NOT_FOUND') {
      console.error(`[seed] resolve 异常（HTTP ${existing.status}）：${JSON.stringify(existing.body)}`);
      process.exit(1);
    }
    if (!ADMIN_KEY) {
      console.error(
        '[seed] 建租户需要平台密钥。在 apps/server/.env.local 里配 PLATFORM_ADMIN_KEY，\n' +
          '       或用环境变量：PLATFORM_ADMIN_KEY=xxx node scripts/seed-dev.mjs',
      );
      process.exit(1);
    }

    const created = await call('POST', '/api/platform/tenants', {
      platformKey: ADMIN_KEY,
      body: {
        shopName: '张姐零食铺（本机开发）',
        orgName: '本机开发用经营主体',
        appid: APPID,
        schoolId: 1,
        region: '广西',
        contactName: '张姐',
        contactPhone: '13800000000',
      },
    });
    if (!ok(created)) {
      console.error(`[seed] 建租户失败（HTTP ${created.status}）：${JSON.stringify(created.body)}`);
      process.exit(1);
    }
    tenantCode = created.body.tenant.tenantCode;
    console.log(
      `[seed] 已建租户 ${tenantCode}（${created.body.tenant.shopName}），` +
        `带出 ${created.body.buildings.length} 个楼栋`,
    );
  }

  // 2. 取店主令牌：目录域（建商品 / 铺库存）全部要求店主身份
  const ot = await call('POST', '/api/platform/merchant/token', { platformKey: ADMIN_KEY, body: { tenantCode } });
  if (!ok(ot)) {
    console.error(
      `[seed] 取店主令牌失败（HTTP ${ot.status}）：${JSON.stringify(ot.body)}\n` +
        '  多半是 PLATFORM_ADMIN_KEY 与服务端不一致。',
    );
    process.exit(1);
  }
  const owner = ot.body.token;

  // 3. 楼栋清单（建商品时要指定上架到哪些楼栋）
  const resolved = await call('POST', '/api/tenant/resolve', { body: { appid: APPID } });
  const buildingIds = (resolved.body.buildings ?? []).map((b) => b.buildingId);
  if (!buildingIds.length) {
    console.error('[seed] 该租户没有任何楼栋 —— 先去平台后台补楼栋模板');
    process.exit(1);
  }

  // 4. 商品 + 铺货。已存在的商品不重建（避免每跑一次就多一批）
  const MENU = [
    { name: '可乐 330ml', spec: '罐装', priceCents: 350 },
    { name: '冰红茶 500ml', spec: '瓶装', priceCents: 400 },
    { name: '薯片 大包装', spec: '原味', priceCents: 650 },
    { name: '辣条 五连包', spec: '中辣', priceCents: 500 },
    { name: '矿泉水 550ml', spec: '瓶装', priceCents: 200 },
  ];

  const listed = await call('GET', `/t/${tenantCode}/api/catalog/products`, { token: owner });
  const existingNames = new Set((listed.body?.items ?? []).map((p) => p.name));

  for (const item of MENU) {
    if (existingNames.has(item.name)) {
      console.log(`[seed] 商品已存在，跳过：${item.name}`);
      continue;
    }
    const r = await call('POST', `/t/${tenantCode}/api/catalog/products`, {
      token: owner,
      body: { ...item, buildingIds },
    });
    if (!ok(r)) {
      console.error(`[seed] 建商品失败「${item.name}」（HTTP ${r.status}）：${JSON.stringify(r.body)}`);
      continue;
    }
    const productId = r.body.product.id;
    // 一次给所有楼栋铺 30 件：批量接口就是为这个场景准备的
    const bulk = await call('POST', `/t/${tenantCode}/api/catalog/bulk`, {
      token: owner,
      body: { productId, buildingIds, stock: 30 },
    });
    console.log(
      ok(bulk)
        ? `[seed] 已上架 ${item.name}（${(item.priceCents / 100).toFixed(2)} 元 × ${buildingIds.length} 栋 × 30 件）`
        : `[seed] ${item.name} 铺货失败：${JSON.stringify(bulk.body)}`,
    );
  }

  // 5. 收尾：把可核对的现场信息打出来，不要让人去猜"到底成没成"
  const storefront = await call('GET', `/t/${tenantCode}/api/catalog/storefront?buildingId=${buildingIds[0]}`, {
    token: resolved.body.token,
  });
  const count = storefront.body?.items?.length ?? 0;

  console.log('\n[seed] 完成。开发者工具里应该看到：');
  console.log(`  · 店名：张姐零食铺（本机开发）`);
  console.log(`  · 楼栋：${buildingIds.length} 个，默认 1 栋下有 ${count} 种商品`);
  console.log(`  · 租户编码：${tenantCode}`);
  console.log('\n注意：DB_MODE=memory 下**重启服务端数据即清空**，重启后重跑本脚本即可。');
}

main().catch((e) => {
  console.error('[seed] 未预期的错误：', e);
  process.exit(1);
});
