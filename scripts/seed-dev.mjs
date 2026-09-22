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
import process from 'node:process';
import { brief, ensureTenant, envOf, makeCaller, ok, ownerToken, requireHealthy } from './lib/seed-http.mjs';

/* ------------------------------------------------------------ 参数与环境 */

// 环境解析、请求封装、建租户、取令牌都在 lib/seed-http.mjs 里，与 seed-demo.mjs 共用。
// 共用不是为了少写几行：两份实现必然各自漂移，改了 .env 解析或令牌头只改到一处，
// 另一个会在某个深夜 quietly 失败。
const { base: BASE, appid: APPID, adminKey: ADMIN_KEY } = envOf();
const call = makeCaller(BASE);

if (!APPID) {
  console.error(
    '[seed] 缺 AppID。三种给法（任选其一）：\n' +
      '  · node scripts/seed-dev.mjs --appid wx1234567890abcdef\n' +
      '  · 在 apps/server/.env.local 里配 WECHAT_APPID=wx...\n' +
      '  · 环境变量 WECHAT_APPID=wx... node scripts/seed-dev.mjs',
  );
  process.exit(1);
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  console.log(`[seed] 目标服务：${BASE}`);
  console.log(`[seed] 目标 AppID：${APPID}`);

  // 0. 健康检查 + 1. 复用/新建租户 + 2. 取店主令牌 —— 三步都在 lib 里（与 seed-demo 同一套）
  await requireHealthy(call);
  const { tenantCode } = await ensureTenant(call, {
    appid: APPID,
    adminKey: ADMIN_KEY,
    shopName: '张姐零食铺（本机开发）',
  });
  const owner = await ownerToken(call, { tenantCode, adminKey: ADMIN_KEY });

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
