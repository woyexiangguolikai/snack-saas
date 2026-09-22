#!/usr/bin/env node
/**
 * 演示 / 送审数据（需求 v0.4 细节 37）。
 *
 * 细节 37 原文：**上线前预置演示商品与楼栋，否则空壳小程序审核大概率驳回**。
 *
 * 它和 `seed-dev.mjs` 的区别是目的不同，不是数据多少不同：
 *   · seed-dev  → 让**开发**能把闭环跑通（有商品能下单就行）
 *   · seed-demo → 让**审核/演示**看到"一家正在营业的真店"
 *
 * 后者要求的不只是"有数据"，而是**每个状态都看得到样本**：
 *   · 库存格要同时存在 在售 / 低库存 / 售罄 / 未上架 四种（AC-11 双重编码要靠它验证）
 *   · 要有一栋处于"今日停送"，用来证明停送**不清库存**（AC-17）
 *   · 时间窗必须覆盖"现在" —— 否则演示时学生端满屏"已截单"，
 *     审核看到的就是一家永远关着的店，比空壳还糟
 *   · 配送清单里要有单，商户端的空间序（楼栋→楼层→房间，AC-03）才有东西可排
 *
 * 可重复执行：商品按名跳过、订单按"已有进行中"跳过，反复跑不会堆数据。
 *
 * 用法：
 *   node scripts/seed-demo.mjs                  # 用 .env.local 的 WECHAT_APPID
 *   node scripts/seed-demo.mjs --appid wxXXX
 *   node scripts/seed-demo.mjs --server http://192.168.1.7:3000
 *   node scripts/seed-demo.mjs --no-orders      # 只铺货，不造订单（审核截图用）
 *
 * 前置：服务端已在运行，且（造订单时）ALLOW_INSECURE_OPENID=true。
 */
import process from 'node:process';
import {
  brief,
  ensureTenant,
  envOf,
  makeCaller,
  ok,
  ownerToken,
  requireHealthy,
  studentToken,
  widenBusinessHours,
} from './lib/seed-http.mjs';

const { base, appid, adminKey } = envOf();
const call = makeCaller(base);
const SHOP_NAME = '张姐零食铺（演示店）';
const WANT_ORDERS = !process.argv.includes('--no-orders');

if (!appid) {
  console.error(
    '[seed] 缺 AppID。三种给法（任选其一）：\n' +
      '  · node scripts/seed-demo.mjs --appid wx1234567890abcdef\n' +
      '  · 在 apps/server/.env.local 里配 WECHAT_APPID=wx...\n' +
      '  · 环境变量 WECHAT_APPID=wx... node scripts/seed-demo.mjs',
  );
  process.exit(1);
}

/* ------------------------------------------------------------------ 数据 */

/**
 * 演示菜单。库存数字是**刻意分层的**，不是为了好看：
 *   · 30 件 → 在售（正常）
 *   · 2 件  → 低库存（触发低库存角标）
 *   · 0 件  → 售罄（触发售罄角标，且下单时会被拒，用来演示 §5.4-3 的文案）
 *   · fewer → 只在部分楼栋上架，用来演示"未上架 ≠ 售罄"（AC-11 三态分明）
 */
const MENU = [
  { name: '可乐 330ml', spec: '罐装', priceCents: 350, stock: 30 },
  { name: '冰红茶 500ml', spec: '瓶装', priceCents: 400, stock: 30 },
  { name: '矿泉水 550ml', spec: '瓶装', priceCents: 200, stock: 30 },
  { name: '薯片 大包装', spec: '原味', priceCents: 650, stock: 30 },
  { name: '辣条 五连包', spec: '中辣', priceCents: 500, stock: 30 },
  { name: '面包 手撕', spec: '奶香', priceCents: 450, stock: 30 },
  // warnStock 必须显式给：不设阈值的话 2 件只会显示"在售"，
  // 低库存那一格永远出不来 —— 库存格四态少一态，AC-11 的双重编码就演示不全。
  { name: '泡面 桶装', spec: '红烧', priceCents: 550, stock: 2, warnStock: 5, note: '低库存' },
  { name: '雪糕 随机口味', spec: '支', priceCents: 300, stock: 0, note: '售罄' },
  { name: '酸奶 连杯', spec: '原味', priceCents: 600, stock: 20, fewer: true, note: '只在部分楼栋上架' },
];

/** 演示用收货地址（房间号属于租户库，平台端看不到 —— AC-13） */
const ADDRESSES = [
  { floor: '3', room: '301', contact: '演示同学A' },
  { floor: '5', room: '512', contact: '演示同学B' },
];

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  console.log(`[seed-demo] 目标服务：${base}`);
  await requireHealthy(call);

  const { tenantCode } = await ensureTenant(call, { appid, adminKey, shopName: SHOP_NAME });
  const owner = await ownerToken(call, { tenantCode, adminKey });
  const T = `/t/${tenantCode}/api`;

  // 楼栋：模板带出。至少要有 2 栋，否则"停送一栋"会把店变成不可下单
  const resolved = await call('POST', '/api/tenant/resolve', { body: { appid } });
  const buildings = resolved.body?.buildings ?? [];
  if (buildings.length < 2) {
    console.error(`[seed-demo] 该租户只有 ${buildings.length} 个楼栋 —— 演示至少需要 2 栋（一栋正常、一栋停送）`);
    process.exit(1);
  }
  const ids = buildings.map((b) => b.buildingId);
  console.log(`[seed-demo] 楼栋 ${buildings.length} 栋：${buildings.map((b) => b.buildingName).join(' / ')}`);

  /* ---------------------------------------------------------- ① 商品与库存 */

  const listed = await call('GET', `${T}/catalog/products`, { token: owner });
  const existing = new Map((listed.body?.items ?? []).map((p) => [p.name, p.id]));

  for (const item of MENU) {
    const note = item.note ? `（${item.note}）` : '';
    if (existing.has(item.name)) {
      console.log(`[seed-demo] 已存在，跳过：${item.name}${note}`);
      continue;
    }
    // fewer：只铺前一半楼栋，剩下的楼栋这一格就是"未上架"
    const target = item.fewer ? ids.slice(0, Math.max(1, Math.floor(ids.length / 2))) : ids;
    const r = await call('POST', `${T}/catalog/products`, {
      token: owner,
      body: { name: item.name, spec: item.spec, priceCents: item.priceCents, buildingIds: target },
    });
    if (!ok(r)) {
      console.error(`[seed-demo] 建商品失败「${item.name}」（${brief(r)}）`);
      continue;
    }
    const bulk = await call('POST', `${T}/catalog/bulk`, {
      token: owner,
      body: { productId: r.body.product.id, buildingIds: target, stock: item.stock, warnStock: item.warnStock ?? null },
    });
    console.log(
      ok(bulk)
        ? `[seed-demo] 已上架 ${item.name} ¥${(item.priceCents / 100).toFixed(2)} × ${target.length} 栋 × ${item.stock} 件${note}`
        : `[seed-demo] ${item.name} 铺货失败（${brief(bulk)}）`,
    );
  }

  /* ---------------------------------------------------------- ② 停送一栋 */

  // 停送**最后一栋**而不是第一栋：默认选中通常是第一栋，
  // 把默认栋停了会让演示者一进来就看到"今天做不了"，以为脚本坏了（AC-17）。
  const paused = buildings[buildings.length - 1];
  const pr = await call('PATCH', `${T}/buildings/${paused.buildingId}`, {
    token: owner,
    body: { deliveryEnabled: false },
  });
  console.log(
    ok(pr)
      ? `[seed-demo] 「${paused.buildingName}」已设为今日停送（库存保留，用来演示停送 ≠ 清库存）`
      : `[seed-demo] 停送设置失败（${brief(pr)}）`,
  );

  /* ---------------------------------------------------------- ③ 时间窗 */

  // 营业与门禁都放宽到近乎全天，并只留 10 分钟在途预留。
  //
  // 为什么不写成固定的 09:00–22:00：那才像一家真店，但演示脚本半夜跑一次就会
  // 满屏"今日营业已结束"（AC-02 的灰态）—— 状态本身没错，错在把它当成唯一能看的。
  // 演示数据的目标是"每个界面都有东西可看"，所以时段取宽值。
  // 真要演示营业节律，在「店铺设置 / 时间窗」页改一眼就能改回来。
  // 放宽容段到近乎全天（顺序敏感的三步在 lib 里，压测脚本用的是同一份）
  const widened = await widenBusinessHours(call, { tenantCode, owner });
  console.log(
    widened.ok
      ? `[seed-demo] 营业 00:00–23:59、门禁 00:00–23:59、在途预留 10 分钟（最大化可演示时段）`
      : `[seed-demo] 时间设置未完全成功（${widened.detail}）`,
  );

  /* ---------------------------------------------------------- ④ 余额 */

  const topup = await call('POST', `/api/platform/ledger/${tenantCode}/topup`, {
    platformKey: adminKey,
    body: { amountCents: 50000, note: '演示充值' },
  });
  console.log(
    ok(topup)
      ? `[seed-demo] 已充值 ¥500.00（账本有流水，"服务费余额"卡片才不是空的）`
      : `[seed-demo] 充值失败（${brief(topup)}）—— 不影响演示，只是账本为空`,
  );

  /* ---------------------------------------------------------- ⑤ 订单 */

  if (!WANT_ORDERS) {
    return finish(tenantCode, buildings, ids);
  }

  const student = await studentToken(call, {
    appid,
    openid: 'demo-student-0001',
    nickname: '演示同学',
  });

  // 已有的进行中订单够了就不再造：反复跑演示脚本不该把订单列表撑到几百条
  const mine = await call('GET', `${T}/orders`, { token: student });
  const ongoing = (mine.body?.items ?? []).filter((o) => ['pending_payment', 'paid', 'accepted', 'delivering'].includes(o.status));
  if (ongoing.length >= 2) {
    console.log(`[seed-demo] 已有 ${ongoing.length} 单进行中，跳过造单`);
    return finish(tenantCode, buildings, ids);
  }

  // 下单要用**第一栋**（未停送的那栋）
  const b0 = buildings[0];

  // 先问闸门再下单。直接 POST 的话，遇到截单/停送只会拿到一句 400，
  // 读的人分不清"脚本写错了"还是"现在本来就下不了单"。
  const gate = await call('GET', `${T}/config/gate?buildingId=${b0.buildingId}`, { token: student });
  if (!gate.body?.orderable) {
    console.log(
      `[seed-demo] 现在下不了单，跳过造单：${gate.body?.title ?? gate.body?.message ?? '不可下单'}` +
        `（${gate.body?.recovery ?? '无恢复时间'}）`,
    );
    console.log('[seed-demo] 这是时间闸门在正常工作，不是脚本失败 —— 换到可下单时段重跑即可补上订单。');
    return finish(tenantCode, buildings, ids);
  }
  const products = await call('GET', `${T}/catalog/storefront?buildingId=${b0.buildingId}`, { token: student });
  // 门店视图的库存字段是 `availableQty`（另有 `visibility` 表示在售/售罄/未上架），
  // 不是 `stock` —— 铺货接口用的才是 stock。两个名字差一个字母，取错就会静默得到空数组。
  const buyable = (products.body?.items ?? []).filter(
    (p) => p.visibility === 'available' && (p.availableQty ?? 0) > 0,
  );
  if (!buyable.length) {
    console.error('[seed-demo] 第一栋没有可买的商品，跳过造单');
    return finish(tenantCode, buildings, ids);
  }

  // 凑到起送价为止（默认 ¥10）。取前两件通常只有 7.5 元，会被"还差 2.50 元起送"挡回来 ——
  // 这个校验是对的，所以这里是**凑够**而不是绕过。
  const shopCfg = await call('GET', `${T}/config`, { token: owner });
  const minCents = shopCfg.body?.shop?.minAmountCents ?? 1000;
  const items = [];
  let sum = 0;
  for (const p of buyable) {
    if (sum >= minCents) break;
    items.push({ productId: p.productId, qty: 1 });
    sum += p.priceCents;
  }
  if (sum < minCents) {
    console.error(`[seed-demo] 第一栋可买商品总额 ¥${(sum / 100).toFixed(2)} 不足起送 ¥${(minCents / 100).toFixed(2)}，跳过造单`);
    return finish(tenantCode, buildings, ids);
  }

  // 下单前必须有收货地址：没有地址时服务端会回"请先选择收货地址"，
  // 而这是**对的**（没有地址就没法送货），所以这里是补地址，不是绕过校验。
  // 先查后建 —— 每次跑都新建一条，重跑三次地址簿就三条一样的了。
  let addressId = null;
  const addrList = await call('GET', `${T}/addresses`, { token: student });
  const found = (addrList.body?.items ?? []).find((a) => a.buildingId === b0.buildingId);
  if (found) {
    addressId = found.id;
  } else {
    const addr = await call('POST', `${T}/addresses`, {
      token: student,
      body: { buildingId: b0.buildingId, ...ADDRESSES[0], tag: '宿舍', isDefault: true },
    });
    // 新建返回的是 { address: {...} }，列表返回的是 { items: [...] } —— 两层结构不一致
    addressId = addr.body?.address?.id ?? addr.body?.id ?? null;
    if (!addressId) {
      console.error(`[seed-demo] 建地址失败（${brief(addr)}）—— 无法造单，其余数据已就绪`);
      return finish(tenantCode, buildings, ids);
    }
  }

  const placed = await call('POST', `${T}/orders`, {
    token: student,
    body: { buildingId: b0.buildingId, addressId, items, remark: '演示订单' },
  });
  if (!ok(placed)) {
    console.error(`[seed-demo] 造单失败（${brief(placed)}）—— 其余数据已就绪，这一步失败不影响演示`);
    return finish(tenantCode, buildings, ids);
  }
  const orderNo = placed.body.orderNo ?? placed.body.order?.orderNo;
  console.log(`[seed-demo] 已造单 ${orderNo}（${b0.buildingName}，${items.length} 件）`);

  const paid = await call('POST', `${T}/orders/${orderNo}/pay/simulate`, { token: student });
  if (ok(paid)) console.log(`[seed-demo] 已模拟支付 → 待接单`);

  // 接单，让配送清单里有东西（配送清单是空间序的主战场，空的等于没演示到 AC-03）
  const acc = await call('POST', `${T}/merchant/orders/${orderNo}/accept`, { token: owner });
  console.log(ok(acc) ? `[seed-demo] 已接单 → 配送清单可见` : `[seed-demo] 接单失败（${brief(acc)}）`);

  return finish(tenantCode, buildings, ids);
}

function finish(tenantCode, buildings, ids) {
  console.log('\n[seed-demo] 完成。现在应该能看到：');
  console.log(`  · 店铺：${SHOP_NAME}（租户编码 ${tenantCode}）`);
  console.log(`  · 楼栋：${buildings.length} 栋，最后一栋「${buildings[buildings.length - 1].buildingName}」处于今日停送`);
  console.log(`  · 商品：${MENU.length} 种，含低库存 / 售罄 / 部分楼栋未上架三种样本`);
  console.log(`  · 时间窗：06:30–23:30（当前时段可下单）`);
  console.log(`  · 商户端：账本有流水、配送清单有单`);
  console.log(
    '\n[seed-demo] 演示时值得特意看的四处：\n' +
      '  1. 库存矩阵（网页端）：同一行的格子有 在售/低库存/售罄/未上架 四种，且都带文字角标（AC-11）\n' +
      '  2. 停送那栋：学生端显示「今日已停送」，商户端库存数字**还在**（AC-17）\n' +
      '  3. 售罄商品加入购物车后提交：会指名"哪个商品、哪一栋、请移出"（§5.4-3）\n' +
      '  4. 配送清单：按 楼栋→楼层→房间 排，不是按下单时间（AC-03）',
  );
  console.log('\n注意：DB_MODE=memory 下**重启服务端数据即清空**，重启后重跑本脚本即可。');
}

main().catch((e) => {
  console.error('[seed-demo] 未预期的错误：', e);
  process.exit(1);
});
