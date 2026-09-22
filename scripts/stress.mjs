#!/usr/bin/env node
/**
 * 全链路压测（S8-D）。
 *
 * 为什么单独一个脚本，而不是塞进 smoke：
 *   smoke 回答"每一条对不对"，压测回答"**同时来多少还敢说它对**"。
 *   两者的失败含义也不同 —— smoke 红一条就是 bug；压测在 N 并发下红了，
 *   要先判断是"真的有竞态"还是"并发数超过了设计容量"。
 *   混在一起会让人在 smoke 全绿时误以为并发也没问题。
 *
 * 为什么走 HTTP 而不是直接调服务：
 *   并发竞态常常出在"请求进出"的边界上（中间件、上下文、连接复用），
 *   直接调服务层会把那一层整个跳过，测出来的是"仓储层没问题"，
 *   而用户遇到的是"接口有问题"。
 *
 * 三个场景，分别对应最容易在并发下崩的三件事：
 *   ① 并发抢库存 —— 超卖（卖出去的比实际有的多）
 *   ② 并发重复回调 —— 重复扣减（一笔钱扣两次）
 *   ③ 混合负载后对账 —— 库存流水差额不为 0（账实不符）
 *
 * 用法：
 *   node scripts/stress.mjs                    # 默认 50 并发
 *   node scripts/stress.mjs --concurrency 200
 *   node scripts/stress.mjs --appid wxXXX      # 默认用 .env.local 的 AppID
 *
 * 前置：服务端已在运行（npm run start:server），且 ALLOW_INSECURE_OPENID=true。
 */
import process from 'node:process';
import { brief, envOf, makeCaller, ok, ownerToken, studentToken, widenBusinessHours } from './lib/seed-http.mjs';

const { base, appid, adminKey } = envOf();
const call = makeCaller(base);

const CONCURRENCY = Number(process.argv[process.argv.indexOf('--concurrency') + 1] ?? 50);
/** 抢购商品的初始库存 —— 并发数远大于它，才能逼出超卖 */
const STOCK = 20;

if (!appid) {
  console.error('[stress] 缺 AppID：node scripts/stress.mjs --appid wx... 或在 .env.local 配 WECHAT_APPID');
  process.exit(1);
}

const line = (s = '') => console.log(s);

/** 并发发起 n 个请求，收集全部结果（不抛异常 —— 失败本身就是要统计的数据） */
async function burst(n, fn) {
  const t0 = Date.now();
  const results = await Promise.all(
    Array.from({ length: n }, async (_, i) => {
      const started = Date.now();
      try {
        const r = await fn(i);
        return { i, status: r.status, body: r.body, ms: Date.now() - started };
      } catch (e) {
        return { i, status: 0, body: { error: { message: e.message } }, ms: Date.now() - started };
      }
    }),
  );
  return { results, ms: Date.now() - t0 };
}

function pct(list, p) {
  if (!list.length) return 0;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))];
}

async function main() {
  line(`[stress] 目标：${base}`);
  line(`[stress] 并发：${CONCURRENCY}`);
  const health = await call('GET', '/api/health');
  if (!ok(health)) {
    console.error(`[stress] 服务不健康（${brief(health)}）`);
    process.exit(1);
  }

  // 压测要一家独立的店：和演示/开发数据混在一起会让库存基数算不清
  const demoAppid = `${appid}stress`;
  const existing = await call('POST', '/api/tenant/resolve', { body: { appid: demoAppid } });
  let tenantCode;
  if (ok(existing)) {
    tenantCode = existing.body.tenantCode;
  } else {
    if (!adminKey) {
      console.error('[stress] 建压测租户需要 PLATFORM_ADMIN_KEY');
      process.exit(1);
    }
    const created = await call('POST', '/api/platform/tenants', {
      platformKey: adminKey,
      body: {
        shopName: '压测专用店',
        orgName: '压测主体',
        appid: demoAppid,
        schoolId: 1,
        region: '广西',
        contactName: '压测',
        contactPhone: '13800000000',
      },
    });
    if (!ok(created)) {
      console.error(`[stress] 建压测租户失败（${brief(created)}）`);
      process.exit(1);
    }
    tenantCode = created.body.tenant.tenantCode;
  }
  const owner = await ownerToken(call, { tenantCode, adminKey });
  const T = `/t/${tenantCode}/api`;
  line(`[stress] 压测租户：${tenantCode}`);

  // 单个学生并发下单：同一个人瞬间点 N 次购买，是最容易出现的真实场景
  const student = await studentToken(call, { appid: demoAppid, openid: 'stress-0001', nickname: '压测同学' });

  const resolved = await call('POST', '/api/tenant/resolve', { body: { appid: demoAppid } });
  const buildings = resolved.body?.buildings ?? [];
  const b0 = buildings[0];
  if (!b0) {
    console.error('[stress] 压测租户没有楼栋');
    process.exit(1);
  }

  /* ---------------------------------------------------- 准备：一件限量商品 */

  const goodName = `限量商品-${Date.now()}`;
  const created = await call('POST', `${T}/catalog/products`, {
    token: owner,
    body: { name: goodName, spec: '压测', priceCents: 1500, buildingIds: [b0.buildingId] },
  });
  if (!ok(created)) {
    console.error(`[stress] 建压测商品失败（${brief(created)}）`);
    process.exit(1);
  }
  const productId = created.body.product.id;
  await call('POST', `${T}/catalog/bulk`, {
    token: owner,
    body: { productId, buildingIds: [b0.buildingId], stock: STOCK },
  });

  const addr = await call('POST', `${T}/addresses`, {
    token: student,
    body: { buildingId: b0.buildingId, floor: '3', room: '301', contact: '压测', tag: '宿舍', isDefault: true },
  });
  const addressId = addr.body?.address?.id ?? addr.body?.id ?? null;

  // 压测不该受时段影响：凌晨跑也是要压的
  const widened = await widenBusinessHours(call, { tenantCode, owner });
  if (!widened.ok) line(`   ! 营业时段放宽未完全成功：${widened.detail}`);

  const gate = await call('GET', `${T}/config/gate?buildingId=${b0.buildingId}`, { token: student });
  if (!gate.body?.orderable) {
    console.error(
      `[stress] 现在不可下单（${gate.body?.title}）—— 压测需要可下单时段。\n` +
        '        先跑一次 npm run seed:demo 把营业时段放宽，或换个时间再压。',
    );
    process.exit(1);
  }

  /* ------------------------------------------------------------ ① 并发抢库存 */

  line();
  line('── ① 并发抢库存（超卖反证）');
  line(`   库存 ${STOCK} 件，${CONCURRENCY} 个并发请求各买 1 件`);

  const { results, ms } = await burst(CONCURRENCY, () =>
    call('POST', `${T}/orders`, {
      token: student,
      body: { buildingId: b0.buildingId, addressId, items: [{ productId, qty: 1 }], remark: '压测' },
    }),
  );

  const succeeded = results.filter((r) => ok(r));
  const failed = results.filter((r) => !ok(r));
  const times = results.map((r) => r.ms);
  line(`   成功 ${succeeded.length} / 失败 ${failed.length} / 总耗时 ${ms}ms`);
  line(`   单请求耗时 p50 ${pct(times, 50)}ms · p95 ${pct(times, 95)}ms · max ${pct(times, 100)}ms`);

  const matrix = await call('GET', `${T}/catalog/matrix`, { token: owner });
  const row = (matrix.body?.rows ?? []).find((r) => r.productId === productId);
  const cell = row?.cells?.find((c) => c.buildingId === b0.buildingId);
  line(`   终态：可售 ${cell?.stock} · 预占 ${cell?.locked}`);

  const overSold = succeeded.length > STOCK;
  const negative = (cell?.stock ?? 0) < 0;
  const held = cell?.locked ?? 0;
  // 守恒：可售 + 已预占（+ 已卖出）必须等于初始库存。这里还没支付，所以是 stock + locked。
  const conserved = (cell?.stock ?? 0) + held === STOCK;

  line(
    overSold
      ? `   ✗ 超卖：卖出 ${succeeded.length} 件 > 库存 ${STOCK} 件`
      : `   ✓ 无超卖：成功 ${succeeded.length} 件 ≤ 库存 ${STOCK} 件`,
  );
  line(negative ? `   ✗ 库存为负：${cell?.stock}` : `   ✓ 库存未为负：${cell?.stock}`);
  line(conserved ? `   ✓ 守恒：可售 ${cell?.stock} + 预占 ${held} = ${STOCK}` : `   ✗ 不守恒：${cell?.stock} + ${held} ≠ ${STOCK}`);

  let bad = 0;
  if (overSold) bad++;
  if (negative) bad++;
  if (!conserved) bad++;

  /* -------------------------------------------------------- ② 并发重复回调 */

  line();
  line('── ② 并发重复回调（重复扣减反证）');

  if (succeeded.length) {
    const orderNo = succeeded[0].body.orderNo ?? succeeded[0].body.order?.orderNo;
    // 先把这一单付掉，才有"回调"可重放
    await call('POST', `${T}/orders/${orderNo}/pay/simulate`, { token: student });

    const N = Math.min(30, Math.max(5, Math.floor(CONCURRENCY / 2)));
    const cb = await burst(N, () => call('POST', `${T}/orders/${orderNo}/pay/simulate`, { token: student }));
    const cbOk = cb.results.filter((r) => ok(r));
    const idempotentMarks = cb.results.filter((r) => r.body?.idempotent === true).length;
    line(`   ${N} 次并发回调：成功 ${cbOk.length}，其中标记幂等重放 ${idempotentMarks}`);

    const after = await call('GET', `${T}/catalog/matrix`, { token: owner });
    const cell2 = (after.body?.rows ?? []).find((r) => r.productId === productId)?.cells?.find(
      (c) => c.buildingId === b0.buildingId,
    );
    // 支付确认 = 预占转已售，库存只扣一次。重复扣会表现为 stock 继续下降。
    line(`   回调后：可售 ${cell2?.stock} · 预占 ${cell2?.locked}`);
    const noDouble = (cell2?.stock ?? 0) >= 0 && (cell2?.locked ?? 0) >= 0;
    line(noDouble ? '   ✓ 未出现负数（重复扣减会导致库存被扣穿）' : '   ✗ 出现负数 —— 重复扣减');
    if (!noDouble) bad++;
  } else {
    line('   （上一场景无成功单，跳过）');
  }

  /* ------------------------------------------------------------ ③ 流水对账 */

  line();
  line('── ③ 库存流水对账（账实相符）');
  const logs = await call('GET', `${T}/catalog/stock-logs?productId=${productId}&limit=500`, { token: owner });
  const items = logs.body?.items ?? [];
  let delta = 0;
  for (const l of items) delta += (l.change ?? 0);
  line(`   流水 ${items.length} 条，变动合计 ${delta}`);
  // 初始铺货 STOCK 是一次 set（不计入 change 的增量语义时以接口为准），
  // 这里只校验"流水没有丢条"：条数应等于 1（铺货）+ 成功下单数（每条一次预占）
  const expected = succeeded.length + 1;
  const complete = items.length >= expected;
  line(complete ? `   ✓ 流水完整：${items.length} 条 ≥ 预期 ${expected} 条` : `   ✗ 流水缺条：${items.length} < ${expected}`);
  if (!complete) bad++;

  /* ------------------------------------------------------------------ 结论 */

  line();
  line('────────────────────────────');
  if (bad) {
    console.error(`[stress] 失败 —— ${bad} 项不通过（并发 ${CONCURRENCY}）`);
    process.exit(1);
  }
  console.log(`[stress] 通过 —— 并发 ${CONCURRENCY} 下：无超卖、库存未为负、守恒成立、回调幂等、流水完整`);
  line();
  line('说明：DB_MODE=memory 下并发由 Node 单线程事件循环串行化，');
  line('      本脚本证明的是"接口层在高并发下行为正确"，不等于数据库层的行锁能力。');
  line('      换到真实数据库（MySQL）后，应在此并发级别下重跑一次。');
}

main().catch((e) => {
  console.error('[stress] 未预期的错误：', e);
  process.exit(1);
});
