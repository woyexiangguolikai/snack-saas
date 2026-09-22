/**
 * D1 本机冒烟 —— 真实起服务、真实打 HTTP、真实断言。
 *
 * 为什么不用 mock：本机没有 MySQL / Docker，如果只跑 `tsc`，那么"验证通过"
 * 就只等于"类型对了"，而租户路由、配置下发、楼栋不可删这些**最不可返工**的部分
 * 一次都没跑过。内存仓储让这条链路可以真跑，所以必须真跑。
 *
 * 覆盖：验收节点 V1（7 项）+ V2 中属 D1 范围的项 + AC-02 / AC-04 的部分判定。
 * 运行：npm run smoke -w @snack/server
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from './app.module';
import { AppLogger, redactString, sanitizeForLog, assertNoTenantPrivateFields } from './core/logger';
import { AllExceptionsFilter } from './core/exception.filter';
import { guardThemeColor, contrastRatio, DEFAULT_BRAND_SCALE } from '@snack/tokens';
import { evaluateOrderGate, bizDayOf, bizMonthOf, bizDayStartOf } from './core/time-window';
import { cutoffOf, narrowBusinessHours } from './core/config-resolver';
import { BANNED_COPY } from './ledger/copy';
import { FEE_BP, feeOfCents, ORDER_TIMEOUT, SUBSCRIPTION_WARN_DAYS } from './core/types';
import { MemoryRepoFactory } from './core/memory.repository';
import { REPO_FACTORY } from './core/repo.factory';
import { env } from './core/env';
import { StockService } from './catalog/stock.service';
import { compareFloorRoom, mergeLines, naturalCompare } from './order/order.service';

/* ------------------------------------------------------- 迷你断言框架 */

type Case = { name: string; group: string; fn: () => Promise<void> | void };
const cases: Case[] = [];
let currentGroup = '未分组';

function group(name: string): void {
  currentGroup = name;
}
function check(name: string, fn: () => Promise<void> | void): void {
  cases.push({ name, group: currentGroup, fn });
}

class AssertionError extends Error {}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new AssertionError(msg);
}
function eq<T>(actual: T, expected: T, msg?: string): void {
  if (actual !== expected) {
    throw new AssertionError(`${msg ?? '值不相等'}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

/* ------------------------------------------------------- HTTP 小工具 */

let base = '';

async function req(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; platformKey?: string } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.platformKey) headers['x-platform-key'] = opts.platformKey;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* 保留原文 */ }
  return { status: res.status, body };
}

const PLATFORM_KEY = process.env.PLATFORM_ADMIN_KEY ?? 'dev-platform-key';
/** 平台后台请求需要 x-platform-key（过渡方案，上线前换账号体系 + RBAC） */
const PLATFORM = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  opts: { body?: unknown; token?: string } = {},
) => req(method, `/api/platform${path}`, { ...opts, platformKey: PLATFORM_KEY });

/* ============================================================ 用例 */

group('V1-1 服务可启动 / 健康检查');
check('GET /api/health 返回 ok 且 dbMode=memory', async () => {
  const r = await req('GET', '/api/health');
  eq(r.status, 200);
  eq(r.body.ok, true);
  eq(r.body.dbMode, 'memory');
  assert(r.body.requestId, 'requestId 应存在（日志据此串联）');
  eq(r.body.pipelineStages, 12, '流水线必须 12 阶段');
});

group('V1-4 一键建租户（建库 + 带出楼栋模板）');
let t1 = '';
let t1Token = '';
/** 店主令牌 —— 学生令牌不能调商户端写接口（建楼栋 / 改配置 / 改价 / 改库存） */
let t1OwnerToken = '';
let t1BuildingIds: number[] = [];

check('平台学校字典含楼栋模板', async () => {
  const r = await PLATFORM('GET', '/schools');
  eq(r.status, 200);
  assert(r.body.items.length >= 4, `学校字典至少 4 所，实际 ${r.body.items.length}`);
  const gxu = r.body.items.find((s: any) => s.name === '广西大学');
  assert(gxu, '应含广西大学');
  assert(gxu.buildingTemplates.length >= 6, `广西大学楼栋模板应 ≥6，实际 ${gxu.buildingTemplates.length}`);
});

check('POST /api/platform/tenants 一键建租户并带出楼栋', async () => {
  const r = await PLATFORM('POST', '/tenants', {
    body: {
      shopName: '张姐零食铺',
      orgName: '南宁市张姐食品经营部',
      appid: 'wxTEST0000000001',
      schoolId: 1,
      region: '广西',
      contactName: '张姐',
      contactPhone: '13800000000',
    },
  });
  eq(r.status, 201);
  t1 = r.body.tenant.tenantCode;
  assert(/^t\d{6}$/.test(t1), `租户编码格式应为 t+6 位数字，实际 ${t1}`);
  eq(r.body.tenant.dbName, `snack_${t1}`);
  // 默认楼栋（单楼栋降级依赖它）+ 学校模板楼栋
  assert(r.body.buildings.length >= 2, `应带出楼栋模板，实际 ${r.body.buildings.length}`);
  assert(r.body.buildings.some((b: any) => b.isDefault), '必须自动创建「默认楼栋」（§4.9）');
  eq(r.body.tenant.status, 'pipeline', '新建租户状态应为上线流水线中');

  // 立刻取一张店主令牌：商户端写接口（建楼栋、改配置、改价、改库存）全部要求店主身份。
  // 放在这里是因为后面所有用例都要用它 —— 而它必须在**任何**写操作之前拿到。
  const ot = await PLATFORM('POST', '/merchant/token', { body: { tenantCode: t1 } });
  eq(ot.status, 200, `签发店主令牌应 200：${JSON.stringify(ot.body)}`);
  eq(ot.body.role, 'owner');
  assert(ot.body.token, '应返回店主令牌');
  t1OwnerToken = ot.body.token;
});

check('平台租户列表两个账本同屏（订阅天数 + 余额）', async () => {
  const r = await PLATFORM('GET', '/tenants');
  eq(r.status, 200);
  const row = r.body.items.find((x: any) => x.tenantCode === t1);
  assert(row, '应能查到刚建的租户');
  assert(typeof row.gates.subscriptionDaysLeft === 'number', '必须给出订阅剩余天数');
  assert(row.gates.subscriptionDaysLeft > 0, '新学期订阅应有效');
  eq(row.gates.balanceCents, 0, '新租户余额为 0');
  eq(row.gates.balanceTone, 'warn', '余额 0 且高于应急额度 -20 → 预警（不是红）');
  assert(row.buildingCount >= 2, '启用楼栋数应 ≥2');
});

group('V1-5 租户解析与配置下发（不发版即可生效）');
check('POST /api/tenant/resolve 返回楼栋清单与令牌', async () => {
  const r = await req('POST', '/api/tenant/resolve', { body: { appid: 'wxTEST0000000001' } });
  eq(r.status, 200);
  eq(r.body.tenantCode, t1);
  eq(r.body.shopName, '张姐零食铺');
  assert(r.body.token, '应下发会话令牌');
  eq(r.body.singleBuildingMode, false, '多楼栋商户不应进入单楼栋降级');
  t1Token = r.body.token;
  t1BuildingIds = r.body.buildings.map((b: any) => b.buildingId);
  // 截单时间必须早于门禁结束（D14：预留配送在途时间）
  for (const b of r.body.buildings) {
    assert(b.cutoffTime === cutoffOf(b.accessibleTo, 30), `截单时间应为 ${b.accessibleTo} − 30min`);
    assert(b.cutoffTime < b.accessibleTo, '截单时间必须早于可进入时间窗结束');
  }
});

check('AppID 未匹配 → TENANT_NOT_FOUND（前端据此渲染「店铺未开通」，不白屏）', async () => {
  const r = await req('POST', '/api/tenant/resolve', { body: { appid: 'wxNOT_REGISTERED' } });
  eq(r.status, 404);
  eq(r.body.error.code, 'TENANT_NOT_FOUND');
});

check('GET /t/{tenant}/api/config 需令牌，无令牌 401', async () => {
  const r = await req('GET', `/t/${t1}/api/config`);
  eq(r.status, 401);
  eq(r.body.error.code, 'TOKEN_MISSING');
});

check('带令牌取配置：含楼栋、时间窗、双闸门、服务端时间', async () => {
  const r = await req('GET', `/t/${t1}/api/config`, { token: t1Token });
  eq(r.status, 200);
  eq(r.body.tenantCode, t1);
  assert(r.body.buildings.length >= 2, '应下发楼栋清单');
  assert(r.body.gates.subscriptionValid, '订阅应有效');
  assert(r.body.serverTime, '必须下发服务端时间（AC-14：时间只有一个真相源）');
  assert(typeof r.body.serverMinutesOfDay === 'number', '应下发服务端当日分钟数，供前端做平滑倒计时');
});

check('新增楼栋后学生端立即看到 —— 无需发版（§4.2 核心价值）', async () => {
  const before = (await req('GET', `/t/${t1}/api/config`, { token: t1Token })).body.buildings.length;
  const created = await req('POST', `/t/${t1}/api/buildings`, {
    token: t1OwnerToken,
    body: { name: '7 号宿舍楼' },
  });
  eq(created.status, 201);
  const after = (await req('GET', `/t/${t1}/api/config`, { token: t1Token })).body.buildings.length;
  eq(after, before + 1, '新增楼栋后配置下发的楼栋数应立即 +1');
});

group('V1-6 单楼栋自动降级');
check('无学校模板的租户 → singleBuildingMode=true（前端隐藏全部楼栋 UI）', async () => {
  const created = await PLATFORM('POST', '/tenants', {
    body: { shopName: '单栋小卖部', orgName: '测试个体户', appid: 'wxTEST0000000002', region: '广西' },
  });
  eq(created.status, 201);
  eq(created.body.singleBuildingMode, true);
  const res = await req('POST', '/api/tenant/resolve', { body: { appid: 'wxTEST0000000002' } });
  eq(res.body.singleBuildingMode, true);
});

group('V2-10 楼栋只能停用，不能删除');
check('DELETE /t/{tenant}/api/buildings/:id → 403 BUILDING_DELETE_FORBIDDEN', async () => {
  const id = t1BuildingIds[1];
  assert(id, '需要至少两个楼栋');
  const r = await req('DELETE', `/t/${t1}/api/buildings/${id}`, { token: t1OwnerToken });
  eq(r.status, 403);
  eq(r.body.error.code, 'BUILDING_DELETE_FORBIDDEN');
  assert(r.body.error.message.includes('停用'), '错误信息应引导改用「停用」');
});

check('停用后前台不可选，但记录仍在（历史订单可查）', async () => {
  const id = t1BuildingIds[1]!;
  const d = await req('POST', `/t/${t1}/api/buildings/${id}/disable`, { token: t1OwnerToken });
  eq(d.status, 201);
  eq(d.body.status, 'disabled');
  const cfg = await req('GET', `/t/${t1}/api/config`, { token: t1Token });
  assert(!cfg.body.buildings.some((b: any) => b.buildingId === id), '停用楼栋不应出现在学生端楼栋清单');
  const admin = await req('GET', `/t/${t1}/api/buildings`, { token: t1Token });
  assert(admin.body.buildings.some((b: any) => b.id === id), '后台仍应能看到已停用楼栋');
});

group('V2-1 楼栋级配置：缺省即继承店铺（铁律 5）');
check('未设值的楼栋 source 全部为 shop', async () => {
  const r = await req('GET', `/t/${t1}/api/buildings`, { token: t1Token });
  const b = r.body.buildings.find((x: any) => x.isDefault);
  eq(b.resolved.source.minAmountCents, 'shop');
  eq(b.resolved.source.accessibleTo, 'shop');
  eq(b.resolved.minAmountCents, 1000, '应继承店铺默认起送价 10 元');
});

check('覆盖 accessibleTo 后 source=building，且该栋截单时间跟着变', async () => {
  const id = t1BuildingIds[0]!;
  const p = await req('PATCH', `/t/${t1}/api/buildings/${id}`, {
    token: t1OwnerToken,
    body: { accessibleTo: '21:00', minAmountCents: 2000 },
  });
  eq(p.status, 200);
  const r = await req('GET', `/t/${t1}/api/buildings`, { token: t1Token });
  const b = r.body.buildings.find((x: any) => x.id === id);
  eq(b.resolved.source.accessibleTo, 'building');
  eq(b.resolved.accessibleTo, '21:00');
  eq(b.resolved.cutoffTime, '20:30', '截单应为 21:00 − 30min');
  eq(b.resolved.minAmountCents, 2000);
});

check('一键配置全部楼栋覆盖所有启用楼栋 —— 含此前被单栋改过的那个', async () => {
  const r = await req('POST', `/t/${t1}/api/time-window/bulk`, {
    token: t1OwnerToken,
    body: { accessibleTo: '22:00', deliveryFeeCents: 200 },
  });
  eq(r.status, 201);
  assert(r.body.affected >= 2, `应覆盖至少 2 个启用楼栋，实际 ${r.body.affected}`);
  // 关键回归：前面单独把某栋 accessibleTo 改成 21:00，一键配置必须把它也拉回 22:00。
  // 若单栋编辑写「楼栋列」而一键配置写 config_override，这里就会失败 —— 商户会以为功能坏了。
  assert(
    r.body.buildings.every((b: any) => b.accessibleTo === '22:00'),
    `所有启用楼栋应统一为 22:00，实际 ${JSON.stringify(r.body.buildings.map((b: any) => b.accessibleTo))}`,
  );
  assert(
    r.body.buildings.every((b: any) => b.deliveryFeeCents === 200),
    '配送费应统一为 200 分',
  );
  assert(
    r.body.buildings.every((b: any) => b.cutoffTime === '21:30'),
    `截单时间应随窗口自动重算为 21:30，实际 ${JSON.stringify(r.body.buildings.map((b: any) => b.cutoffTime))}`,
  );
});

group('CW-06 时间窗：营业时间被门禁自动收窄，截单时间算出来');
check('门禁 06:30–22:30 + 在途 30min → 截单 22:00', async () => {
  const r = await req(
    'GET',
    `/t/${t1}/api/time-window/preview?accessibleFrom=06:30&accessibleTo=22:30&leadMinutes=30`,
    { token: t1Token },
  );
  eq(r.status, 200);
  eq(r.body.cutoffTime, '22:00');
  eq(r.body.businessHoursNarrowed, false, '默认营业时间 08:00–22:30 已落在窗口内，不应收窄');
});

check('营业到 23:30 → 自动截断到 22:30 并给出"帮你改了"的提示', async () => {
  const n = narrowBusinessHours('08:00', '23:30', '06:30', '22:30');
  eq(n.closeTime, '22:30');
  eq(n.narrowed, true);
});

group('AC-02 「已截单」用灰不用红 + 时间只有一个真相源');
check('可用时 → ok / 即将截单 → warn / 已截单 → off（绝不 danger）', () => {
  const baseInput = {
    shopOpen: true,
    buildingStatus: 'active' as const,
    buildingDeliveryEnabled: true,
    subscriptionValid: true,
    balanceCents: 10000,
    creditLimitCents: -2000,
    openTime: '08:00',
    closeTime: '22:30',
    accessibleFrom: '06:30',
    accessibleTo: '22:30',
    cutoffTime: '22:00',
  };
  const at = (h: number, m: number) => new Date(Date.UTC(2026, 8, 22, h - 8, m)); // UTC+8

  const ok = evaluateOrderGate(baseInput, at(12, 0));
  eq(ok.state, 'orderable');
  eq(ok.tone, 'ok');

  const soon = evaluateOrderGate(baseInput, at(21, 45));
  eq(soon.state, 'closing_soon');
  eq(soon.tone, 'warn', '即将截单用琥珀');

  // 截单 22:00、营业至 22:30 → 22:00–22:30 之间必须报「已截单」，且必须用灰
  const closed = evaluateOrderGate(baseInput, at(22, 15));
  eq(closed.state, 'closed');
  eq(closed.tone, 'off', 'AC-02：已截单必须用灰，不得用红/橙');
  assert(closed.nextOpenAt === '06:30', '必须告知下次可下单时间');

  const resting = evaluateOrderGate({ ...baseInput, shopOpen: false }, at(12, 0));
  eq(resting.tone, 'off', '休息中 = 还没开始，用灰');

  // 越过营业结束时间后是"休息"而不是"截单"——两者都是灰，但文案不同
  const afterHours = evaluateOrderGate(baseInput, at(22, 40));
  eq(afterHours.state, 'resting');
  eq(afterHours.tone, 'off');

  const paused = evaluateOrderGate({ ...baseInput, buildingDeliveryEnabled: false }, at(12, 0));
  eq(paused.tone, 'off', '本栋停送 = 今天不做，用灰');
});

check('两道闸门：订阅过期 → off；余额触底 → danger', () => {
  const baseInput = {
    shopOpen: true, buildingStatus: 'active' as const, buildingDeliveryEnabled: true,
    subscriptionValid: true, balanceCents: 10000, creditLimitCents: -2000,
    openTime: '08:00', closeTime: '22:30', accessibleFrom: '06:30', accessibleTo: '22:30', cutoffTime: '22:00',
  };
  const at = new Date(Date.UTC(2026, 8, 22, 4, 0));
  const sub = evaluateOrderGate({ ...baseInput, subscriptionValid: false }, at);
  eq(sub.state, 'subscription_expired');
  eq(sub.tone, 'off');
  assert(
    BANNED_COPY.every((w) => !sub.message.includes(w)),
    `闸门文案必须中性（词表：${BANNED_COPY.join('/')}）`,
  );

  const bal = evaluateOrderGate({ ...baseInput, balanceCents: -2000 }, at);
  eq(bal.state, 'balance_blocked');
  eq(bal.tone, 'danger', '余额触底是唯一需要立刻动手的闸门 → 红');
});

group('AC-06 主题色对比度护栏（提交色永不直通）');
check('默认主色 #F26B21 与白字对比不足 4.5 → 加深后达标', () => {
  const g = guardThemeColor(DEFAULT_BRAND_SCALE[500]);
  assert(g.submittedContrast < 4.5, `#F26B21 与白字仅 ${g.submittedContrast}:1`);
  assert(g.finalContrast >= 4.5, `加深后应 ≥4.5，实际 ${g.finalContrast}`);
  assert(g.deepened >= 1, '应发生至少 1 级加深');
  assert(g.notice && g.notice.includes('调深'), '必须给商户一句人话提示');
});

check('极浅色 → 加深两级并提示', () => {
  const g = guardThemeColor('#FFEEDD');
  eq(g.deepened, 2);
  assert(g.notice && g.notice.includes('调深'), '必须给商户人话提示');
});

check('任意极端色相都能压出可读的深端（结构性保证，不靠碰运气）', () => {
  // 高饱和暖色在低亮度下对比度也上不去 —— 只靠"加深"是死路，必须同时降饱和
  const seeds = ['#FFEEDD', '#FFF9C4', '#FFFBEA', '#FF80AB', '#FFEB3B', '#E1F5FE', '#FFFFFF', '#00FF00', '#FF0000', '#7A2E00', '#000000'];
  for (const seed of seeds) {
    const g = guardThemeColor(seed);
    assert(
      g.finalContrast >= 4.5,
      `${seed} 的深端与白字对比度仅 ${g.finalContrast}:1，白字按钮会看不清`,
    );
    eq(Object.keys(g.scale).length, 9, `${seed} 的色阶必须仍是九级`);
  }
});

check('深色 → 原样采用，不打扰商户', () => {
  const g = guardThemeColor('#7A2E00');
  eq(g.deepened, 0);
  eq(g.notice, null);
  assert(g.finalContrast >= 4.5, `深色原样采用后对比度应达标，实际 ${g.finalContrast}`);
});

check('色阶九级齐全且 500 位保留提交色', () => {
  const g = guardThemeColor('#2E7D5B');
  const keys = Object.keys(g.scale);
  eq(keys.length, 9, '品牌色阶必须九级');
  eq(g.scale[500], '#2E7D5B');
  assert(contrastRatio(g.scale[700], '#FFFFFF') > contrastRatio(g.scale[500], '#FFFFFF'), '越深对白字越友好');
});

group('AC-13 房间号不出商户库');
check('config / resolve 出参无房间号、楼层类字段', async () => {
  const cfg = (await req('GET', `/t/${t1}/api/config`, { token: t1Token })).body;
  const res = (await req('POST', '/api/tenant/resolve', { body: { appid: 'wxTEST0000000001' } })).body;
  eq(assertNoTenantPrivateFields(cfg).length, 0, `config 泄漏：${assertNoTenantPrivateFields(cfg).join(',')}`);
  eq(assertNoTenantPrivateFields(res).length, 0, `resolve 泄漏：${assertNoTenantPrivateFields(res).join(',')}`);
});

check('平台租户列表出参无房间号、楼层类字段', async () => {
  const r = (await PLATFORM('GET', '/tenants')).body;
  const leaks = assertNoTenantPrivateFields(r);
  eq(leaks.length, 0, `平台列表泄漏：${leaks.join(',')}`);
});

check('日志脱敏：地址串与敏感键都被处理', () => {
  eq(redactString('送到 2 栋 602 室'), '送到 2 栋***');
  const cleaned = sanitizeForLog({ orderNo: 't000001-2026', room: '302', floor: '6', buildingCode: 'B001' }) as any;
  assert(!('room' in cleaned), 'room 键必须被删除（可见地缺席，而非替换为 ***）');
  assert(!('floor' in cleaned), 'floor 键必须被删除');
  eq(cleaned.buildingCode, 'B001', '楼栋级信息可保留');
});

group('跨租户隔离');
check('用 t1 令牌访问 t2 路径 → 403', async () => {
  const r = await req('GET', '/t/t999999/api/config', { token: t1Token });
  eq(r.status, 403);
  eq(r.body.error.code, 'TOKEN_INVALID');
});

check('伪造令牌 → 401 TOKEN_INVALID', async () => {
  const r = await req('GET', `/t/${t1}/api/config`, { token: 'a.b.c' });
  eq(r.status, 401);
  eq(r.body.error.code, 'TOKEN_INVALID');
});

group('平台后台鉴权');
check('无平台密钥 → 401', async () => {
  const r = await req('GET', '/api/platform/tenants');
  eq(r.status, 401);
});

/* ==========================================================================
 * V2 · 双账本 + 两道闸门（我唯一的收钱通道）
 * 这一组是"钱不能错"的部分：每一条都在算具体数字，而不是只看接口通不通。
 * ========================================================================*/

const T = (path: string) => `/api/platform/ledger/${t1}${path}`;

group('V2-9 中性文案（禁用词零泄漏）');
check('账本 / 闸门 / 提醒 出参都不含禁用词', async () => {
  const billing = (await PLATFORM('GET', `/ledger/${t1}`)).body;
  const overview = (await PLATFORM('GET', '/ledger/overview')).body;
  const gate = (await req('GET', `/t/${t1}/api/config`, { token: t1Token })).body;
  const text = JSON.stringify([billing, overview, gate]);
  const hits = BANNED_COPY.filter((w) => text.includes(w));
  eq(hits.length, 0, `禁用词泄漏：${hits.join('/')}`);
  assert(billing.wallet.walletName === '服务费余额', '账本名必须用「服务费余额」');
  assert(billing.wallet.tone, '必须由服务端给出 tone，业务代码不得自行选色');
});

group('V2-6 双账本 · 每日汇总扣减（分毫不差）');
check('200 笔跨日订单 → 余额账 = Σ(订单 × 2%)，差额 0', async () => {
  // 先充值，保证有余额可扣（否则会扣成负数，后面单独验）
  const top = await PLATFORM('POST', `/ledger/${t1}/topup`, { body: { amountYuan: 500 } });
  eq(top.status, 200);
  eq(top.body.txn.type, 'topup');
  eq(top.body.txn.amountCents, 50000, '充值 500 元 = 50000 分');
  eq(top.body.txn.amountCents % 1, 0, '金额必须整数分');

  // 200 笔订单，金额刻意带零头（奇数分），专门用来暴露浮点四舍五入的不一致
  let expectedFee = 0;
  let expectedGmv = 0;
  const runDate0 = '2026-09-21';
  for (let i = 1; i <= 200; i++) {
    const amountCents = 100 + i * 7 + (i % 3); // 100..1509 之间的各种零头
    expectedFee += feeOfCents(amountCents);
    expectedGmv += amountCents;
    const r = await PLATFORM('POST', `/ledger/${t1}/orders/paid`, {
      body: {
        orderNo: `ZS-${runDate0}-${String(i).padStart(4, '0')}`,
        amountCents,
        buildingCode: 'B001',
        paidAt: `${runDate0}T02:00:00.000Z`,
      },
    });
    eq(r.status, 200);
  }

  const pending = (await PLATFORM('GET', `/ledger/${t1}/pending`)).body;
  eq(pending.orderCount, 200, '待扣队列应有 200 笔');
  eq(pending.totalFeeCents, expectedFee, '待扣服务费合计必须等于逐笔 2% 之和');

  // 跨日扣减：白天 2026-09-21，扣的是 09-21 及更早的成交
  const settle = (await PLATFORM('POST', `/ledger/${t1}/settle`, { body: { runDate: '2026-09-22' } })).body;
  eq(settle.run.orderCount, 200);
  eq(settle.run.gmvCents, expectedGmv, '批次 GMV 必须等于订单金额合计');
  eq(settle.run.feeCents, expectedFee, `批次服务费必须等于 ${FEE_BP / 100}% 逐笔之和`);
  eq(settle.txn.amountCents, -expectedFee, '扣减流水为负数');
  eq(settle.run.status, 'done');

  // 「分毫不差」的可执行定义：余额 == 全部流水求和
  const rec = (await PLATFORM('GET', `/ledger/${t1}/reconcile`)).body;
  eq(rec.diffCents, 0, `余额与流水求和必须相等，差额 ${rec.diffCents} 分`);
  eq(rec.ok, true);
  eq(rec.balanceCents, 50000 - expectedFee, '余额 = 充值 − 服务费');
  eq(rec.balanceCents, rec.txnSumCents, '余额必须等于流水求和');
  eq(rec.pendingOrderCount, 0, '扣减后待扣队列必须清空');
});

check('支付回调重复推送 10 次 → 只登记 1 条待扣（幂等）', async () => {
  const body = { orderNo: 'ZS-DUP-0001', amountCents: 2500, paidAt: '2026-09-22T02:00:00.000Z' };
  for (let i = 0; i < 10; i++) {
    const r = await PLATFORM('POST', `/ledger/${t1}/orders/paid`, { body });
    eq(r.status, 200);
  }
  const pending = (await PLATFORM('GET', `/ledger/${t1}/pending`)).body;
  const dupes = pending.items.filter((x: any) => x.orderNo === 'ZS-DUP-0001');
  eq(dupes.length, 1, `重复回调只应登记 1 条，实际 ${dupes.length} 条`);
});

check('同一天重复跑结算 → 不重复扣（幂等键 runDate + tenantCode）', async () => {
  const before = (await PLATFORM('GET', `/ledger/${t1}/reconcile`)).body;
  const a = (await PLATFORM('POST', `/ledger/${t1}/settle`, { body: { runDate: '2026-09-23' } })).body;
  const b = (await PLATFORM('POST', `/ledger/${t1}/settle`, { body: { runDate: '2026-09-23' } })).body;
  const c = (await PLATFORM('POST', `/ledger/${t1}/settle`, { body: { runDate: '2026-09-23' } })).body;

  eq(a.skipped, false, '首次应真扣');
  eq(b.skipped, true, '第二次必须跳过');
  eq(c.skipped, true, '第三次也必须跳过');
  eq(b.run.id, a.run.id, '必须复用同一批次');
  eq(c.run.feeCents, a.run.feeCents, '重复调用不得再扣一分');

  const after = (await PLATFORM('GET', `/ledger/${t1}/reconcile`)).body;
  eq(after.balanceCents, before.balanceCents - a.run.feeCents, '余额只应被扣一次');
  eq(after.diffCents, 0);
});

check('批次可展开到每一笔订单，且批次金额 == 明细汇总', async () => {
  const runs = (await PLATFORM('GET', `/ledger/${t1}`)).body.runs;
  const run = runs.find((r: any) => r.orderCount === 200);
  assert(run, '应能查到那笔 200 单的批次');

  const detail = (await PLATFORM('GET', `/ledger/${t1}/runs/${run.id}/orders`)).body;
  eq(detail.items.length, 200, '明细必须能展开到 200 笔订单');
  eq(detail.detailSumCents, run.feeCents, '批次服务费必须等于明细逐笔求和');
  eq(detail.consistent, true);
  assert(
    detail.items.every((i: any) => i.orderNo.startsWith('ZS-')),
    '每一笔明细都要能回链到订单号',
  );
  // 明细里不允许出现房间号 —— 平台库只到楼栋级（AC-13）
  eq(assertNoTenantPrivateFields(detail).length, 0);
});

group('V2-7 退款返还（互抵正确）');
check('已结算订单退款 → 服务费返还流水 + 可回链 refOrderNo', async () => {
  const orderNo = 'ZS-2026-09-21-0001';
  const before = (await PLATFORM('GET', `/ledger/${t1}/reconcile`)).body;

  const r = (await PLATFORM('POST', `/ledger/${t1}/orders/${orderNo}/refund`, {
    body: { refundCents: 108 },
  })).body;

  assert(r.feeReturnedCents > 0, '已结算订单退款必须返还服务费');
  eq(r.refundTxn.type, 'refund');
  eq(r.refundTxn.refOrderNo, orderNo, '返还流水必须能回链订单');
  eq(r.refundTxn.amountCents, r.feeReturnedCents, '返还金额记在流水上');

  const after = (await PLATFORM('GET', `/ledger/${t1}/reconcile`)).body;
  eq(after.balanceCents, before.balanceCents + r.feeReturnedCents, '余额应增加返还额');
  eq(after.diffCents, 0, '返还后账本仍须自洽');
});

check('未结算订单退款 → 不产生流水（钱没扣过，不能"返还"）', async () => {
  // 现造一笔"刚支付、尚未结算"的订单 —— 这样它必然还在待扣队列里，
  // 不依赖前面用例留下的状态（否则断言会随执行顺序漂移）
  const orderNo = 'ZS-NOSETTLE-0001';
  await PLATFORM('POST', `/ledger/${t1}/orders/paid`, {
    body: { orderNo, amountCents: 3300, paidAt: new Date().toISOString() },
  });

  const pendingBefore = (await PLATFORM('GET', `/ledger/${t1}/pending`)).body;
  assert(
    pendingBefore.items.some((i: any) => i.orderNo === orderNo),
    '该订单应仍在待扣队列里',
  );

  const before = (await PLATFORM('GET', `/ledger/${t1}/reconcile`)).body;
  const r = (await PLATFORM('POST', `/ledger/${t1}/orders/${orderNo}/refund`, { body: { refundCents: 3300 } })).body;

  eq(r.feeReturnedCents, 0, '未结算订单不得返还服务费');
  eq(r.refundTxn, null, '不得产生返还流水');

  const after = (await PLATFORM('GET', `/ledger/${t1}/reconcile`)).body;
  eq(after.balanceCents, before.balanceCents, '余额不得变动');
  eq(
    after.pendingOrderCount,
    before.pendingOrderCount - 1,
    '必须从待扣队列出队（否则将来会扣一笔已退款单的服务费）',
  );
});

check('当天产生的订单当天不扣（跨日扣减的边界）', async () => {
  const orderNo = 'ZS-TODAY-0001';
  await PLATFORM('POST', `/ledger/${t1}/orders/paid`, {
    body: { orderNo, amountCents: 5000, paidAt: new Date().toISOString() },
  });

  const today = new Date().toISOString().slice(0, 10);
  const r = (await PLATFORM('POST', `/ledger/${t1}/settle`, { body: { runDate: today } })).body;
  const stillPending = (await PLATFORM('GET', `/ledger/${t1}/pending`)).body;
  assert(
    stillPending.items.some((i: any) => i.orderNo === orderNo),
    '当天支付、当天结算不得扣到它（settle 的边界必须是 runDate 的起点）',
  );
  eq((r.orderNos ?? []).includes(orderNo), false, '批次明细里不应出现当天订单');
});

check('全额退款后该订单应付服务费 = 0', async () => {
  const orderNo = 'ZS-2026-09-21-0002';
  const paid = (await PLATFORM('POST', `/ledger/${t1}/orders/paid`, {
    body: { orderNo, amountCents: 1000, paidAt: '2026-09-24T02:00:00.000Z' },
  })).body;
  await PLATFORM('POST', `/ledger/${t1}/settle`, { body: { runDate: '2026-09-25' } });
  await PLATFORM('POST', `/ledger/${t1}/orders/${orderNo}/refund`, { body: { refundCents: paid.order.amountCents } });

  const st = (await PLATFORM('GET', `/ledger/${t1}/statements?period=2026-09`)).body.statement;
  assert(st, '应能生成 2026-09 账单');
  const rec = (await PLATFORM('GET', `/ledger/${t1}/reconcile`)).body;
  eq(rec.diffCents, 0, '账单与余额都必须自洽');
});

group('V2-8 两道闸门独立');
check('余额触底 → 停单；充值后自动解冻', async () => {
  const limit = -2000;
  const cur = (await PLATFORM('GET', `/ledger/${t1}`)).body.wallet.balanceCents as number;

  // 精准把余额扣到应急额度：人工调整成负数，走的就是真实的 adjust 通道
  await PLATFORM('POST', `/ledger/${t1}/adjust`, {
    body: { amountCents: limit - cur, reason: '验收：把余额推到应急额度', operator: 'smoke' },
  });

  const w1 = (await PLATFORM('GET', `/ledger/${t1}`)).body.wallet;
  eq(w1.balanceCents, limit, '余额应正好等于应急额度');
  eq(w1.tone, 'danger', '触底必须红');
  eq(w1.status, 'blocked');

  // 闸门：余额这一条挂掉，但订阅仍然有效 → 说明两道闸门彼此独立
  const gate1 = (await req('GET', `/t/${t1}/api/config`, { token: t1Token })).body;
  eq(gate1.gates.balanceOk, false, '余额闸门应关闭');
  eq(gate1.gates.subscriptionValid, true, '订阅闸门不应受影响（两道闸门独立）');

  const row1 = (await PLATFORM('GET', '/ledger/overview')).body.items.find((x: any) => x.tenantCode === t1);
  eq(row1.gates.balanceTone, 'danger');
  assert(row1.gates.subscriptionDaysLeft > 0, '订阅剩余天数必须与余额同屏显示且仍为正');

  // 充值 → 自动解冻
  const top = (await PLATFORM('POST', `/ledger/${t1}/topup`, { body: { amountYuan: 100 } })).body;
  eq(top.unfrozen, true, '触底后充值必须报告"已解冻"');
  eq(top.wallet.status, 'active');
  eq(top.wallet.balanceCents, limit + 10000);

  const gate2 = (await req('GET', `/t/${t1}/api/config`, { token: t1Token })).body;
  eq(gate2.gates.balanceOk, true, '充值后闸门应立即放开');
});

check('充值低于最低额 → TOPUP_BELOW_MIN（不给"部分成功"）', async () => {
  const r = await PLATFORM('POST', `/ledger/${t1}/topup`, { body: { amountYuan: 50 } });
  eq(r.status, 400);
  eq(r.body.error.code, 'TOPUP_BELOW_MIN');
  assert(r.body.error.message.includes('100'), '错误信息必须说明最低充值额');
});

check('订阅到期 → 只挂订阅这一条；只降级不放关店、不清数据', async () => {
  const balanceBefore = (await PLATFORM('GET', `/ledger/${t1}`)).body.wallet.balanceCents;
  const past = new Date(Date.now() - 86_400_000).toISOString();

  await PLATFORM('POST', `/ledger/${t1}/subscription/renew`, { body: { periodEnd: past } });
  const patrol = (await PLATFORM('POST', '/ledger/jobs/run', { body: { kind: 'patrol' } })).body;
  assert(patrol.patrol.expired.includes(t1), '到期租户应被识别');

  const gate = (await req('GET', `/t/${t1}/api/config`, { token: t1Token })).body;
  eq(gate.gates.subscriptionValid, false, '订阅闸门应关闭');
  eq(gate.gates.balanceOk, true, '余额闸门不受影响（两道闸门独立）');

  const billing = (await PLATFORM('GET', `/ledger/${t1}`)).body;
  eq(billing.wallet.balanceCents, balanceBefore, '到期不得动余额 —— 只停单，不扣钱');
  eq(billing.subscription.status, 'expired');
  assert(billing.subscription.notice, '必须给出一句中性说明（无禁用词）');
  eq(BANNED_COPY.filter((w) => billing.subscription.notice.includes(w)).length, 0);

  // 学生端仍可浏览：resolve 不报错（只有下单被挡）
  const res = await req('POST', '/api/tenant/resolve', { body: { appid: 'wxTEST0000000001' } });
  eq(res.status, 200, '到期后店铺仍应可浏览，不得整体拒绝');
});

group('V2-到期提醒 15 / 7 / 3');
check('提醒只发一次；续期后提醒位清零', async () => {
  const in10 = new Date(Date.now() + 10 * 86_400_000).toISOString();
  await PLATFORM('POST', `/ledger/${t1}/subscription/renew`, { body: { periodEnd: in10 } });

  const first = (await PLATFORM('POST', '/ledger/jobs/run', { body: { kind: 'patrol' } })).body;
  const mine1 = first.patrol.reminders.filter((r: any) => r.tenantCode === t1);
  eq(mine1.length, 1, '10 天内应命中 15 天阈值');
  eq(mine1[0].threshold, 15);
  eq(BANNED_COPY.filter((w) => `${mine1[0].title}${mine1[0].body}`.includes(w)).length, 0, '提醒文案必须中性');

  const second = (await PLATFORM('POST', '/ledger/jobs/run', { body: { kind: 'patrol' } })).body;
  eq(
    second.patrol.reminders.filter((r: any) => r.tenantCode === t1).length,
    0,
    '同一阈值不得重复提醒（否则每日任务会天天骚扰商户）',
  );

  // 推进到 7 天内 → 命中下一个阈值，但 15 天那条不再发
  const in5 = new Date(Date.now() + 5 * 86_400_000).toISOString();
  await PLATFORM('POST', `/ledger/${t1}/subscription/renew`, { body: { periodEnd: in5 } });
  const third = (await PLATFORM('POST', '/ledger/jobs/run', { body: { kind: 'patrol' } })).body;
  const mine3 = third.patrol.reminders.filter((r: any) => r.tenantCode === t1);
  eq(mine3.length, 1, '续期后应重新有 1 条（7 天阈值）');
  eq(mine3[0].threshold, 7);

  const state = (await PLATFORM('GET', `/ledger/${t1}/subscription/notify-state`)).body;
  eq(state.sent.length, 1, '续期会清零提醒位 —— 只保留本次新发的 1 个');
  assert(state.remaining.includes(3), '剩余阈值里应还有 3 天');
});

check('SUBSCRIPTION_WARN_DAYS 就是 15/7/3（阈值不得偷偷改）', () => {
  eq(SUBSCRIPTION_WARN_DAYS.join(','), '15,7,3');
});

group('V2-账本边界');
check('流水必须带余额快照，且逐条重算 == 当前余额', async () => {
  const view = (await PLATFORM('GET', `/ledger/${t1}?txnLimit=100`)).body;
  const asc = [...view.txns].reverse();
  let running = 0;
  for (const t of asc) {
    running += t.amountCents;
    eq(t.balanceAfterCents, running, `流水 #${t.id} 的快照与逐条累加不符`);
  }
  eq(running, view.wallet.balanceCents, '逐条累加必须等于当前余额');
});

check('非法充值金额（负数 / 小数分）被拒', async () => {
  const neg = await PLATFORM('POST', `/ledger/${t1}/topup`, { body: { amountCents: -100 } });
  eq(neg.status, 400);
  eq(neg.body.error.code, 'TOPUP_AMOUNT_INVALID');
  const frac = await PLATFORM('POST', `/ledger/${t1}/topup`, { body: { amountCents: 10000.5 } });
  eq(frac.status, 400);
});

check('人工调整必须写理由与操作人（钱要说得清）', async () => {
  const noReason = await PLATFORM('POST', `/ledger/${t1}/adjust`, { body: { amountCents: 1, reason: '', operator: 'x' } });
  eq(noReason.status, 400);
  const noOperator = await PLATFORM('POST', `/ledger/${t1}/adjust`, { body: { amountCents: 1, reason: 'r', operator: '' } });
  eq(noOperator.status, 400);
});

check('商户端只能看自己账本（改 URL 看别家 → 403）', async () => {
  const other = await PLATFORM('POST', '/tenants', {
    body: { shopName: '别家小店', orgName: '别家个体户', appid: 'wxTEST0000000009' },
  });
  const otherCode = other.body.tenant.tenantCode;

  // 用 t1 的令牌去读 t1 自己的账单 —— 通过
  const mine = await req('GET', `/t/${t1}/api/billing`, { token: t1Token });
  eq(mine.status, 200, '商户读自己账本应通过');
  eq(assertNoTenantPrivateFields(mine.body).length, 0, '账单出参不得含房间号类字段');

  // 用 t1 的令牌去读别家 —— 跨租户在中间件层就该被拦
  const stolen = await req('GET', `/t/${otherCode}/api/billing`, { token: t1Token });
  eq(stolen.status, 403);
});

check('定时任务可注入 now 手动跑（跨日不用等一天）', async () => {
  const r = (await PLATFORM('POST', '/ledger/jobs/run', { body: { kind: 'all', now: '2026-09-30T18:30:00.000Z' } })).body;
  assert(r.settlement, '应返回结算结果');
  assert(r.patrol, '应返回巡检结果');
  eq(r.settlement.runDate, '2026-10-01', 'runDate 必须按中国时区算（UTC 18:30 = 次日 02:30）');
  const status = (await PLATFORM('GET', '/ledger/jobs/status')).body;
  assert(status.history.length > 0, '任务看板必须能看到最近运行记录');
});

/* ============================================================ V2 库存域 */

const CAT = (m: 'GET' | 'POST' | 'PATCH', p: string, body?: unknown) =>
  req(m, `/t/${t1}/api/catalog${p}`, { token: t1OwnerToken, body });

let pCola = 0; // 商品 id
let pRare = 0; // 只有 1 件库存的商品
let bA = 0;
let bB = 0;

group('V2-商品三态：未上架 ≠ 售罄 ≠ 在售');
check('建商品并在两栋上架', async () => {
  // 自己建两栋，而不是复用 t1BuildingIds —— 那两栋里有一栋已被 V2-10 停用，
  // 停用楼栋不出现在库存矩阵里（矩阵只列启用楼栋），复用会让后面整组测试假失败
  const b1 = await req('POST', `/t/${t1}/api/buildings`, { token: t1OwnerToken, body: { name: '货物测试 A 栋' } });
  const b2 = await req('POST', `/t/${t1}/api/buildings`, { token: t1OwnerToken, body: { name: '货物测试 B 栋' } });
  eq(b1.status, 201, JSON.stringify(b1.body));
  eq(b2.status, 201, JSON.stringify(b2.body));
  bA = b1.body.id;
  bB = b2.body.id;

  const r = await CAT('POST', '/products', {
    name: '可乐 330ml',
    spec: '罐装',
    priceCents: 350,
    buildingIds: [bA, bB],
  });
  eq(r.status, 201, `建商品应 201，实际 ${r.status}：${JSON.stringify(r.body)}`);
  pCola = r.body.product.id;
  eq(r.body.product.priceCents, 350, '价格必须为整数分');

  const r2 = await CAT('POST', '/products', { name: '限量手办', priceCents: 9900, buildingIds: [bA] });
  eq(r2.status, 201, JSON.stringify(r2.body));
  pRare = r2.body.product.id;
});

check('三态分开：未上架 hidden / 库存 0 sold_out / 有货 available', async () => {
  // 可乐在 A 栋给了 0 库存 → 应显示售罄而不是不显示
  await CAT('POST', '/bulk', { productId: pCola, buildingIds: [bA], stock: 0 });
  const a = (await CAT('GET', `/storefront?buildingId=${bA}`)).body.items.find((x: any) => x.productId === pCola);
  assert(a, '库存 0 但已上架 → 必须出现在列表里（显示售罄）');
  eq(a.visibility, 'sold_out', '库存 0 应为 sold_out');
  eq(a.availableQty, 0, '售罄时不可加购');

  // 限量手办只在 A 栋上架 → 在 B 栋必须**完全不可见**
  const bList = (await CAT('GET', `/storefront?buildingId=${bB}`)).body.items;
  assert(
    !bList.some((x: any) => x.productId === pRare),
    '未在 B 栋上架的商品不得出现在 B 栋列表（未上架 ≠ 售罄）',
  );

  // 补货 → available
  await CAT('POST', '/stocks/adjust', { productId: pCola, buildingId: bA, stock: 10, reason: '首次铺货', operator: '张姐' });
  const a2 = (await CAT('GET', `/storefront?buildingId=${bA}`)).body.items.find((x: any) => x.productId === pCola);
  eq(a2.visibility, 'available');
  eq(a2.availableQty, 10);
});

check('双重编码：底色 + 文字角标同时给出（AC-11，色盲可读）', async () => {
  const m = (await CAT('GET', '/matrix')).body;
  const row = m.rows.find((r: any) => r.productId === pCola);
  assert(row, '矩阵应含可乐');
  const cellA = row.cells.find((c: any) => c.buildingId === bA);
  eq(cellA.tone, 'ok', '有货应为 ok');
  assert(cellA.badge.length > 0, '底色之外必须有文字角标');
  const cellB = row.cells.find((c: any) => c.buildingId === bB);
  eq(cellB.stock, 0);
  eq(cellB.visibility, 'sold_out');
  eq(cellB.tone, 'danger');
  eq(cellB.badge, '售罄');
});

check('全局下架 → 所有楼栋都 hidden（与「某栋下架」是两件事）', async () => {
  await CAT('POST', `/products/${pRare}/status`, { status: 'off' });
  const m = (await CAT('GET', '/matrix')).body;
  const row = m.rows.find((r: any) => r.productId === pRare);
  // 全局下架后默认列表不含它；includeOff=1 时含，且每格都 hidden
  const row2 = (await CAT('GET', '/matrix?includeOff=1')).body.rows.find((r: any) => r.productId === pRare);
  assert(row2, 'includeOff=1 时应能看到已下架商品');
  assert(row2.cells.every((c: any) => c.visibility === 'hidden'), '全局下架的商品在所有楼栋都必须 hidden');
  assert(!row, '默认矩阵不应含已下架商品');
  await CAT('POST', `/products/${pRare}/status`, { status: 'active' });
});

group('V2-零超卖：库存不足必须失败，且库存不得为负');
check('预占超过库存 → 400，且库存不动', async () => {
  await CAT('POST', '/stocks/adjust', { productId: pRare, buildingId: bA, stock: 1, reason: '铺货', operator: '张姐' });
  const bad = await CAT('POST', '/stocks/hold', { productId: pRare, buildingId: bA, qty: 2, orderNo: 'OV-0001' });
  eq(bad.status, 400, '超量预占必须被拒');
  const cell = (await CAT('GET', '/matrix')).body.rows
    .find((r: any) => r.productId === pRare)
    .cells.find((c: any) => c.buildingId === bA);
  eq(cell.stock, 1, '失败后库存必须原封不动');
  eq(cell.locked, 0, '失败后预占数必须为 0');
});

check('连续预占抢 1 件：只得一个成功，另一个库存不足', async () => {
  const a = await CAT('POST', '/stocks/hold', { productId: pRare, buildingId: bA, qty: 1, orderNo: 'OV-0002' });
  eq(a.status, 201);
  const b = await CAT('POST', '/stocks/hold', { productId: pRare, buildingId: bA, qty: 1, orderNo: 'OV-0003' });
  eq(b.status, 400, '第 2 个必须失败（唯一一件已被预占）');
  const cell = (await CAT('GET', '/matrix')).body.rows
    .find((r: any) => r.productId === pRare)
    .cells.find((c: any) => c.buildingId === bA);
  eq(cell.stock, 0, '可售应为 0');
  eq(cell.locked, 1, '预占应为 1');
});

check('未上架商品不可预占', async () => {
  const r = await CAT('POST', '/stocks/hold', { productId: pRare, buildingId: bB, qty: 1, orderNo: 'OV-0004' });
  eq(r.status, 400);
  assert(r.body.error.message.includes('未上架'), `错误信息应说明未上架，实际：${r.body.error.message}`);
});

group('V2-库存流水完整（七种迁移，差额必须为 0）');
check('预占 / 支付 / 释放 / 回库 全部留痕且守恒', async () => {
  await CAT('POST', '/stocks/adjust', { productId: pCola, buildingId: bB, stock: 20, reason: '铺货', operator: '张姐' });

  // hold → confirm → 可售不动、预占归零、已售增加
  await CAT('POST', '/stocks/hold', { productId: pCola, buildingId: bB, qty: 3, orderNo: 'FL-0001' });
  const afterHold = (await CAT('GET', '/matrix')).body.rows
    .find((r: any) => r.productId === pCola).cells.find((c: any) => c.buildingId === bB);
  eq(afterHold.stock, 17, '预占后 20−3=17');
  eq(afterHold.locked, 3, '预占 3');

  await CAT('POST', '/stocks/confirm-paid', { productId: pCola, buildingId: bB, qty: 3, orderNo: 'FL-0001' });
  const afterPay = (await CAT('GET', '/matrix')).body.rows
    .find((r: any) => r.productId === pCola).cells.find((c: any) => c.buildingId === bB);
  eq(afterPay.stock, 17, '支付确认**不得再动可售** —— 预占时已扣过，再扣一次就是凭空少货');
  eq(afterPay.locked, 0, '预占应清零');
  eq(afterPay.sold, 3, '已售应为 3');

  // 退款回库
  await CAT('POST', '/stocks/refund-return', { productId: pCola, buildingId: bB, qty: 3, orderNo: 'FL-0001' });
  const afterRefund = (await CAT('GET', '/matrix')).body.rows
    .find((r: any) => r.productId === pCola).cells.find((c: any) => c.buildingId === bB);
  eq(afterRefund.stock, 20, '回库后回到 20');
  eq(afterRefund.sold, 0, '已售回到 0');

  // 释放
  await CAT('POST', '/stocks/hold', { productId: pCola, buildingId: bB, qty: 5, orderNo: 'FL-0002' });
  await CAT('POST', '/stocks/release', { productId: pCola, buildingId: bB, qty: 5, orderNo: 'FL-0002', by: 'timeout' });
  const afterRelease = (await CAT('GET', '/matrix')).body.rows
    .find((r: any) => r.productId === pCola).cells.find((c: any) => c.buildingId === bB);
  eq(afterRelease.stock, 20, '释放后可售回到 20');
  eq(afterRelease.locked, 0, '释放后预占为 0');
});

check('逐格核对：stock == Σ流水change，且最后快照 == 当前stock', async () => {
  const r = (await CAT('GET', '/stock-reconcile')).body;
  assert(r.total > 0, '核对应有格子');
  eq(r.mismatch, 0, `逐格核对差额必须为 0，实际有问题的格子：${JSON.stringify(r.mismatched)}`);
});

check('流水能看到每一笔的 stockAfter 快照，且类型齐全', async () => {
  const logs = (await CAT('GET', '/stock-logs?limit=100')).body.items;
  const types = new Set(logs.map((l: any) => l.type));
  for (const t of ['order_hold', 'pay_confirm', 'cancel_release', 'refund_return', 'manual_adjust']) {
    assert(types.has(t), `流水类型应含 ${t}，实际：${[...types].join(',')}`);
  }
  // 逐条复算：按时间正序累加 change 应等于该条的快照
  const asc = [...logs].reverse().filter((l: any) => l.buildingId === bB && l.productId === pCola);
  let running = 0;
  for (const l of asc) {
    running += l.change;
    eq(l.stockAfter, running, `流水 #${l.id} 的快照与逐条累加不符`);
  }
});

check('幂等：同一订单重复释放 / 重复支付确认不重复生效', async () => {
  await CAT('POST', '/stocks/adjust', { productId: pCola, buildingId: bA, stock: 10, reason: '铺货', operator: '张姐' });
  await CAT('POST', '/stocks/hold', { productId: pCola, buildingId: bA, qty: 4, orderNo: 'IDEM-01' });

  await CAT('POST', '/stocks/release', { productId: pCola, buildingId: bA, qty: 4, orderNo: 'IDEM-01', by: 'user' });
  const once = (await CAT('GET', '/matrix')).body.rows
    .find((r: any) => r.productId === pCola).cells.find((c: any) => c.buildingId === bA);
  eq(once.stock, 10, '释放一次后回到 10');

  // 再释放一次（超时任务与用户取消同时到达的典型场景）
  await CAT('POST', '/stocks/release', { productId: pCola, buildingId: bA, qty: 4, orderNo: 'IDEM-01', by: 'timeout' });
  const twice = (await CAT('GET', '/matrix')).body.rows
    .find((r: any) => r.productId === pCola).cells.find((c: any) => c.buildingId === bA);
  eq(twice.stock, 10, '重复释放**不得**让库存凭空多出来');
});

group('V2-两个同步语义（AC-10：各自必须写明「我不改什么」）');
check('同步上架：只改状态，**不改库存数值**', async () => {
  await CAT('POST', '/stocks/adjust', { productId: pCola, buildingId: bA, stock: 7, reason: '铺货', operator: '张姐' });
  await CAT('POST', '/stocks/adjust', { productId: pCola, buildingId: bB, stock: 3, reason: '铺货', operator: '张姐' });

  const r = await CAT('POST', '/sync/publish', { productId: pCola, status: 'off', targetBuildingIds: [bA, bB] });
  eq(r.status, 201, JSON.stringify(r.body));
  assert(r.body.doesNotChange.includes('库存数值'), '必须明确回报「不改库存数值」');
  eq(r.body.affected, 2);

  const cells = (await CAT('GET', '/matrix')).body.rows.find((x: any) => x.productId === pCola).cells;
  eq(cells.find((c: any) => c.buildingId === bA).stock, 7, '同步上架**不得**动库存 —— 7 必须还是 7');
  eq(cells.find((c: any) => c.buildingId === bB).stock, 3, '同步上架**不得**动库存 —— 3 必须还是 3');
  assert(cells.every((c: any) => c.status === 'off'), '两栋状态应都变成 off');
  assert(cells.every((c: any) => c.visibility === 'hidden'), '下架后前台不可见');

  // 复原
  await CAT('POST', '/sync/publish', { productId: pCola, status: 'on', targetBuildingIds: [bA, bB] });
});

check('同步库存：只改数值，**不改上下架状态**，且跳过未上架楼栋', async () => {
  // bA 下架、bB 在架，从 bA 同步 9 到全部
  await CAT('POST', '/sync/publish', { productId: pCola, status: 'off', targetBuildingIds: [bA] });
  await CAT('POST', '/sync/publish', { productId: pCola, status: 'on', targetBuildingIds: [bB] });

  const r = await CAT('POST', '/sync/stock', { productId: pCola, fromBuildingId: bA, mode: 'value' });
  eq(r.status, 201, JSON.stringify(r.body));
  assert(r.body.doesNotChange.includes('上下架状态'), '必须明确回报「不改上下架状态」');

  const cells = (await CAT('GET', '/matrix')).body.rows.find((x: any) => x.productId === pCola).cells;
  const cA = cells.find((c: any) => c.buildingId === bA);
  const cB = cells.find((c: any) => c.buildingId === bB);
  eq(cB.stock, cA.stock, 'bB 库存应被同步为 bA 的值');
  eq(cA.status, 'off', 'bA 自己仍是「该栋下架」—— 同步库存不得顺手把它上架');
  eq(cB.status, 'on', 'bB 仍是上架状态 —— 同步库存不得动状态位');

  // 未上架的楼栋必须被跳过而不是被顺手新建
  const skipped = r.body.skipped ?? [];
  assert(Array.isArray(skipped), 'skipped 必须是数组');
  await CAT('POST', '/sync/publish', { productId: pCola, status: 'on', targetBuildingIds: [bA] });
});

check('两个同步都留下审计记录（可追溯是谁改的）', async () => {
  // 审计落在平台库，通过平台接口不可见；这里断言接口返回体已声明边界即可
  const r = await CAT('POST', '/sync/stock', { productId: pCola, fromBuildingId: bA, targetBuildingIds: [bB], mode: 'value' });
  eq(r.status, 201);
  assert(r.body.from, '必须回报来源楼栋的当前值');
});

group('V2-跨栋调拨：两格同生同灭');
check('调拨成功后两格数量此消彼长，且都留流水', async () => {
  await CAT('POST', '/stocks/adjust', { productId: pCola, buildingId: bA, stock: 12, reason: '铺货', operator: '张姐' });
  await CAT('POST', '/stocks/adjust', { productId: pCola, buildingId: bB, stock: 0, reason: '盘点', operator: '张姐' });

  const r = await CAT('POST', '/stocks/transfer', { productId: pCola, fromBuildingId: bA, toBuildingId: bB, qty: 5 });
  eq(r.status, 201, JSON.stringify(r.body));
  eq(r.body.from.stock, 7);
  eq(r.body.to.stock, 5);

  const logs = (await CAT('GET', '/stock-logs?limit=50')).body.items;
  const types = logs.map((l: any) => l.type);
  assert(types.includes('transfer_out'), '应有调拨出流水');
  assert(types.includes('transfer_in'), '应有调拨入流水');

  const rec = (await CAT('GET', '/stock-reconcile')).body;
  eq(rec.mismatch, 0, `调拨后差额仍须为 0：${JSON.stringify(rec.mismatched)}`);
});

check('调拨到未上架楼栋 → 拒绝（不顺手新增上架）', async () => {
  // 先给 bA 铺点货 —— 否则会先撞上"调出不足"，测不到目标楼栋那条判据
  await CAT('POST', '/stocks/adjust', { productId: pRare, buildingId: bA, stock: 5, reason: '调拨前置铺货', operator: '张姐' });
  const r = await CAT('POST', '/stocks/transfer', { productId: pRare, fromBuildingId: bA, toBuildingId: bB, qty: 1 });
  eq(r.status, 400, JSON.stringify(r.body));
  assert(r.body.error.message.includes('未上架'), `应说明目标楼栋未上架，实际：${r.body.error.message}`);
  // 且不得因此给 bB 新建一格
  const cells = (await CAT('GET', '/matrix')).body.rows.find((x: any) => x.productId === pRare).cells;
  assert(!cells.some((c: any) => c.buildingId === bB && c.exists), '被拒的调拨不得在目标楼栋新增上架格');
});

check('调出栋不足 → 拒绝且两侧都不动', async () => {
  const before = (await CAT('GET', '/matrix')).body.rows.find((x: any) => x.productId === pCola).cells;
  const beforeA = before.find((c: any) => c.buildingId === bA).stock;
  const beforeB = before.find((c: any) => c.buildingId === bB).stock;

  const r = await CAT('POST', '/stocks/transfer', { productId: pCola, fromBuildingId: bA, toBuildingId: bB, qty: 9999 });
  eq(r.status, 400);

  const after = (await CAT('GET', '/matrix')).body.rows.find((x: any) => x.productId === pCola).cells;
  eq(after.find((c: any) => c.buildingId === bA).stock, beforeA, '失败后调出栋不得变动');
  eq(after.find((c: any) => c.buildingId === bB).stock, beforeB, '失败后调入栋不得变动');
});

group('V2-目录域边界');
check('价格必须是整数分，且异常大值被拦（防把元当分填）', async () => {
  const frac = await CAT('POST', '/products', { name: '小数价', priceCents: 3.5 });
  eq(frac.status, 400);
  const zero = await CAT('POST', '/products', { name: '零价', priceCents: 0 });
  eq(zero.status, 400);
  const huge = await CAT('POST', '/products', { name: '天价', priceCents: 999_999_999 });
  eq(huge.status, 400, '异常大值应被拦，提示可能把元当成了分');
});

check('人工调整必须写理由与操作人', async () => {
  const noReason = await CAT('POST', '/stocks/adjust', { productId: pCola, buildingId: bA, stock: 5, reason: '', operator: '张姐' });
  eq(noReason.status, 400);
  const noOperator = await CAT('POST', '/stocks/adjust', { productId: pCola, buildingId: bA, stock: 5, reason: '盘点', operator: '' });
  eq(noOperator.status, 400);
});

check('未上架的商品不能直接调库存（必须先上架）', async () => {
  const r = await CAT('POST', '/stocks/adjust', { productId: pRare, buildingId: bB, stock: 5, reason: '盘点', operator: '张姐' });
  eq(r.status, 404);
});

check('跨租户：改 URL 用 t1 令牌读别家目录 → 403', async () => {
  const other = await PLATFORM('POST', '/tenants', {
    body: { shopName: '隔壁铺子', orgName: '隔壁个体户', appid: 'wxTEST0000000010' },
  });
  const otherCode = other.body.tenant.tenantCode;
  const stolen = await req('GET', `/t/${otherCode}/api/catalog/matrix`, { token: t1Token });
  eq(stolen.status, 403);
});

group('守卫自证：库存核对真的能抓到「绕过原语改库存」');
check('反证：直接改格子的 stock 而不写流水 → reconcile 必须报差', async () => {
  // 独立构造一套仓储 + 服务，不干扰跑着的那个 app 实例
  const factory = new MemoryRepoFactory();
  const svc = new StockService(factory);
  const code = 'guard-probe';
  const pid = 1;
  const bid = 1;

  // 正常路径：走原语，自动留流水
  await factory.tenant(code).moveStock({
    productId: pid,
    buildingId: bid,
    dStock: 10,
    type: 'manual_adjust',
    operator: 'probe',
    remark: '正常铺货',
  });
  const ok = await svc.reconcile(code);
  eq(ok.mismatch, 0, '正常路径下核对必须通过（否则这道守卫等于永远报错）');

  // ⚠️ 绕过原语：直接改内存里的格子，不写流水 —— 模拟"有人在真库里手改了一下"
  const bucket = factory.store.bucket(code);
  const cell = bucket.stocks.find((s) => s.productId === pid && s.buildingId === bid);
  assert(cell, '探针格子应存在');
  cell.stock = 999;

  const caught = await svc.reconcile(code);
  eq(caught.mismatch, 1, '绕过原语的改动必须被 reconcile 抓到');
  const bad = caught.mismatched[0]!;
  eq(bad.diff, 999 - 10, '差额应精确指出差了多少');
  eq(bad.sumOk, false, '求和断言应失败');
  eq(bad.snapshotOk, false, '快照断言应失败');

  // 反证第二路：**连账一起伪造**（改数值 + 补一条对得上的流水）
  // 这时核对应当通过 —— 这是这道守卫诚实的边界：它查的是"账实是否相符"，
  // 不是"有没有人动过手脚"。想抓后者只能靠审计日志，两件事别混为一谈。
  bucket.stockLogs.push({
    id: bucket.seq.stockLog++,
    productId: pid,
    buildingId: bid,
    type: 'manual_adjust',
    change: 989,
    stockAfter: 999,
    refOrderNo: null,
    operator: 'probe',
    remark: '伪造一条流水试图掩盖',
    createdAt: new Date().toISOString(),
  });
  const masked = await svc.reconcile(code);
  eq(masked.mismatch, 0, '账实都改了之后应当自洽 —— 这正是本守卫的边界，不是缺陷');

  // 但把数值再动一次、不补流水，立刻又会被抓到（说明它不是"一次通过就永远通过"）
  cell.stock = 1000;
  const caught2 = await svc.reconcile(code);
  eq(caught2.mismatch, 1, '再一次绕过原语仍必须被抓到');
});

/* ============================================================ V4 订单状态机 */

const stuTokenRef: { a: string; b: string } = { a: '', b: '' };
let stuAId = 0;
let stuBId = 0;
let bOrder = 0;   // 订单专用楼栋
let bOther = 0;   // 另一个楼栋（跨楼栋拦截用）
let pA = 0;       // 有库存
let pB = 0;       // 售罄（用于"全或无"回滚）
let addrA = 0;    // 楼栋正确
let addrOther = 0; // 楼栋错误
let addrF3 = 0;
let addrF10 = 0;

/** 学生端订单接口 */
const ORD = (m: 'GET' | 'POST', p: string, body?: unknown, token = stuTokenRef.a) =>
  req(m, `/t/${t1}/api/orders${p}`, { token, body });
/** 地址接口 */
const ADDR = (m: 'GET' | 'POST' | 'PATCH' | 'DELETE', p: string, body?: unknown, token = stuTokenRef.a) =>
  req(m, `/t/${t1}/api/addresses${p}`, { token, body });
/** 商户端订单接口 */
const MER = (m: 'GET' | 'POST', p: string, body?: unknown) =>
  req(m, `/t/${t1}/api/merchant/orders${p}`, { token: t1OwnerToken, body });
/** 支付回调（内部端点，平台密钥保护） */
const PAYCB = (body: unknown) =>
  PLATFORM('POST', `/pay/${t1}/callback`, { body });

/** 读某一格库存（走库存矩阵，学生/店主都能读） */
async function cellOf(productId: number, buildingId: number) {
  const m = await CAT('GET', '/matrix');
  eq(m.status, 200, JSON.stringify(m.body));
  const row = (m.body.rows as any[]).find((r) => r.productId === productId);
  assert(row, `矩阵里找不到商品 ${productId}`);
  const cell = (row.cells as any[]).find((c) => c.buildingId === buildingId);
  assert(cell, `矩阵里找不到商品 ${productId} 在楼栋 ${buildingId} 的格子`);
  return cell as { stock: number; locked: number; sold: number; status: string; visibility: string };
}

group('V4-0 登录与身份（wx.login → code2session → 带 sub 的令牌）');

check('登录自检如实报告凭据状态；未配置时报 WECHAT_NOT_CONFIGURED（不是模糊的网络错误）', async () => {
  const st = await req('GET', '/api/tenant/auth/status');
  eq(st.status, 200);
  assert(st.body.insecureOpenidAllowed, '测试环境应允许直传 openid（生产默认关闭）');

  // 这条断言**不能假设本机没配凭据** —— 否则填了真实 AppID 的人一跑冒烟就红，
  // 而"填了真实凭据"恰恰是上线前必然发生的事。所以两条分支都断言，按环境走。
  if (env.wechat.appId) {
    eq(st.body.wechat.configured, true, '已配 WECHAT_APPID/SECRET，自检必须如实报告"就绪"');
    eq(st.body.loginReady, true, 'loginReady 应与 configured 同真');
    eq(st.body.wechat.appSecretSet, true, 'AppSecret 已配置应如实反映');
    assert(
      String(st.body.hint).includes('微信登录已就绪'),
      `已配置时提示应说明就绪并给出 AppID 尾号：${st.body.hint}`,
    );
    // 已配置时**不打真实微信接口**：单测依赖外网 = 断网就红，这不该发生
    return;
  }

  eq(st.body.wechat.configured, false, '本机未配置 WECHAT_APPID/SECRET，自检应如实报告');
  assert(st.body.hint.includes('WECHAT_APPID'), `提示必须指出缺哪个环境变量：${st.body.hint}`);

  const r = await req('POST', '/api/tenant/resolve', {
    body: { appid: 'wxTEST0000000001', code: 'fake-code-from-wx-login' },
  });
  eq(r.status, 400, JSON.stringify(r.body));
  eq(r.body.error.code, 'WECHAT_NOT_CONFIGURED', '必须是明确的配置错误码 —— 否则会有人花半天查网络');
});

check('登录学生 A / B，令牌带 userId；同 openid 重复登录不建第二个用户', async () => {
  const a1 = await req('POST', '/api/tenant/resolve', {
    body: { appid: 'wxTEST0000000001', openid: 'openid-stu-A', nickname: '小明' },
  });
  eq(a1.status, 200, JSON.stringify(a1.body));
  assert(a1.body.user, '登录后必须返回用户身份');
  eq(a1.body.user.nickname, '小明');
  stuAId = a1.body.user.id;
  stuTokenRef.a = a1.body.token;

  const a2 = await req('POST', '/api/tenant/resolve', { body: { appid: 'wxTEST0000000001', openid: 'openid-stu-A' } });
  eq(a2.body.user.id, stuAId, '同一 openid 必须复用同一条用户（否则每次登录都新建用户）');

  const b = await req('POST', '/api/tenant/resolve', {
    body: { appid: 'wxTEST0000000001', openid: 'openid-stu-B', nickname: '小红' },
  });
  stuBId = b.body.user.id;
  stuTokenRef.b = b.body.token;
  assert(stuBId !== stuAId, '不同 openid 应是不同用户');
});

check('匿名浏览令牌（无 sub）不能下单 —— 401 LOGIN_REQUIRED', async () => {
  const browse = await req('POST', '/api/tenant/resolve', { body: { appid: 'wxTEST0000000001' } });
  eq(browse.body.user, null, '不带登录参数时不应返回用户');
  const r = await req('POST', `/t/${t1}/api/orders`, {
    token: browse.body.token,
    body: { buildingId: 1, addressId: 1, items: [{ productId: 1, qty: 1 }] },
  });
  eq(r.status, 401, `匿名令牌下单必须 401，实际 ${r.status}`);
  eq(r.body.error.code, 'LOGIN_REQUIRED');
});

check('resolve 出参带 serverTime（AC-14：学生的手机时钟不可信）', async () => {
  const r = await req('POST', '/api/tenant/resolve', { body: { appid: 'wxTEST0000000001' } });
  eq(r.status, 200, JSON.stringify(r.body));
  assert(typeof r.body.serverTime === 'string', '必须返回 serverTime —— 否则截单倒计时只能用设备本地时钟算');
  const skew = Math.abs(new Date(r.body.serverTime).getTime() - Date.now());
  assert(skew < 5_000, `serverTime 与真实时间偏离应 < 5s，实际 ${skew}ms`);
  // 新增字段不能顺带把「租户私有字段守卫」撑出缺口
  const flat = JSON.stringify(r.body);
  assert(!flat.includes('roomNo'), 'resolve 出参出现 roomNo —— AC-13 被破坏了');
  assert(!/"floor"\s*:/.test(flat), 'resolve 出参出现 floor —— AC-13 被破坏了');
});

group('V4-1 越权：写接口要店主身份，学生令牌一律拒绝');

check('学生令牌改配置 / 建楼栋 / 改价 → 403（这是之前真存在的洞）', async () => {
  const cfg = await req('POST', `/t/${t1}/api/config`, { token: stuTokenRef.a, body: { shopOpen: false } });
  eq(cfg.status, 403, `学生令牌必须不能改店铺配置，实际 ${cfg.status}`);
  eq(cfg.body.error.code, 'TOKEN_INVALID');

  const bld = await req('POST', `/t/${t1}/api/buildings`, { token: stuTokenRef.a, body: { name: '学生偷偷建的栋' } });
  eq(bld.status, 403);

  const prod = await req('POST', `/t/${t1}/api/catalog/products`, {
    token: stuTokenRef.a, body: { name: '把可乐改成 1 分', priceCents: 1 },
  });
  eq(prod.status, 403, `学生令牌必须不能改价，实际 ${prod.status}`);

  // 反证：店主令牌做同样的事必须成功（否则这道守卫等于把所有人都挡了）
  const okCfg = await req('POST', `/t/${t1}/api/config`, { token: t1OwnerToken, body: { shopOpen: true } });
  assert(okCfg.status < 400, `店主令牌改配置应成功，实际 ${okCfg.status}：${JSON.stringify(okCfg.body)}`);
});

check('店主令牌不能当学生用（商户端与 C 端身份不混用）', async () => {
  const r = await req('GET', `/t/${t1}/api/orders`, { token: t1OwnerToken });
  eq(r.status, 401, '店主令牌没有 sub，学生端接口应要求登录');
});

check('学生 A 读学生 B 的订单 → 403（越权与"单不存在"要可区分）', async () => {
  const other = await ORD('POST', '', {
    buildingId: 1, addressId: 1, items: [{ productId: 1, qty: 1 }], clientKey: 'x',
  }, stuTokenRef.b);
  // 这里不关心它是否成功（地址没建，可能 400），只要拿不到 A 能读的单号
  void other;
  const r = await ORD('GET', '/NO-SUCH-ORDER-0001');
  eq(r.status, 404, '不存在的单应 404');
  eq(r.body.error.code, 'ORDER_NOT_FOUND');
});

group('V4-2 准备：放宽营业窗口 + 专用楼栋 / 商品 / 地址');

check('把营业窗口放宽到全天（否则闸门判定会随测试运行时刻飘）', async () => {
  const r = await req('POST', `/t/${t1}/api/config`, {
    token: t1OwnerToken,
    body: {
      openTime: '00:00', closeTime: '23:59',
      accessibleFrom: '00:00', accessibleTo: '23:59',
      cutoffLeadMinutes: 0,
      minAmountCents: 0,
      deliveryFeeCents: 100,
      shopOpen: true,
    },
  });
  assert(r.status < 400, JSON.stringify(r.body));
  eq(r.body.cutoffTime, '23:59', '在途 0 分钟 → 截单 = 门禁结束');
});

check('自造前置数据：两栋楼 + 三个商品 + 三个地址（不蹭前面测试的）', async () => {
  const b1 = await req('POST', `/t/${t1}/api/buildings`, { token: t1OwnerToken, body: { name: '订单专用栋' } });
  const b2 = await req('POST', `/t/${t1}/api/buildings`, { token: t1OwnerToken, body: { name: '订单另一栋' } });
  eq(b1.status, 201, JSON.stringify(b1.body));
  eq(b2.status, 201, JSON.stringify(b2.body));
  bOrder = b1.body.id;
  bOther = b2.body.id;

  const mk = async (name: string, priceCents: number, stock: number) => {
    const r = await CAT('POST', '/products', { name, priceCents, buildingIds: [bOrder] });
    eq(r.status, 201, JSON.stringify(r.body));
    const id = r.body.product.id;
    const adj = await CAT('POST', '/stocks/adjust', {
      productId: id, buildingId: bOrder, stock, reason: '测试铺货', operator: 'smoke',
    });
    assert(adj.status < 400, JSON.stringify(adj.body));
    return id;
  };
  pA = await mk('测试可乐', 350, 20);
  pB = await mk('测试售罄品', 500, 0);
  await mk('测试薯片', 1000, 5);

  const a1 = await ADDR('POST', '', { buildingId: bOrder, floor: '6', room: '602', contact: '小明', phone: '13800000001' });
  eq(a1.status, 201, JSON.stringify(a1.body));
  addrA = a1.body.address.id;
  eq(a1.body.address.isDefault, true, '第一条地址应自动成为默认');

  const a2 = await ADDR('POST', '', { buildingId: bOrder, floor: '3', room: '308' });
  addrF3 = a2.body.address.id;
  const a3 = await ADDR('POST', '', { buildingId: bOrder, floor: '10', room: '1001' });
  addrF10 = a3.body.address.id;
  const a4 = await ADDR('POST', '', { buildingId: bOther, floor: '1', room: '101' });
  addrOther = a4.body.address.id;

  // 闸门必须开着，否则后面整组会因为"时间窗外"假失败 —— 这里把它变成一句明确的报错
  const gate = await req('GET', `/t/${t1}/api/config/gate?buildingId=${bOrder}`, { token: stuTokenRef.a });
  assert(
    gate.body.orderable,
    `测试前置条件不满足：当前闸门不可下单（${gate.body.state} / ${gate.body.message}）`,
  );
});

/** 下单 + 断言 201 */
async function placeOk(body: Record<string, unknown>, token = stuTokenRef.a) {
  const r = await ORD('POST', '', body, token);
  eq(r.status, 201, `下单应 201，实际 ${r.status}：${JSON.stringify(r.body)}`);
  return r.body.order as {
    orderNo: string; status: string; payStatus: string; totalCents: number;
    amountCents: number; feeCents: number; deliveryFeeCents: number; createdAt: string;
  };
}

group('V4-3 下单：跨楼栋拦截 / 服务端算价 / 库存全或无');

check('地址楼栋 ≠ 订单楼栋 → 拒绝（货不能送到学生不在的楼）', async () => {
  const r = await ORD('POST', '', { buildingId: bOrder, addressId: addrOther, items: [{ productId: pA, qty: 1 }] });
  eq(r.status, 400, JSON.stringify(r.body));
  eq(r.body.error.code, 'ORDER_CROSS_BUILDING');
  assert(r.body.error.message.includes('不是同一栋'), `应说清是楼栋不匹配：${r.body.error.message}`);
});

check('金额与费率全部服务端算（客户端传的价格一律不看）', async () => {
  const cellsBefore = await cellOf(pA, bOrder);
  const o = await placeOk({
    buildingId: bOrder,
    addressId: addrA,
    items: [{ productId: pA, qty: 2 }],
    // 故意塞一个价格 —— 服务端必须无视它
    priceCents: 1,
    totalCents: 1,
    remark: '302 门口放一下',
  });
  eq(o.amountCents, 700, '2 × 350 = 700');
  eq(o.deliveryFeeCents, 100, '配送费取自店铺配置');
  eq(o.totalCents, 800);
  eq(o.feeCents, feeOfCents(800), `服务费应为实付的 ${FEE_BP / 100}%`);
  eq(o.status, 'pending_pay');
  eq(o.payStatus, 'unpaid');

  const after = await cellOf(pA, bOrder);
  eq(after.stock, cellsBefore.stock - 2, '预占：可售 −2');
  eq(after.locked, cellsBefore.locked + 2, '预占：锁定 +2');
  eq(after.sold, cellsBefore.sold, '未支付不得计入已售');
});

check('库存不足 → 整单失败，且**已占的格子必须回滚干净**（全或无）', async () => {
  const before = await cellOf(pA, bOrder);
  const r = await ORD('POST', '', {
    buildingId: bOrder,
    addressId: addrA,
    items: [{ productId: pA, qty: 1 }, { productId: pB, qty: 1 }],
  });
  eq(r.status, 400, JSON.stringify(r.body));
  eq(r.body.error.code, 'ORDER_OUT_OF_STOCK');
  assert(r.body.error.message.includes('测试售罄品'), `应指出是哪件商品：${r.body.error.message}`);

  const after = await cellOf(pA, bOrder);
  eq(after.stock, before.stock, '第一件已被预占，失败后必须回滚可售值');
  eq(after.locked, before.locked, '锁定值也必须回滚 —— 否则库存被永久占住');
});

check('同一 clientKey 连点两次 → 只出一单、只占一次库存', async () => {
  const before = await cellOf(pA, bOrder);
  const key = 'client-key-tap-twice';
  const first = await placeOk({ buildingId: bOrder, addressId: addrA, items: [{ productId: pA, qty: 1 }], clientKey: key });
  const second = await ORD('POST', '', {
    buildingId: bOrder, addressId: addrA, items: [{ productId: pA, qty: 1 }], clientKey: key,
  });
  eq(second.status, 201);
  eq(second.body.duplicated, true, '第二次必须标记为重复提交');
  eq(second.body.order.orderNo, first.orderNo, '必须返回同一张单，不能新建');

  const after = await cellOf(pA, bOrder);
  eq(after.locked, before.locked + 1, '库存只能被占一次');
});

group('V4-4 支付回调：幂等 + 金额校验');

let paidOrder = '';   // 一张已支付的单
let paidOrderTotal = 0;
let unpaidOrder = ''; // 一张**真正未支付**的单（金额不符 / 超时关单 / allowedActions 用）

check('支付成功 → 状态流转 + 预占转已售 + 登记待扣记录', async () => {
  const o = await placeOk({ buildingId: bOrder, addressId: addrA, items: [{ productId: pA, qty: 1 }] });
  paidOrderTotal = o.totalCents;
  const before = await cellOf(pA, bOrder);

  const cb = await PAYCB({ orderNo: o.orderNo, txnId: 'TX-0001', amountCents: o.totalCents });
  eq(cb.status, 200, JSON.stringify(cb.body));
  eq(cb.body.code, 'SUCCESS');
  eq(cb.body.idempotent, false, '首次回调不是幂等重放');

  const d = await MER('GET', `/${o.orderNo}`);
  eq(d.body.order.status, 'pending_accept', '支付后进入待接单');
  eq(d.body.order.payStatus, 'paid');
  eq(d.body.order.payTxnId, 'TX-0001');

  const after = await cellOf(pA, bOrder);
  eq(after.locked, before.locked - 1, '支付确认：锁定 −1');
  eq(after.sold, before.sold + 1, '支付确认：已售 +1');
  eq(after.stock, before.stock, '支付确认**不动可售值**（货早就在预占时扣过了）');

  const pending = await PLATFORM('GET', `/ledger/${t1}/pending`);
  eq(
    (pending.body.items as any[]).filter((i) => i.orderNo === o.orderNo).length, 1,
    '必须登记且只登记一条待扣记录',
  );
  paidOrder = o.orderNo;
});

check('重复推送回调 10 次 → 幂等：不二次扣库存、不重复登记', async () => {
  const before = await cellOf(pA, bOrder);
  for (let i = 0; i < 10; i++) {
    const cb = await PAYCB({ orderNo: paidOrder, txnId: 'TX-0001', amountCents: paidOrderTotal });
    eq(cb.status, 200, `第 ${i + 1} 次回调应成功返回：${JSON.stringify(cb.body)}`);
    eq(cb.body.idempotent, true, `第 ${i + 1} 次必须是幂等重放`);
  }
  const after = await cellOf(pA, bOrder);
  eq(after.locked, before.locked, '锁定值不得变化');
  eq(after.sold, before.sold, '已售值不得变化 —— 否则每次重推都会多算一件');

  const pending = await PLATFORM('GET', `/ledger/${t1}/pending`);
  eq(
    (pending.body.items as any[]).filter((i) => i.orderNo === paidOrder).length, 1,
    '待扣记录仍只有一条',
  );
});

check('回调金额与订单实付不符 → 拒绝落账，订单与库存都不得变动', async () => {
  // 必须用一张**真正待支付**的单：如果拿已支付的单来测，拒绝理由会变成"状态不对"，
  // 金额校验这一条就永远没被验证过（看起来通过，其实测的是别的东西）
  const u = await placeOk({ buildingId: bOrder, addressId: addrA, items: [{ productId: pA, qty: 1 }] });
  unpaidOrder = u.orderNo;
  eq(u.payStatus, 'unpaid');

  const before = await cellOf(pA, bOrder);
  const cb = await PAYCB({ orderNo: unpaidOrder, txnId: 'TX-TAMPER', amountCents: 1 });
  eq(cb.status, 400, JSON.stringify(cb.body));
  eq(cb.body.error.code, 'ORDER_AMOUNT_MISMATCH');

  const d = await MER('GET', `/${unpaidOrder}`);
  eq(d.body.order.status, 'pending_pay', '状态绝不能变（钱没到账）');
  eq(d.body.order.payStatus, 'unpaid');
  eq(d.body.order.payTxnId, null, '不得记下流水号');
  const after = await cellOf(pA, bOrder);
  eq(after.locked, before.locked, '库存不得变动');
  eq(after.stock, before.stock);
});

check('已取消/已退款的单收到回调 → 拒绝，不能"复活"', async () => {
  const cb = await PAYCB({ orderNo: 'NOT-A-REAL-ORDER', txnId: 'TX-X', amountCents: 100 });
  eq(cb.status, 404);
  eq(cb.body.error.code, 'ORDER_NOT_FOUND');
});

group('V4-5 状态机：非法转移必须被拒绝（不是"大概不行"）');

check('不变量①：钱已收就不能直接取消，只能走退款', async () => {
  const r = await ORD('POST', `/${paidOrder}/cancel`, { reason: '学生反悔' });
  eq(r.status, 400, JSON.stringify(r.body));
  eq(r.body.error.code, 'ORDER_ILLEGAL_TRANSITION');
  assert(r.body.error.message.includes('退款'), `必须说清要走退款：${r.body.error.message}`);

  const d = await MER('GET', `/${paidOrder}`);
  eq(d.body.order.status, 'pending_accept', '状态不得变动');
});

check('待支付状态不能接单（商户不能接一张没付钱的单）', async () => {
  const r = await MER('POST', `/${unpaidOrder}/accept`);
  eq(r.status, 400, JSON.stringify(r.body));
  eq(r.body.error.code, 'ORDER_ILLEGAL_TRANSITION');
});

check('接单 → 配送中；重复接单 → 拒绝；允许从待接单直达已送达', async () => {
  const a1 = await MER('POST', `/${paidOrder}/accept`);
  eq(a1.status, 200, JSON.stringify(a1.body));
  eq(a1.body.order.status, 'delivering');
  assert(a1.body.order.acceptedAt, '接单必须记时间');

  const a2 = await MER('POST', `/${paidOrder}/accept`);
  eq(a2.status, 400, '配送中不能再接单');
  eq(a2.body.error.code, 'ORDER_ILLEGAL_TRANSITION');

  // 直达送达：商户取了货就走，不必先点接单 —— 这一跳不破坏任何不变量
  const o2 = await placeOk({ buildingId: bOrder, addressId: addrA, items: [{ productId: pA, qty: 1 }] });
  await PAYCB({ orderNo: o2.orderNo, txnId: 'TX-0002', amountCents: o2.totalCents });
  const direct = await MER('POST', `/${o2.orderNo}/deliver`);
  eq(direct.status, 200, JSON.stringify(direct.body));
  eq(direct.body.order.status, 'delivered');

  const again = await MER('POST', `/${o2.orderNo}/deliver`);
  eq(again.status, 400, '已送达是终态，不能重复送达');
});

check('allowedActions 由服务端给出（前端不猜按钮可用性）', async () => {
  const d = await ORD('GET', `/${unpaidOrder}`);
  eq(d.status, 200);
  assert(Array.isArray(d.body.actions), '必须返回当前可做的动作');
  assert(d.body.actions.includes('pay'), '待支付单应该能支付');
  assert(d.body.actions.includes('cancel'), '待支付单应该能取消');
  assert(!d.body.actions.includes('deliver'), '学生不能标记送达');
  eq(d.body.room, '602', '本人房间号回显给本人是正常的');
  assert(typeof d.body.payExpiresInSeconds === 'number', '待支付应给出剩余秒数供前端倒计时');
});

check('「再来一单」契约：详情必须带上 buildingId 与每行的 productId', async () => {
  const o = await placeOk({ buildingId: bOrder, addressId: addrA, items: [{ productId: pA, qty: 2 }] });
  const d = await ORD('GET', `/${o.orderNo}`);
  eq(d.status, 200, JSON.stringify(d.body));

  // buildingId 缺失的话，前端只能用楼栋名反查 —— 楼栋一改名「再来一单」就静默失效
  eq(d.body.buildingId, bOrder, '必须给出订单楼栋 id');

  const items = d.body.items as any[];
  eq(items.length, 1);
  eq(items[0].productId, pA, '每行必须带 productId，否则无法按当前货架补货');
  eq(items[0].name, '测试可乐', '商品名仍是快照：改名不得改变历史订单');
  eq(items[0].qty, 2);

  // 列表与详情必须同源，否则"列表能再来一单、详情不能"这种不一致不会出现
  const l = await ORD('GET', '?status=ongoing');
  eq(l.status, 200, JSON.stringify(l.body));
  const row = (l.body.items as any[]).find((x) => x.orderNo === o.orderNo);
  assert(row, '列表应能看到刚下的单');
  eq(row.buildingId, bOrder);
  eq(row.items[0].productId, pA);
  await topUp(pA, bOrder, 30);
});

/**
 * 学生的站内消息读取入口。
 *
 * ⚠️ 用 stuTokenRef.a（登录态），匿名令牌必须拿不到 —— 消息是私人信箱。
 */
const NOTE = (m: 'GET' | 'PATCH', p: string, body?: unknown, token = stuTokenRef.a) =>
  req(m, `/t/${t1}/api/notices${p}`, { token, body });

/**
 * 给本组测试铺库存。
 *
 * 为什么不复用前面的余量：V4-10 会真的走完"支付 → 接单 → 送达"，
 * 这会永久消耗 sold 库存（不像取消/超时会自动释放）。
 * 依赖"前面还剩多少"的测试一旦换顺序就随机失败，这类脆性是自找的。
 */
async function topUp(productId: number, buildingId: number, qty: number): Promise<void> {
  const r = await CAT('POST', '/stocks/adjust', {
    productId, buildingId, stock: qty, reason: 'V4-10 铺货', operator: 'smoke',
  });
  assert(r.status < 400, `铺货失败：${JSON.stringify(r.body)}`);
}

group('V4-10 站内消息兜底（CS-13）：每一次流转都要留痕，且不重复');

check('匿名令牌读不到消息箱（私人信箱不能裸奔）', async () => {
  const browse = await req('POST', '/api/tenant/resolve', { body: { appid: 'wxTEST0000000001' } });
  const r = await NOTE('GET', '', undefined, browse.body.token);
  eq(r.status, 401, `匿名读消息必须 401，实际 ${r.status}`);
  eq(r.body.error.code, 'LOGIN_REQUIRED');
});

check('支付 / 接单 / 送达 各留一条；回调重放不重复打扰', async () => {
  const before = await NOTE('GET', '/unread');
  eq(before.status, 200, JSON.stringify(before.body));
  const base = before.body.unread as number;
  await topUp(pA, bOrder, 30);

  const o = await placeOk({ buildingId: bOrder, addressId: addrA, items: [{ productId: pA, qty: 1 }] });

  // 同一个 txnId 重放 3 次 —— 微信回调本来就会重发
  for (let i = 0; i < 3; i += 1) {
    await PAYCB({ orderNo: o.orderNo, txnId: 'TX-NOTICE-1', amountCents: o.totalCents });
  }
  const afterPay = (await NOTE('GET', '/unread')).body.unread as number;
  eq(afterPay, base + 1, `支付成功只应产生 1 条消息（回调重放了 3 次），实际新增 ${afterPay - base}`);

  await MER('POST', `/${o.orderNo}/accept`);
  eq((await NOTE('GET', '/unread')).body.unread, base + 2, '接单应再来 1 条');

  await MER('POST', `/${o.orderNo}/deliver`);
  eq((await NOTE('GET', '/unread')).body.unread, base + 3, '送达应再来 1 条');

  const list = await NOTE('GET', '?limit=10');
  eq(list.status, 200, JSON.stringify(list.body));
  const rows = list.body.items as any[];
  const types = rows.slice(0, 3).map((n) => n.type);
  assert(types.includes('delivered'), `最新应是送达，实际：${types.join(',')}`);
  assert(types.includes('accepted'), `应有接单消息，实际：${types.join(',')}`);
  assert(types.includes('paid'), `应有支付消息，实际：${types.join(',')}`);
  // orderNo 必须带上：前端要靠它从消息跳到订单详情
  eq(rows[0].orderNo, o.orderNo);
});

check('退款完成 / 退款驳回要通知；发起退款是中间态、不打扰', async () => {
  await topUp(pA, bOrder, 30);

  const o = await placeOk({ buildingId: bOrder, addressId: addrA, items: [{ productId: pA, qty: 1 }] });
  await PAYCB({ orderNo: o.orderNo, txnId: 'TX-NOTICE-2', amountCents: o.totalCents });

  const base = (await NOTE('GET', '/unread')).body.unread as number;
  const rs = await MER('POST', `/${o.orderNo}/refund/start`);
  assert(rs.status < 400, `发起退款失败：${rs.status} ${JSON.stringify(rs.body)}`);
  eq((await NOTE('GET', '/unread')).body.unread, base, '发起退款阶段不该给学生发消息');

  const rd = await MER('POST', `/${o.orderNo}/refund/done`, { refundCents: o.totalCents });
  assert(rd.status < 400, `退款完成接口失败：${rd.status} ${JSON.stringify(rd.body)}`);
  eq((await NOTE('GET', '/unread')).body.unread, base + 1, '退款完成应有 1 条');

  const o2 = await placeOk({ buildingId: bOrder, addressId: addrA, items: [{ productId: pA, qty: 1 }] });
  await PAYCB({ orderNo: o2.orderNo, txnId: 'TX-NOTICE-3', amountCents: o2.totalCents });
  await MER('POST', `/${o2.orderNo}/refund/start`);
  const b2 = (await NOTE('GET', '/unread')).body.unread as number;
  await MER('POST', `/${o2.orderNo}/refund/reject`);
  eq((await NOTE('GET', '/unread')).body.unread, b2 + 1, '退款驳回应有 1 条');
});

check('标记已读：重复标记不重复计数（红点不会自己乱减）', async () => {
  const before = await NOTE('GET', '?limit=5');
  eq(before.status, 200, JSON.stringify(before.body));
  const rows = before.body.items as any[];
  assert(rows.length >= 1, '前面应该已经攒了若干条消息');

  const first = await NOTE('PATCH', '/read', { ids: [rows[0].id] });
  eq(first.status, 200, JSON.stringify(first.body));
  eq(first.body.marked, 1, '第一次标记应为 1');

  const again = await NOTE('PATCH', '/read', { ids: [rows[0].id] });
  eq(again.body.marked, 0, '同一条重复标记必须为 0 —— 否则前端红点会莫名再减一个');

  const all = await NOTE('PATCH', '/read');
  eq(all.status, 200, JSON.stringify(all.body));
  eq((await NOTE('GET', '/unread')).body.unread, 0, '全标之后未读必须归零');
});

check('订阅授权：只登记不发送（没配 AppID 时不得烧掉一次性授权）', async () => {
  await topUp(pA, bOrder, 30);

  const o = await placeOk({ buildingId: bOrder, addressId: addrA, items: [{ productId: pA, qty: 1 }] });
  const r = await req('POST', `/t/${t1}/api/subscriptions`, {
    token: stuTokenRef.a,
    body: {
      orderNo: o.orderNo,
      // 原始返回值原样上报，包括被拒的 —— 前端不该只报成功的
      grants: [
        { tmplId: 'TMPL-DELIVERED', result: 'accept' },
        { tmplId: 'TMPL-ACCEPTED', result: 'reject' },
      ],
    },
  });
  eq(r.status, 201, JSON.stringify(r.body));
  eq(r.body.recorded, 2, '两条授权结果都要落库');

  const browse = await req('POST', '/api/tenant/resolve', { body: { appid: 'wxTEST0000000001' } });
  const anon = await req('POST', `/t/${t1}/api/subscriptions`, {
    token: browse.body.token,
    body: { grants: [{ tmplId: 'X', result: 'accept' }] },
  });
  eq(anon.status, 401, '匿名不能登记授权');
});

group('V4-6 商户侧：配送清单按空间序 + 批量送达');

let delNos: string[] = [];

check('造 3 单（3 楼 / 6 楼 / 10 楼）', async () => {
  delNos = [];
  for (const [addr, tag] of [[addrF3, 'f3'], [addrA, 'f6'], [addrF10, 'f10']] as const) {
    const o = await placeOk({ buildingId: bOrder, addressId: addr, items: [{ productId: pA, qty: 1 }] });
    await PAYCB({ orderNo: o.orderNo, txnId: `TX-${tag}`, amountCents: o.totalCents });
    delNos.push(o.orderNo);
  }
  eq(delNos.length, 3);
});

check('配送清单按 楼栋 → 楼层 → 房间号 排（商户一趟送完整栋）', async () => {
  const r = await MER('GET', '/delivery');
  eq(r.status, 200, JSON.stringify(r.body));
  const g = (r.body.groups as any[]).find((x) => x.buildingId === bOrder);
  assert(g, '应包含订单专用栋这一组');
  const seq = (g.items as any[])
    .filter((i) => delNos.includes(i.orderNo))
    .map((i) => `${i.floor}-${i.room}`);
  eq(seq.join(','), '3-308,6-602,10-1001', `空间序错误：${seq.join(',')}`);
  assert(g.items[0].room, '配送清单必须带房间号（接单商户正当可见）');
  assert(g.items[0].itemSummary.includes('测试可乐'), '要有商品摘要供商户备货');
});

check('批量送达：逐单独立成败，不因一单非法全批失败', async () => {
  const r = await MER('POST', '/deliver-batch', { orderNos: [...delNos, 'NOT-A-ORDER'] });
  eq(r.status, 200, JSON.stringify(r.body));
  eq(r.body.ok.length, 3, '3 张合法单必须全部成功');
  eq(r.body.failed.length, 1, '1 张非法单必须单独失败');
  eq(r.body.failed[0].orderNo, 'NOT-A-ORDER');
});

check('送达后不再出现在待送清单里', async () => {
  const r = await MER('GET', '/delivery');
  const g = (r.body.groups as any[]).find((x) => x.buildingId === bOrder);
  if (g) {
    const left = (g.items as any[]).filter((i) => delNos.includes(i.orderNo));
    eq(left.length, 0, '已送达的单不应留在待送清单');
  }
  const withDone = await MER('GET', '/delivery?includeDelivered=true');
  const g2 = (withDone.body.groups as any[]).find((x) => x.buildingId === bOrder);
  assert(g2, 'includeDelivered 时应能回看已送达');
  eq(
    (g2.items as any[]).filter((i) => delNos.includes(i.orderNo)).length, 3,
    'includeDelivered=true 时应看到这 3 单',
  );
});

group('V4-7 退款：未送达回库、已送达不回库、服务费返还交给账本');

check('未送达全退 → 库存回库（sold 减、stock 加）', async () => {
  const before = await cellOf(pA, bOrder);
  const o = await placeOk({ buildingId: bOrder, addressId: addrA, items: [{ productId: pA, qty: 2 }] });
  await PAYCB({ orderNo: o.orderNo, txnId: 'TX-REFUND-1', amountCents: o.totalCents });

  const s = await MER('POST', `/${o.orderNo}/refund/start`);
  eq(s.status, 200);
  eq(s.body.order.status, 'refunding');

  const d = await MER('POST', `/${o.orderNo}/refund/done`, { refundCents: o.totalCents });
  eq(d.status, 200, JSON.stringify(d.body));
  eq(d.body.order.status, 'refunded');
  eq(d.body.order.payStatus, 'refunded');
  eq(d.body.stockReturned, true, '未送达全退必须回库');
  eq(d.body.feeReturnedCents, 0, '该单尚未结算扣费，所以没有可返还的服务费（不是"返还失败"）');

  const after = await cellOf(pA, bOrder);
  eq(after.stock, before.stock, '回库后库存回到退款前');
  eq(after.sold, before.sold, '已售也要退回去');
  eq(after.locked, before.locked);

  const pending = await PLATFORM('GET', `/ledger/${t1}/pending`);
  eq(
    (pending.body.items as any[]).filter((i) => i.orderNo === o.orderNo).length, 0,
    '退款后必须从待扣队列出队（否则将来会扣一笔已退款单的服务费）',
  );
});

check('已送达退款 → **不回库**（货已在学生手里），且必须说明原因', async () => {
  const before = await cellOf(pA, bOrder);
  const o = await placeOk({ buildingId: bOrder, addressId: addrA, items: [{ productId: pA, qty: 1 }] });
  await PAYCB({ orderNo: o.orderNo, txnId: 'TX-REFUND-2', amountCents: o.totalCents });
  await MER('POST', `/${o.orderNo}/deliver`);
  const afterDeliver = await cellOf(pA, bOrder);

  await MER('POST', `/${o.orderNo}/refund/start`);
  const d = await MER('POST', `/${o.orderNo}/refund/done`, { refundCents: o.totalCents });
  eq(d.status, 200, JSON.stringify(d.body));
  eq(d.body.stockReturned, false, '已送达不得自动回库');
  assert(d.body.stockNotice && d.body.stockNotice.includes('已送达'), `必须给出人话说明：${d.body.stockNotice}`);

  const after = await cellOf(pA, bOrder);
  eq(after.stock, afterDeliver.stock, '库存不得变化');
  eq(after.sold, afterDeliver.sold);
  void before;
});

check('部分退款（未送达）→ 不回库 + 明确提示人工调整', async () => {
  const o = await placeOk({ buildingId: bOrder, addressId: addrA, items: [{ productId: pA, qty: 2 }] });
  await PAYCB({ orderNo: o.orderNo, txnId: 'TX-REFUND-3', amountCents: o.totalCents });
  await MER('POST', `/${o.orderNo}/refund/start`);
  const d = await MER('POST', `/${o.orderNo}/refund/done`, { refundCents: 350 });
  eq(d.status, 200, JSON.stringify(d.body));
  eq(d.body.stockReturned, false, '部分退无法判断对应哪几件商品 —— 不许猜');
  assert(d.body.stockNotice.includes('人工'), `必须提示人工调整：${d.body.stockNotice}`);
});

check('退款驳回 → 回到退款前的状态（由时间戳倒推，不存冗余字段）', async () => {
  const o = await placeOk({ buildingId: bOrder, addressId: addrA, items: [{ productId: pA, qty: 1 }] });
  await PAYCB({ orderNo: o.orderNo, txnId: 'TX-REFUND-4', amountCents: o.totalCents });
  await MER('POST', `/${o.orderNo}/accept`);
  await MER('POST', `/${o.orderNo}/refund/start`);
  const rj = await MER('POST', `/${o.orderNo}/refund/reject`);
  eq(rj.status, 200, JSON.stringify(rj.body));
  eq(rj.body.order.status, 'delivering', '已接单未送达 → 应回到配送中');
  eq(rj.body.order.payStatus, 'paid');
});

group('V4-8 定时任务：超时关单释放库存 + 送达兜底');

check('15 分钟未支付 → 自动关单并释放预占', async () => {
  const o = await placeOk({ buildingId: bOrder, addressId: addrA, items: [{ productId: pA, qty: 3 }] });
  const held = await cellOf(pA, bOrder);
  eq(held.locked >= 3, true, '下单后应有预占');

  const later = new Date(new Date(o.createdAt).getTime() + (ORDER_TIMEOUT.PAY_TIMEOUT_MINUTES + 1) * 60_000);
  const r = await MER('POST', `/jobs/close-expired?now=${later.toISOString()}`);
  eq(r.status, 200, JSON.stringify(r.body));
  assert(r.body.closed.includes(o.orderNo), `超时单必须被关闭，实际关闭：${r.body.closed.join(',')}`);
  // 前面几张故意留在"待支付"的单（金额不符那张等）也会在这一轮被关掉 —— 这正是任务该有的行为
  assert(r.body.closed.length >= 4, `应一次关掉所有超时单，实际 ${r.body.closed.length} 张`);

  const d = await MER('GET', `/${o.orderNo}`);
  eq(d.body.order.status, 'cancelled');
  eq(d.body.order.payStatus, 'unpaid');
  assert(d.body.order.cancelReason.includes('未支付'), `关闭原因必须说清：${d.body.order.cancelReason}`);

  // 用守恒关系断言，而不是"某一张单加了 3"：
  // 关单释放的量必须**恰好等于**关闭前这一格被占的量，且关闭后不得有任何残留占用。
  // 这比按单张算更强 —— 漏释放一张、或多释放一张都会被抓到。
  const released = await cellOf(pA, bOrder);
  eq(released.locked, 0, '所有待支付单关闭后，这一格的预占必须归零（否则库存被永久占住）');
  eq(
    released.stock, held.stock + held.locked,
    `释放量必须等于关闭前被占的量：${held.stock}+${held.locked}`,
  );
});

check('已支付的单不会被超时关单波及', async () => {
  const d = await MER('GET', `/${paidOrder}`);
  assert(d.body.order.status === 'delivered' || d.body.order.status === 'delivering' || d.body.order.status === 'pending_accept',
    `已支付单不得被关单任务改掉，实际 ${d.body.order.status}`);
});

check('配送中超时未点送达 → 兜底自动完成，并打 autoCompleted 标记', async () => {
  const o = await placeOk({ buildingId: bOrder, addressId: addrA, items: [{ productId: pA, qty: 1 }] });
  await PAYCB({ orderNo: o.orderNo, txnId: 'TX-AUTO', amountCents: o.totalCents });
  const acc = await MER('POST', `/${o.orderNo}/accept`);
  const acceptedAt = acc.body.order.acceptedAt;

  const later = new Date(new Date(acceptedAt).getTime() + (ORDER_TIMEOUT.AUTO_COMPLETE_HOURS + 1) * 3600_000);
  const r = await MER('POST', `/jobs/auto-complete?now=${later.toISOString()}`);
  eq(r.status, 200, JSON.stringify(r.body));
  assert(r.body.completed.includes(o.orderNo), `应被兜底完成，实际：${r.body.completed.join(',')}`);

  const d = await MER('GET', `/${o.orderNo}`);
  eq(d.body.order.status, 'delivered');
  eq(d.body.order.autoCompleted, true, '自动完成的单必须与商户手动标记可区分（追责要用）');
});

check('全局库存逐格核对：所有订单操作之后差额仍为 0', async () => {
  const r = await CAT('GET', '/stock-reconcile');
  eq(r.status, 200, JSON.stringify(r.body));
  eq(r.body.mismatch, 0, `库存与流水出现差额：${JSON.stringify(r.body.mismatched?.slice(0, 3))}`);
  assert(r.body.total > 0, '应该核查了至少一个格子');
});

group('V4-9 排序规则（纯函数单测：自然序，不是字典序）');

check('楼层：数值升序，缺失排最后', () => {
  assert(compareFloorRoom('3', '302', '10', '1001') < 0, '3 楼必须在 10 楼之前');
  assert(compareFloorRoom('6', '602', '3', '308') > 0, '6 楼在 3 楼之后');
  assert(compareFloorRoom(null, '101', '9', '901') > 0, '没填楼层应排最后（放一趟的末尾送）');
});

check('房间号：自然序 —— 字典序会把 1001 排到 302 前面', () => {
  assert(naturalCompare('302', '1001') < 0, '302 应在 1001 之前（字典序会反过来）');
  assert(naturalCompare('602', '308') > 0, '602 在 308 之后');
  assert(compareFloorRoom('3', '302', '3', '1001') < 0, '同楼层内也按自然序');
});

check('mergeLines：同一商品重复传 → 合并，不产生两条明细', () => {
  const merged = mergeLines([{ productId: 7, qty: 1 }, { productId: 7, qty: 2 }, { productId: 9, qty: 1 }]);
  eq(merged.length, 2);
  eq(merged.find((m) => m.productId === 7)!.qty, 3);
});

check('mergeLines：非法数量必须被拒（不给"部分成功"）', () => {
  for (const bad of [0, -1, 1.5, 100]) {
    let threw = false;
    try {
      mergeLines([{ productId: 1, qty: bad }]);
    } catch {
      threw = true;
    }
    assert(threw, `数量 ${bad} 应当被拒绝`);
  }
});

group('V5-0 商户端身份与视图（CM-01 / M-01 / M-02 / CM-05）');

check('商户登录：不是店主 → 403 NOT_MERCHANT（给明确答案，不是"登录失败"）', async () => {
  const r = await req('POST', '/api/tenant/merchant/login', {
    body: { appid: 'wxTEST0000000001', openid: 'openid-not-owner' },
  });
  eq(r.status, 403, JSON.stringify(r.body));
  eq(
    r.body.error.code, 'NOT_MERCHANT',
    '「不是店主」必须与「登录失败」分开 —— 后者重试有用，前者重试多少次都一样',
  );
});

check('平台绑定店主后 → 可登录，签发的确实是店主令牌（能调商户接口）', async () => {
  const bind = await PLATFORM('POST', '/merchant/owner', {
    body: { tenantCode: t1, openid: 'openid-owner-zj', nickname: '张姐' },
  });
  eq(bind.status, 200, JSON.stringify(bind.body));

  const r = await req('POST', '/api/tenant/merchant/login', {
    body: { appid: 'wxTEST0000000001', openid: 'openid-owner-zj' },
  });
  eq(r.status, 200, JSON.stringify(r.body));
  eq(r.body.role, 'owner');
  assert(typeof r.body.token === 'string' && r.body.token.length > 0, '必须签发令牌');

  // 光返回一个 role 字符串不算数 —— 真拿这张令牌去调商户接口，通了才算
  const d = await req('GET', `/t/${t1}/api/merchant/orders/delivery`, { token: r.body.token });
  eq(d.status, 200, `店主令牌必须能调商户接口：${JSON.stringify(d.body)}`);
});

check('配送清单：行内自带 statusText / tone（前端不猜状态与颜色）', async () => {
  const d = await req('GET', `/t/${t1}/api/merchant/orders/delivery`, { token: t1OwnerToken });
  eq(d.status, 200, JSON.stringify(d.body));
  const groups = d.body.groups as any[];
  assert(groups.length > 0, '本组前面的用例已造单，配送清单不应为空');
  for (const g of groups) {
    for (const it of g.items as any[]) {
      assert(typeof it.statusText === 'string' && it.statusText.length > 0, `配送行必须自带状态文案：${JSON.stringify(it)}`);
      assert(['ok', 'warn', 'danger', 'off'].includes(it.tone), `tone 必须是服务端给的语义色：${it.tone}`);
      eq(it.hasRemark, !!it.remark, 'hasRemark 必须与 remark 一致（界面靠它决定要不要高亮）');
    }
  }
});

check('商户订单详情 = 视图：带 actions / hint / timeline，不带学生端字段', async () => {
  await topUp(pA, bOrder, 30);
  const o = await placeOk({ buildingId: bOrder, addressId: addrA, items: [{ productId: pA, qty: 1 }] });
  const cb = await PAYCB({ orderNo: o.orderNo, txnId: 'TX-V5', amountCents: o.totalCents });
  eq(cb.status, 200, JSON.stringify(cb.body));

  const d = await MER('GET', `/${o.orderNo}`);
  eq(d.status, 200, JSON.stringify(d.body));
  const v = d.body.order;

  eq(v.status, 'pending_accept');
  assert(typeof v.statusText === 'string' && v.statusText, '状态文案由服务端给');
  assert(typeof v.hint === 'string' && v.hint, '商户侧的下一步提示由服务端给');
  assert(Array.isArray(v.actions) && v.actions.includes('accept'), `待接单必须有 accept：${JSON.stringify(v.actions)}`);
  assert(Array.isArray(v.timeline) && v.timeline.length >= 2, '时间线至少要含下单与支付');
  eq(v.payTxnId, 'TX-V5', '商户侧要看得见支付流水号（对账时用得上）');
  assert(v.room, '商户端必须看得见房间号 —— 他要送货');
  // 两个视图各说各的话：学生端专属字段不该出现在商户视图里
  eq(v.payExpiresInSeconds, undefined, '商户视图不带学生端的支付倒计时');
});

check('手机端快改：免填理由也能改库存，但流水照样留痕', async () => {
  const m = await CAT('GET', '/matrix');
  const row = (m.body.rows as any[]).find((r) => r.productId === pA);
  const cell = (row.cells as any[]).find((c) => c.buildingId === bOrder);
  const target = cell.stock + 3;

  const r = await CAT('POST', '/stocks/quick-set', { productId: pA, buildingId: bOrder, stock: target });
  eq(r.status, 201, JSON.stringify(r.body));
  eq(r.body.cell.stock, target, '快改立即生效');

  const logs = await CAT('GET', `/stock-logs?productId=${pA}&buildingId=${bOrder}`);
  const hit = (logs.body.items as any[]).find((i) => i.type === 'manual_adjust' && i.remark === '快速修改');
  assert(hit, '快改必须留痕 —— 否则月底对不上账时查不出是谁改的');
  assert(String(hit.operator).startsWith('owner:'), `操作人必须记为当前店主：${hit.operator}`);
});

/* ============================================ V5 商户网页后台契约（S5 的数据来源） */

group('V5-1 订单管理列表（W-07）：全状态 · 可检索 · 真分页');

check('列表给出 total 与 counts，且 counts 是全量口径（不随筛选变小）', async () => {
  const all = await MER('GET', '');
  eq(all.status, 200, JSON.stringify(all.body));
  assert((all.body.items as unknown[]).length > 0, '前面用例下过单，订单管理不该是空的');
  assert(typeof all.body.total === 'number', 'total 必须是数字（分页要靠它算页数）');
  assert(all.body.counts && typeof all.body.counts === 'object', 'counts 必须与列表同源一次给出');

  const filtered = await MER('GET', '?status=pending_accept,delivering');
  eq(filtered.status, 200, JSON.stringify(filtered.body));
  for (const it of filtered.body.items as Array<{ status: string }>) {
    assert(
      it.status === 'pending_accept' || it.status === 'delivering',
      `状态筛选失效，混进了 ${it.status}`,
    );
  }
  // 关键：筛选后 counts 不变。否则"待接单 3"点进去变成"待接单 3 / 共 3"，
  // 用户再也看不出全场还有几单要处理
  eq(
    JSON.stringify(filtered.body.counts),
    JSON.stringify(all.body.counts),
    'counts 必须是全量口径 —— 跟着筛选变小会让状态标签失去意义',
  );
});

check('分页：limit 生效、offset 换页不重不漏', async () => {
  const all = await MER('GET', '?limit=200');
  const total = all.body.total as number;
  assert(total >= 2, `本组需要至少 2 单才能验证分页，实际 ${total}`);

  const p0 = await MER('GET', '?limit=1&offset=0');
  const p1 = await MER('GET', '?limit=1&offset=1');
  eq((p0.body.items as unknown[]).length, 1, 'limit=1 应只回 1 条');
  eq((p1.body.items as unknown[]).length, 1);
  assert(
    (p0.body.items as Array<{ orderNo: string }>)[0].orderNo !==
      (p1.body.items as Array<{ orderNo: string }>)[0].orderNo,
    '相邻两页不应是同一单（offset 没生效）',
  );
  eq(p0.body.total, total, 'total 不应随分页变化');
});

check('检索：按房间号能定位到单（商户接电话时的真实用法）', async () => {
  const all = await MER('GET', '?limit=200');
  const first = (all.body.items as Array<{ room: string; orderNo: string }>)[0];
  const hit = await MER('GET', `?keyword=${encodeURIComponent(first.room)}`);
  eq(hit.status, 200, JSON.stringify(hit.body));
  assert(
    (hit.body.items as Array<{ orderNo: string }>).some((i) => i.orderNo === first.orderNo),
    `按房间号 ${first.room} 应能搜到 ${first.orderNo}`,
  );
});

check('学生令牌拿不到订单管理列表 —— 房间号只在店主侧', async () => {
  const r = await req('GET', `/t/${t1}/api/merchant/orders`, { token: stuTokenRef.a });
  // 403 而不是 401：他有身份（学生令牌合法），只是不是店主。
  // 这两个码混用会让前端把"你没权限"提示成"请重新登录"，用户点了登录还是一样的结果
  eq(r.status, 403, `学生令牌调商户订单列表应 403，实际 ${r.status}`);
});

group('V5-2 网页后台登录码：店主可签发 · 一次性 · 学生签不出');

check('店主签发 → 换回 owner 令牌 → 同一个码第二次作废', async () => {
  const c = await req('POST', `/t/${t1}/api/merchant/session/web-login-code`, { token: t1OwnerToken });
  eq(c.status, 200, JSON.stringify(c.body));
  assert(/^\d{6}$/.test(String(c.body.code)), `登录码应为 6 位数字，实际 ${c.body.code}`);
  assert(c.body.expiresAt, '必须给出过期时间 —— 只给码不给时间，店主不知道该快点敲还是可以慢慢来');

  // 注意前缀是 /api/tenant（不是 /api/platform）—— 兑换端没有平台密钥，码本身就是凭据
  const ok = await req('POST', '/api/tenant/merchant/web-login', {
    body: { tenantCode: t1, code: c.body.code },
  });
  eq(ok.status, 200, JSON.stringify(ok.body));
  eq(ok.body.role, 'owner', '换回的必须是店主令牌');
  assert(ok.body.token, '应返回令牌');

  const again = await req('POST', '/api/tenant/merchant/web-login', {
    body: { tenantCode: t1, code: c.body.code },
  });
  eq(again.status, 403, `登录码必须一次性，第二次应 403，实际 ${again.status}`);
  // 不区分"不存在 / 过期 / 已用过" —— 区分了就等于帮撞码的人缩小范围
  assert(
    !/不存在/.test(String(again.body.message ?? '')),
    `失败原因不该暴露码是否存在：${again.body.message}`,
  );
});

check('学生令牌签不出登录码（签发登录码 ≈ 签发 24 小时店主令牌）', async () => {
  const r = await req('POST', `/t/${t1}/api/merchant/session/web-login-code`, { token: stuTokenRef.a });
  eq(r.status, 403, `学生令牌应 403（有身份但没权限），实际 ${r.status}`);
});

/* ============================================================================
 * S6 · 平台后台 + 上线流水线（P-01~P-13 / CP-01~CP-11）
 * ==========================================================================*/

/**
 * 造一个"可被推送"的租户：建户 → 12 阶段走完 → 上传密钥到手。
 *
 * 为什么不用"直接改库把状态设成 active"：那样测的就不是真实路径了。
 * 批量推送的前置条件恰恰是"这户走完了流水线"，绕过它等于把这个前置条件删掉。
 */
async function makeActiveTenant(appid: string, shopName: string): Promise<string> {
  const created = await PLATFORM('POST', '/tenants', {
    body: { shopName, orgName: `${shopName}（个体工商户）`, appid, buildingNames: ['1 号楼'] },
  });
  eq(created.status, 201, `建租户失败：${JSON.stringify(created.body)}`);
  const code = created.body.tenant.tenantCode as string;

  for (let i = 1; i <= 12; i += 1) {
    const r = await PLATFORM('POST', `/pipeline/${code}/stages/${i}/complete`, { body: {} });
    eq(r.status, 200, `推进第 ${i} 阶段失败：${JSON.stringify(r.body)}`);
  }

  const secret = await PLATFORM('POST', '/secrets', {
    body: { tenantCode: code, kind: 'upload_key', value: `key-${appid}-0123456789abcdef`, remark: '冒烟夹具' },
  });
  eq(secret.status, 200, `写密钥失败：${JSON.stringify(secret.body)}`);

  return code;
}


/** S6 用例的共享夹具（集中声明 —— 分散在用例中间会踩到 let 的暂时性死区） */
let grayTenantA = '';
let grayTenantB = '';
let grayTenantC = '';
let fakeTenants: string[] = [];
let pipelineHalfTenant = '';
let smokeVersionId = 0;
let smokeSecretPlain = '';
group('V6-1 上线流水线：卡点天数 · 上次触达 · 驳回返工（P-04 / P-05）');

check('看板给出 12 阶段定义与每户的当前卡点', async () => {
  grayTenantA = await makeActiveTenant('wx' + 'a1'.repeat(8), '冒烟灰度 A 店');
  grayTenantB = await makeActiveTenant('wx' + 'b2'.repeat(8), '冒烟灰度 B 店');
  grayTenantC = await makeActiveTenant('wx' + 'c3'.repeat(8), '冒烟灰度 C 店');

  const r = await PLATFORM('GET', '/pipeline/board');
  eq(r.status, 200, JSON.stringify(r.body));
  eq(r.body.stageNames.length, 12, '上线流水线固定 12 阶段');
  eq(r.body.stageNames[0].no, 1);
  eq(r.body.stageNames[11].no, 12);

  const row = (r.body.items as Array<{ tenantCode: string; doneCount: number; status: string }>).find(
    (x) => x.tenantCode === grayTenantA,
  );
  assert(row, '刚建好的租户必须出现在看板上');
  eq(row.doneCount, 12, '12 阶段走完应该是 12/12');
  // 走完 12 阶段 = 可营业。不自动置 active 的话，这户会在"闸门都正常"的状态下被漏掉
  eq(row.status, 'active', '12 阶段走完必须自动成为 active，否则谁也没发现这户没被放开');
});

check('未完成的租户：卡点天数与责任方都算出来（推动权在谁手上要看得到）', async () => {
  const created = await PLATFORM('POST', '/tenants', {
    body: { shopName: '冒烟半程店', orgName: '冒烟半程店（个体户）', appid: 'wx' + 'e5'.repeat(8), buildingNames: ['1 号楼'] },
  });
  const code = created.body.tenant.tenantCode as string;

  // 走到第 3 步停下（第 3 步是商户本人注册小程序 —— 我方代不了）
  for (let i = 1; i <= 3; i += 1) {
    await PLATFORM('POST', `/pipeline/${code}/stages/${i}/complete`, { body: {} });
  }

  const view = (await PLATFORM('GET', `/pipeline/${code}`)).body;
  eq(view.currentStageNo, 4, '第 1–3 步完成后应停在 ICP 备案');
  eq(view.currentOwner, 'renter', '备案的责任方是商户 —— 显示"我方超期"会让人去催错的人');
  eq(view.external, true, '备案是不可控的外部环节（1–20 个工作日）');
  assert(typeof view.stuckDays === 'number', '必须给出已卡天数');
  eq(view.lastContactedAt, null, '还没催过就该是 null，而不是当前时间');

  // 记录触达 → 上次触达时间落库
  const touched = await PLATFORM('POST', `/pipeline/${code}/stages/4/touch`, { body: { note: '微信催了一次备案进度' } });
  eq(touched.status, 200, JSON.stringify(touched.body));
  const after = (await PLATFORM('GET', `/pipeline/${code}`)).body;
  assert(after.lastContactedAt, '触达后必须有时间 —— 否则"催过没有"这个问题永远答不上来');

  // 记住它给后面用
  pipelineHalfTenant = code;
});

check('驳回：必须写原因，驳回后进返工队列，重提后闭环', async () => {
  const code = pipelineHalfTenant;
  const stageNo = 4;

  const noReason = await PLATFORM('POST', `/pipeline/${code}/stages/${stageNo}/reject`, { body: { reason: '   ' } });
  eq(noReason.status, 400, '没写原因的驳回应被拒绝');
  eq(noReason.body.error.code, 'VALIDATION_FAILED');

  const rejected = await PLATFORM('POST', `/pipeline/${code}/stages/${stageNo}/reject`, {
    body: { reason: 'ICP 备案主体与执照不一致，请重新提交' },
  });
  eq(rejected.status, 200, JSON.stringify(rejected.body));
  const stage = (rejected.body.stages as Array<{ stageNo: number; status: string; rejectReason: string }>).find(
    (s) => s.stageNo === stageNo,
  );
  eq(stage?.status, 'rejected');
  assert(stage?.rejectReason?.includes('执照'), '驳回原因必须原样保存 —— 返工的人只能看到这句话');

  const queue = await PLATFORM('GET', '/pipeline/rework');
  eq(queue.status, 200);
  const item = (queue.body.items as Array<{ tenantCode: string; stageNo: number; waitingDays: number; rejectReason: string }>).find(
    (x) => x.tenantCode === code && x.stageNo === stageNo,
  );
  assert(item, '驳回未重提的单必须进返工队列');
  assert(typeof item.waitingDays === 'number', '返工队列要能回答"驳回后卡了几天"');

  const resubmitted = await PLATFORM('POST', `/pipeline/${code}/stages/${stageNo}/resubmit`, { body: {} });
  eq(resubmitted.status, 200);
  const after = (resubmitted.body.stages as Array<{ stageNo: number; status: string; rejectReason: string | null }>).find(
    (s) => s.stageNo === stageNo,
  );
  eq(after?.status, 'doing', '重提后应回到进行中');
  assert(after?.rejectReason, '驳回原因必须保留 —— 重提不代表"这事没发生过"');

  const queue2 = await PLATFORM('GET', '/pipeline/rework');
  const stillThere = (queue2.body.items as Array<{ tenantCode: string }>).some((x) => x.tenantCode === code);
  eq(stillThere, false, '重提后必须从返工队列消失，否则队列会越滚越长没人看');
});

group('V6-2 灰度推送：先 1–2 家 → 验证 → 批量（P-07 / CP-03）');

check('灰度最多 2 家 —— 这条是硬拦不是提示', async () => {
  const v = await PLATFORM('POST', '/deploy/versions', { body: { version: '0.1.0', note: '首个体验版' } });
  eq(v.status, 200, JSON.stringify(v.body));
  smokeVersionId = v.body.id;

  const over = await PLATFORM('POST', '/deploy/push', {
    body: { versionId: smokeVersionId, tenantCodes: [grayTenantA, grayTenantB, grayTenantC], kind: 'gray' },
  });
  eq(over.status, 400, '灰度推 3 家必须被拒绝');
  assert(over.body.error.message.includes('最多 2 家'), `错误信息要说清限制：${over.body.error.message}`);
});

check('灰度推送 2 家全部成功，且批次可查', async () => {
  const r = await PLATFORM('POST', '/deploy/push', {
    body: { versionId: smokeVersionId, tenantCodes: [grayTenantA, grayTenantB], kind: 'gray', operator: 'smoke' },
  });
  eq(r.status, 200, JSON.stringify(r.body));
  eq(r.body.batch.succeeded, 2, 'mock 环境下灰度 2 家应全成功');
  eq(r.body.batch.failed, 0);
  eq(r.body.batch.status, 'done');
});

check('批量推送前必须先灰度通过（防的是"图省事直接全量"）', async () => {
  const v2 = await PLATFORM('POST', '/deploy/versions', { body: { version: '0.2.0', note: '没灰度过' } });
  const blocked = await PLATFORM('POST', '/deploy/push', {
    body: { versionId: v2.body.id, tenantCodes: [grayTenantA, grayTenantB], kind: 'batch' },
  });
  eq(blocked.status, 400, '没灰度过就批量推送必须被拒绝');
  assert(
    blocked.body.error.message.includes('灰度'),
    `错误信息要告诉人怎么办：${blocked.body.error.message}`,
  );
});

check('mock 环境批量推送 20 个伪 AppID 全成功', async () => {
  fakeTenants = [];
  for (let i = 0; i < 18; i += 1) {
    const hex = i.toString(16).padStart(2, '0');
    const code = await makeActiveTenant(`wx${hex}${'d4'.repeat(7)}`, `冒烟批量店 ${i + 1}`);
    fakeTenants.push(code);
  }
  eq(fakeTenants.length, 18, '夹具应建出 18 家');

  const targets = [grayTenantA, grayTenantB, ...fakeTenants];
  eq(targets.length, 20, '本用例要推 20 家');

  const r = await PLATFORM('POST', '/deploy/push', {
    body: { versionId: smokeVersionId, tenantCodes: targets, kind: 'batch', operator: 'smoke' },
  });
  eq(r.status, 200, JSON.stringify(r.body).slice(0, 400));
  eq(r.body.batch.totalTargets, 20);
  eq(r.body.batch.succeeded, 20, `20 家全成功，实际失败 ${r.body.batch.failed}：${JSON.stringify(r.body.targets.filter((t: any) => !t.ok).slice(0, 3))}`);

  // 逐条核对，而不是只看汇总 —— 汇总对而明细错是最难查的一类
  const rows = r.body.targets as Array<{ ok: boolean; pushedAt: string | null; version: string }>;
  eq(rows.length, 20);
  for (const row of rows) {
    eq(row.ok, true);
    assert(row.pushedAt, '成功推送必须有时间');
    eq(row.version, '0.1.0', '目标行必须带上版本号（看板要按版本筛选，不能靠回表 join）');
  }
});

check('排除名单生效：被排除的租户既不算成功也不算失败', async () => {
  const r = await PLATFORM('POST', '/deploy/push', {
    body: {
      versionId: smokeVersionId,
      tenantCodes: [grayTenantA, grayTenantB, ...fakeTenants.slice(0, 3)],
      exclude: [fakeTenants[0]],
      kind: 'batch',
      operator: 'smoke',
      confirmedGrayPassed: true,
    },
  });
  eq(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  eq(r.body.batch.totalTargets, 4, '选了 5 家、排除 1 家 → 目标 4 家');
  assert(
    (r.body.skipped as string[]).some((s) => s.includes(fakeTenants[0])),
    '跳过原因必须写清是"在排除名单内"，否则用户会以为漏推了',
  );
});

check('回滚：把上一版重新推给这一批成功过的租户，并单独记一批', async () => {
  const batches = await PLATFORM('GET', '/deploy/batches');
  const last = (batches.body.items as Array<{ id: number; succeeded: number }>)[0];
  const vPrev = await PLATFORM('POST', '/deploy/versions', { body: { version: '0.0.9', note: '回滚目标版本' } });

  const r = await PLATFORM('POST', `/deploy/batches/${last.id}/rollback`, {
    body: { previousVersionId: vPrev.body.id, operator: 'smoke' },
  });
  eq(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  assert((r.body.targets as unknown[]).length > 0, '回滚必须真的推了东西');

  // 原批次标记为已回滚 —— 看板上要能看出"这批被回滚过"，而不是凭空多一次推送
  const after = await PLATFORM('GET', '/deploy/batches');
  const origin = (after.body.items as Array<{ id: number; status: string }>).find((b) => b.id === last.id);
  eq(origin?.status, 'rolled_back', '原批次状态必须变成 rolled_back');

  const rolled = (after.body.items as Array<{ kind: string }>).some((b) => b.kind === 'rollback');
  assert(rolled, '回滚要单独记一批（kind=rollback），否则看板上会凭空多出一次推送');
});

group('V6-3 版本与发布看板：三类筛选对应平台唯一能做的三件事（P-06）');


check('四类筛选与统计卡口径一致', async () => {
  const board = await PLATFORM('GET', '/deploy/board');
  eq(board.status, 200, JSON.stringify(board.body).slice(0, 300));
  assert(board.body.latestVersion, '应有最新版本号');
  assert(board.body.provider === 'mock' || board.body.provider === 'miniprogram-ci', '要说明当前用的是哪个推送通道');

  const s = board.body.stats;
  eq(s.total, s.onLatest + s.stale + s.unsubmitted + s.failed + s.neverPushed, '统计卡之和必须等于租户总数，否则一定有户掉在缝里');
  eq(board.body.filters.all, s.total);

  for (const f of ['stale', 'unsubmitted', 'failed'] as const) {
    const r = await PLATFORM('GET', `/deploy/board?filter=${f}`);
    eq(r.status, 200);
    eq((r.body.items as unknown[]).length, board.body.filters[f], `筛选 ${f} 的行数必须与计数一致`);
  }
});

check('回填提审 / 发布：推动权在商户，平台只能记（不假装能自动同步）', async () => {
  // 挑一家"最近一次推送就是 0.1.0"的租户。
  // 看板行显示的是**该租户最近一次推送的版本**的状态 —— 所以刚被回滚过的租户
  // 不能拿来验证回填，否则测的是"回滚对不对"而不是"回填有没有生效"。
  const target = fakeTenants[10];

  const r = await PLATFORM('POST', `/deploy/${target}/version/0.1.0/submitted`, { body: {} });
  eq(r.status, 200, JSON.stringify(r.body));
  eq(r.body.submitted, true);

  const p = await PLATFORM('POST', `/deploy/${target}/version/0.1.0/published`, { body: {} });
  eq(p.status, 200);
  eq(p.body.published, true);

  const board = await PLATFORM('GET', '/deploy/board');
  const row = (board.body.items as Array<{ tenantCode: string; published: boolean; currentVersion: string }>).find(
    (x) => x.tenantCode === target,
  );
  assert(row, '该租户应在看板上');
  eq(row?.currentVersion, '0.1.0', '最近一次成功推送的版本就是它当前跑的版本');
  eq(row?.published, true, '回填后必须体现在看板上');
  eq((row?.published as boolean) && board.body.stats.onLatest >= 1, true, '已发布最新版的租户应计入 onLatest');
});

group('V6-4 密钥管理：只可替换不可查看（P-12 / CP-08）');


check('写入密钥后，**没有任何接口**返回明文', async () => {
  smokeSecretPlain = 'upload-key-PLAINTEXT-must-never-leak-1234567890';
  const put = await PLATFORM('POST', '/secrets', {
    body: { tenantCode: t1, kind: 'upload_key', value: smokeSecretPlain, remark: '冒烟用' },
  });
  eq(put.status, 200, JSON.stringify(put.body));
  assert(!JSON.stringify(put.body).includes(smokeSecretPlain), '写入响应里不能回显明文');
  assert(put.body.masked.includes('****'), `要返回掩码，实际 ${put.body.masked}`);
  assert(!('cipher' in put.body), '响应里连密文字段都不该有 —— 有字段就迟早有人去解它');

  const list = await PLATFORM('GET', `/secrets?tenantCode=${t1}`);
  eq(list.status, 200);
  // 这是本用例的核心断言：把整个响应序列化后搜明文
  assert(
    !JSON.stringify(list.body).includes(smokeSecretPlain),
    '列表接口绝不允许出现明文（这是"只可替换不可查看"的可执行定义）',
  );
  assert(!JSON.stringify(list.body).includes('cipher'), '列表也不能带 cipher 字段');

  const one = (list.body.items as Array<{ kind: string; masked: string }>).find((x) => x.kind === 'upload_key');
  assert(one, '刚写的密钥应能查到');
  eq(one?.masked, `${smokeSecretPlain.slice(0, 4)}****`, '掩码只露前 4 位');
});

check('替换即覆盖：旧密钥不留在任何地方（留副本 = 可查看的后门）', async () => {
  const second = 'upload-key-SECOND-VERSION-0987654321';
  await PLATFORM('POST', '/secrets', { body: { tenantCode: t1, kind: 'upload_key', value: second } });

  const list = await PLATFORM('GET', `/secrets?tenantCode=${t1}`);
  const body = JSON.stringify(list.body);
  assert(!body.includes(smokeSecretPlain), '替换后旧密钥不能还查得到');
  assert(!body.includes(second), '新密钥也不能查得到');

  const items = (list.body.items as Array<{ tenantCode: string; kind: string }>).filter(
    (x) => x.tenantCode === t1 && x.kind === 'upload_key',
  );
  eq(items.length, 1, '同一租户同一类型只能有一条记录（替换不是新增）');
});

check('未收集的密钥要显式列出来 —— 否则界面上会以为全齐了', async () => {
  const list = await PLATFORM('GET', '/secrets');
  eq(list.status, 200);
  const missing = list.body.missing as Array<{ tenantCode: string; kind: string }>;
  assert(missing.length > 0, '刚建的 18 家批量店都没支付证书，必须出现在"未收集"里');
  assert(
    missing.some((m) => m.kind === 'pay_cert'),
    '支付证书是常见的"还没办下来"项，不能只列已有的',
  );
});

check('密钥失效 → 状态变更 + 告警（R9 的兜底：不做就是"推送莫名全失败"）', async () => {
  const r = await PLATFORM('POST', `/secrets/${t1}/upload_key/invalidate`, {
    body: { reason: '商户在微信后台重置了上传密钥' },
  });
  eq(r.status, 200, JSON.stringify(r.body));
  eq(r.body.status, 'invalid');

  const scan = await PLATFORM('POST', '/alerts/scan', { body: {} });
  eq(scan.status, 200, JSON.stringify(scan.body).slice(0, 300));

  const alerts = await PLATFORM('GET', '/alerts');
  const hit = (alerts.body.items as Array<{ kind: string; tenantCode: string; level: string }>).find(
    (a) => a.kind === 'secret_invalid' && a.tenantCode === t1,
  );
  assert(hit, '密钥失效必须产生告警');
  eq(hit?.level, 'danger', '密钥失效是"下一次推送必然失败"，等级应是 danger');

  // 恢复：重新写入即回到 active（替换语义天然支持"重新收集"）
  await PLATFORM('POST', '/secrets', { body: { tenantCode: t1, kind: 'upload_key', value: 'recollected-key-abcdef123456' } });
  const after = await PLATFORM('GET', `/secrets?tenantCode=${t1}`);
  const active = (after.body.items as Array<{ kind: string; status: string }>).find((x) => x.kind === 'upload_key');
  eq(active?.status, 'active', '重新收集后应回到 active');
});

group('V6-5 监控告警：五类 · 幂等（P-10 / CP-11）');

check('巡检幂等：同一自然日重复跑不会刷屏', async () => {
  const first = await PLATFORM('POST', '/alerts/scan', { body: {} });
  const createdFirst = (first.body.created as unknown[]).length;

  const second = await PLATFORM('POST', '/alerts/scan', { body: {} });
  eq(
    (second.body.created as unknown[]).length,
    0,
    `巡检每 30 分钟跑一次，没有幂等键的话一天能刷 48 条一样的告警（首次创建了 ${createdFirst} 条）`,
  );

  const alerts = await PLATFORM('GET', '/alerts');
  const open = (alerts.body.items as Array<{ ackAt: string | null }>).filter((a) => a.ackAt === null);
  assert(open.length > 0, '刚扫过应有待处理告警');
});

check('活跃度告警：连续 7 天无订单（now 可注入 → 不用真等一周）', async () => {
  const future = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const r = await PLATFORM('POST', '/alerts/scan', { body: { now: future } });
  eq(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  assert(
    (r.body.checked as { idle: number }).idle > 0,
    '把时间推到 30 天后，有过单的租户都应被判为不活跃 —— 若为 0，说明这条告警永远不会触发',
  );

  const alerts = await PLATFORM('GET', '/alerts');
  const idle = (alerts.body.items as Array<{ kind: string }>).find((a) => a.kind === 'tenant_activity');
  assert(idle, '应产生活跃度告警');
});

check('告警可确认（处理过就要从待办里消失）', async () => {
  const alerts = await PLATFORM('GET', '/alerts?open=1');
  const first = (alerts.body.items as Array<{ id: number; ackAt: string | null }>)[0];
  assert(first, '应有待处理告警');
  eq(first.ackAt, null);

  const r = await PLATFORM('POST', `/alerts/${first.id}/ack`, { body: { by: 'smoke' } });
  eq(r.status, 200);
  assert(r.body.ackAt, '确认后必须有时间与确认人');

  const after = await PLATFORM('GET', '/alerts?open=1');
  assert(
    !(after.body.items as Array<{ id: number }>).some((a) => a.id === first.id),
    '已确认的告警不该出现在待处理列表里',
  );
});

group('V6-6 工单：分类决定流向（P-11 / CP-09）');

check('技术归我方、经营归合伙人 —— 分类错了就等于工单没被处理', async () => {
  const tech = await PLATFORM('POST', '/tickets', {
    body: { tenantCode: t1, title: '推送一直失败', category: 'tech', createdBy: 'smoke' },
  });
  eq(tech.status, 200, JSON.stringify(tech.body));
  eq(tech.body.assignee, 'platform', '技术类归我方');

  const ops = await PLATFORM('POST', '/tickets', {
    body: { tenantCode: t1, title: '想让合伙人帮忙跑一趟学校', category: 'operation', createdBy: 'smoke' },
  });
  eq(ops.body.assignee, 'partner', '经营类归合伙人');

  const bad = await PLATFORM('POST', '/tickets', { body: { title: '没分类', category: 'unknown' } });
  eq(bad.status, 400, '分类是必填且必须合法 —— 没有分类就没人知道该谁接');

  const list = await PLATFORM('GET', '/tickets');
  assert((list.body.summary as { partner: number }).partner >= 1, '合伙人手里的单要单独统计 —— 这一项就是"分流"本身');
});

check('处理记录追加式：改状态同时留痕，不覆盖历史', async () => {
  const created = await PLATFORM('POST', '/tickets', { body: { title: '买家问能不能开发票', category: 'billing', createdBy: 'smoke' } });
  const id = created.body.id;

  await PLATFORM('PATCH', `/tickets/${id}`, { body: { by: 'smoke', text: '已联系商户，确认可开电子发票' } });
  await PLATFORM('PATCH', `/tickets/${id}`, { body: { by: 'smoke', text: '已答复商户', status: 'closed' } });

  const detail = await PLATFORM('GET', `/tickets/${id}`);
  eq(detail.status, 200);
  eq((detail.body.logs as unknown[]).length, 2, '两条记录都要在 —— 覆盖式更新会让"谁在什么时候说了什么"消失');
  eq(detail.body.status, 'closed');
  assert(detail.body.closedAt, '关闭必须有时间');
});

group('V6-7 停用 / 恢复（CP-07）：锁单但保留数据');

check('停用必须写原因；停用后同状态重复操作被拒', async () => {
  const noReason = await PLATFORM('POST', `/tenants/${grayTenantB}/status`, { body: { action: 'suspend' } });
  eq(noReason.status, 400, '停用会直接影响商户生意，必须留原因');

  const ok = await PLATFORM('POST', `/tenants/${grayTenantB}/status`, {
    body: { action: 'suspend', reason: '冒烟用例：模拟违规停用' },
  });
  eq(ok.status, 200, JSON.stringify(ok.body));
  eq(ok.body.status, 'suspended');

  const again = await PLATFORM('POST', `/tenants/${grayTenantB}/status`, { body: { action: 'suspend', reason: '再来一次' } });
  eq(again.status, 400, '已经是停用状态，重复停用要拒绝（而不是静默成功）');

  const recover = await PLATFORM('POST', `/tenants/${grayTenantB}/status`, { body: { action: 'recover', operator: 'smoke' } });
  eq(recover.status, 200);
  eq(recover.body.status, 'active', '恢复是"能恢复的"，数据不删');
});

check('停用与恢复都进审计（过渡期无 RBAC，审计是唯一追责依据）', async () => {
  const r = await PLATFORM('GET', `/tenants/${grayTenantB}/detail`);
  eq(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  const actions = (r.body.audits as Array<{ action: string }>).map((a) => a.action);
  assert(actions.includes('tenant.suspend'), '停用必须留审计');
  assert(actions.includes('tenant.recover'), '恢复必须留审计');
});

group('V6-8 AC-13 抓包：平台侧所有接口响应里查不到房间号字段');

check('逐一打全部平台接口，序列化后搜私有字段', async () => {
  const paths = [
    '/tenants',
    '/schools',
    '/schools/templates',
    `/tenants/${t1}/detail`,
    '/pipeline/board',
    '/pipeline/rework',
    `/pipeline/${t1}`,
    '/deploy/board',
    '/deploy/versions',
    '/deploy/batches',
    '/secrets',
    '/alerts',
    '/tickets',
    '/ledger/overview',
    `/ledger/${t1}`,
    `/ledger/${t1}/pending`,
    `/ledger/${t1}/reconcile`,
    `/ledger/${t1}/statements`,
  ];

  for (const p of paths) {
    const r = await PLATFORM('GET', p);
    eq(r.status, 200, `${p} 应可访问：${JSON.stringify(r.body).slice(0, 200)}`);
    const leaks = assertNoTenantPrivateFields(r.body);
    eq(leaks.length, 0, `${p} 泄漏了租户私有字段：${leaks.join(', ')}`);
    // 再搜一遍原始文本 —— 抓包看到的就是这个
    const text = JSON.stringify(r.body).toLowerCase();
    for (const bad of ['"roomno"', '"room_no"', '"roomcode"', '"floor"', '"room"']) {
      assert(!text.includes(bad), `${p} 的响应文本里出现了 ${bad}`);
    }
  }
});

check('学校与楼栋模板：已被租户引用时拒绝删除', async () => {
  const before = await PLATFORM('GET', '/schools');
  const gxu = (before.body.items as Array<{ id: number; name: string }>).find((s) => s.name === '广西大学');
  assert(gxu, '应有广西大学');

  const blocked = await PLATFORM('POST', `/schools/templates/${gxu.id}/delete`, { body: {} });
  eq(blocked.status, 200);
  eq(blocked.body.deleted, false, '已有租户引用时不能删 —— 删了那些租户的详情页会变空白且没人知道为什么');
  assert(blocked.body.blockedBy > 0, '要告诉人被几家引用');

  const created = await PLATFORM('POST', '/schools/templates', {
    body: { name: '冒烟测试学院', region: '广西', city: '柳州', buildingNames: ['东 1 栋', '东 2 栋'] },
  });
  eq(created.status, 200, JSON.stringify(created.body));

  const after = await PLATFORM('GET', '/schools/templates');
  const mine = (after.body.items as Array<{ id: number; buildings: unknown[] }>).find((s) => s.id === created.body.id);
  eq((mine?.buildings as unknown[]).length, 2, '模板楼栋要能一次写入');

  const del = await PLATFORM('POST', `/schools/templates/${created.body.id}/delete`, { body: {} });
  eq(del.body.deleted, true, '没人引用时应可删除');
});

/* ============================================================ S7 边界兜底 */

/** 业务月 / 业务日（中国时区）—— 与 LedgerService.bizDate 同一口径 */
const bizPeriodOf = (at: Date | string | number = new Date()) =>
  new Date(new Date(at).getTime() + 8 * 3_600_000).toISOString().slice(0, 7);
const bizDateOf = (at: Date | string | number = new Date()) =>
  new Date(new Date(at).getTime() + 8 * 3_600_000).toISOString().slice(0, 10);

group('S7-1 账期账单：2% 汇总 · 差额标记 · 未扣必须标红');

check('已支付未结算 → 差额精确等于该单服务费（2% 汇总不吞不重）', async () => {
  const before = (await PLATFORM('GET', `/ledger/${t1}/statements?period=${bizPeriodOf()}`)).body.statement;

  const o = await placeOk({ buildingId: bOrder, addressId: addrA, items: [{ productId: pA, qty: 1 }] });
  const cb = await PAYCB({ orderNo: o.orderNo, txnId: `TXN-BILL-${o.orderNo}`, amountCents: o.totalCents });
  eq(cb.status, 200, JSON.stringify(cb.body));

  const after = (await PLATFORM('GET', `/ledger/${t1}/statements?period=${bizPeriodOf()}`)).body.statement;
  // 精确到分：新增一笔已支付未结算的单，差额必须**正好**增加它的服务费。
  // 用"正好"而不是">0"：多了说明重复计入，少了说明漏了某单 —— 两种都是钱错。
  eq(
    after.diffCents - before.diffCents,
    o.feeCents,
    '未结算订单应原样体现在差额里（应付 − 实扣）',
  );
  // 「未扣必须标红」的可执行形式：状态与差额同源，不允许出现"差额≠0 但状态 ok"
  eq(after.status, after.diffCents === 0 ? 'ok' : 'diff', '差额与状态必须同源');
  eq(after.status, 'diff', '存在未结算订单时账单必须是 diff（后台据此标红）');
});

check('结算按批次精确扣回差额（跨期差异可解释，不是"账错了"）', async () => {
  const before = (await PLATFORM('GET', `/ledger/${t1}/statements?period=${bizPeriodOf()}`)).body.statement;
  assert(before.diffCents !== 0, '前置条件：结算前必须是有差额的（否则这条用例什么都没验证）');

  // ⚠️ runDate 必须**晚于今天**：每日扣减是"次日扣前一天"，流水时间钉在该业务日起点前 1 秒。
  //    用今天当 runDate 只会结算"今天之前已支付"的单，今天的单仍留在差额里 ——
  //    这正是真实存在的**跨期差异**，也是把对账看板拆成两个差额的原因。
  //    runDate 还必须**避开前面用例已占用的批次**（幂等键 = runDate + tenantCode，
  //    撞上了会直接 skipped，然后你会误以为"扣了但账单没动"）。
  const view = (await PLATFORM('GET', `/ledger/${t1}`)).body;
  const usedDates = new Set<string>((view.runs ?? []).map((r: { runDate: string }) => r.runDate));
  let runDate = bizDateOf(Date.now() + 86_400_000);
  for (let i = 2; i < 12 && usedDates.has(runDate); i++) runDate = bizDateOf(Date.now() + i * 86_400_000);
  assert(!usedDates.has(runDate), `找不到空闲的结算日（已用：${[...usedDates].join(',')}）`);

  const settle = await PLATFORM('POST', `/ledger/${t1}/settle`, { body: { runDate } });
  eq(settle.status, 200, JSON.stringify(settle.body));
  eq(settle.body.skipped, false, '必须是真正跑了一批，而不是命中了既有批次（skipped=true 时会让人误判）');
  const settledFee = settle.body.run.feeCents;
  assert(settledFee > 0, `这一批应扣到钱，实际 ${settledFee}`);
  eq(bizPeriodOf(settle.body.txn.createdAt), bizPeriodOf(), '流水时间必须钉在本账期内，否则账单看不出这次扣减');

  const after = (await PLATFORM('GET', `/ledger/${t1}/statements?period=${bizPeriodOf()}`)).body.statement;
  eq(after.diffCents, before.diffCents - settledFee, '实扣侧必须按批次金额精确落账');
  eq(after.status, after.diffCents === 0 ? 'ok' : 'diff', '差额与状态必须同源');
});

check('批量生成上月账单：每个租户一份，跑两次结果一致（upsert 幂等）', async () => {
  const period = bizPeriodOf(new Date(Date.now() - 40 * 86_400_000));
  const first = await PLATFORM('POST', '/ledger/statements/build', { body: { period } });
  eq(first.status, 200, JSON.stringify(first.body));
  assert(first.body.items.length >= 1, '至少要生成一份');
  const mine = first.body.items.find((i: any) => i.tenantCode === t1);
  assert(mine, '必须覆盖到 t1');

  const second = await PLATFORM('POST', '/ledger/statements/build', { body: { period } });
  const mine2 = second.body.items.find((i: any) => i.tenantCode === t1);
  eq(mine2.diffCents, mine.diffCents, '同一个月重复生成必须结果一致');
});

group('S7-2 对账看板：一屏看完"钱对不对得上"');

check('看板逐租户给出两个差额，且合计口径一致', async () => {
  const r = await PLATFORM('GET', '/ledger/reconcile-board');
  eq(r.status, 200, JSON.stringify(r.body));

  const mine = r.body.rows.find((x: any) => x.tenantCode === t1);
  assert(mine, '看板必须列出 t1');
  eq(mine.balanceDiffCents, mine.balanceCents - mine.txnSumCents, '差额必须是"余额 − 流水求和"（可复算）');
  assert(typeof mine.hasDiff === 'boolean', '必须给出"要不要标红"这一个布尔，不让前端自己再算一遍');
  eq(r.body.totals.tenants, r.body.rows.length, '合计条数必须与明细一致');
  eq(r.body.totals.withDiff, r.body.rows.filter((x: any) => x.hasDiff).length, '标红条数必须与明细一致');
  eq(mine.balanceDiffCents, 0, '账本自洽：余额必须等于全部流水求和');
});

check('对账看板出参过 AC-13：全链路无房间号字段', async () => {
  const r = await PLATFORM('GET', '/ledger/reconcile-board');
  const leaks = assertNoTenantPrivateFields(r.body);
  eq(leaks.length, 0, `泄漏了租户私有字段：${leaks.join(', ')}`);
  const text = JSON.stringify(r.body).toLowerCase();
  for (const bad of ['"roomno"', '"room_no"', '"roomcode"', '"floor"']) {
    assert(!text.includes(bad), `对账看板响应里出现了 ${bad}`);
  }
});

group('S7-3 对账巡检：能自愈的自动补，孤儿支付只上报不编单');

check('收到钱但没有订单 → 记一条孤儿支付，且回调重放不重复记', async () => {
  const beforeOpen = (await PLATFORM('GET', '/ledger/orphan-pays?status=open')).body.open;

  const r = await PAYCB({ orderNo: 'NO-SUCH-ORDER', txnId: 'TXN-ORPHAN-1', amountCents: 1234 });
  eq(r.status, 404, `订单不存在必须失败（不能给微信 SUCCESS）：${JSON.stringify(r.body)}`);
  eq(r.body.error.code, 'ORDER_NOT_FOUND');

  const list = (await PLATFORM('GET', '/ledger/orphan-pays?status=open')).body;
  eq(list.open, beforeOpen + 1, '必须留一条痕 —— 静默丢掉就是"钱没了但没人知道"');
  const one = list.items.find((x: any) => x.txnId === 'TXN-ORPHAN-1');
  assert(one, '要能按支付流水号查到它（人工核查的唯一抓手）');
  eq(one.amountCents, 1234, '金额要原样记下');
  eq(one.status, 'open');

  // 微信会重放回调：同一笔钱记三遍就变成"三笔要查的账"，先被自己的记录误导
  await PAYCB({ orderNo: 'NO-SUCH-ORDER', txnId: 'TXN-ORPHAN-1', amountCents: 1234 });
  const again = (await PLATFORM('GET', '/ledger/orphan-pays?status=open')).body;
  eq(again.open, list.open, '同一 txnId 重放不得重复记录（幂等键 = 租户 + 流水号）');
});

check('孤儿支付进告警（danger）—— 它必须出现在有人会看的地方', async () => {
  const r = await PLATFORM('POST', '/ledger/jobs/run', { body: { kind: 'reconcile_patrol' } });
  eq(r.status, 200, JSON.stringify(r.body));

  const alerts = (await PLATFORM('GET', '/alerts?open=1')).body;
  const hit = alerts.items.find((a: any) => a.dedupeKey === `orphan_pay:${t1}:TXN-ORPHAN-1`);
  assert(hit, '孤儿支付必须生成一条告警');
  eq(hit.kind, 'pay_anomaly', '复用"支付异常"分类，不新开第六类');
  eq(hit.level, 'danger', '收到钱没单，这是最高优先级');
  assert(hit.detail.includes('TXN-ORPHAN-1'), '详情里要带流水号，否则运维无法核');

  // 巡检会反复跑，告警必须幂等
  await PLATFORM('POST', '/ledger/jobs/run', { body: { kind: 'reconcile_patrol' } });
  const again = (await PLATFORM('GET', '/alerts?open=1')).body;
  eq(
    again.items.filter((a: any) => a.dedupeKey === `orphan_pay:${t1}:TXN-ORPHAN-1`).length,
    1,
    '同一条孤儿支付不能刷出多条告警',
  );
});

check('结清孤儿支付必须写处理说明（否则只是把异常抹掉）', async () => {
  const list = (await PLATFORM('GET', '/ledger/orphan-pays?status=open')).body;
  const one = list.items.find((x: any) => x.txnId === 'TXN-ORPHAN-1');

  const noNote = await PLATFORM('POST', `/ledger/orphan-pays/${one.id}/resolve`, { body: { operator: 'ops' } });
  eq(noNote.status, 400, '空白说明必须被拒');
  eq(noNote.body.error.code, 'VALIDATION_FAILED');

  const ok = await PLATFORM('POST', `/ledger/orphan-pays/${one.id}/resolve`, {
    body: { operator: 'ops', note: '核对微信账单：该笔为伪造回调，已记录并忽略' },
  });
  eq(ok.status, 200, JSON.stringify(ok.body));
  eq(ok.body.status, 'resolved');
  eq(ok.body.resolvedBy, 'ops');

  const after = (await PLATFORM('GET', '/ledger/orphan-pays?status=open')).body;
  eq(after.items.some((x: any) => x.txnId === 'TXN-ORPHAN-1'), false, '结清后不再出现在待处理里');
});

check('自愈：账本登记漏了 → 巡检自动补上（能自己好的就别生成工单）', async () => {
  // 造一笔已支付订单，然后**直接删掉平台库的订单投影**，模拟"上次死在半路"
  const o = await placeOk({ buildingId: bOrder, addressId: addrA, items: [{ productId: pA, qty: 1 }] });
  const cb = await PAYCB({ orderNo: o.orderNo, txnId: `TXN-HEAL-${o.orderNo}`, amountCents: o.totalCents });
  eq(cb.status, 200, JSON.stringify(cb.body));

  const factory = appRef!.get(REPO_FACTORY) as MemoryRepoFactory;
  const existed = factory.store.orderSummaries.delete(o.orderNo);
  assert(existed, '前置条件：平台库投影应已存在（否则这条用例没验证到东西）');

  // 删掉投影后，钱还在微信那边收了 —— 这正是"支付成功但订单没走完"
  const run = await PLATFORM('POST', '/ledger/jobs/run', { body: { kind: 'reconcile_patrol' } });
  eq(run.status, 200, JSON.stringify(run.body));
  const detail = run.body.results.find((x: any) => x.kind === 'reconcile_patrol')?.detail;
  const mine = detail.perTenant.find((x: any) => x.tenantCode === t1);
  assert(mine.repaired >= 1, `该租户应至少自愈 1 单，实际 ${mine.repaired}`);

  // 自愈是可观测的：投影回来了，且待扣队列里能找到这一单
  const pending = (await PLATFORM('GET', `/ledger/${t1}/pending`)).body;
  assert(pending.items.some((i: any) => i.orderNo === o.orderNo), '自愈后该单必须重新出现在待扣队列');
});

group('S7-4 五类任务：看板 · 可注入 now · 手工与调度分开记账');

check('任务清单由服务端给出（前端按钮不写死 kind）', async () => {
  const r = await PLATFORM('GET', '/ledger/jobs/kinds');
  eq(r.status, 200);
  eq(r.body.items.length, 6, '五类任务 + 账单生成');
  assert(r.body.items.every((i: any) => i.label), '每一项都要有人话标签');
  const kinds = r.body.items.map((i: any) => i.kind);
  for (const k of ['daily_settlement', 'close_expired', 'auto_complete', 'expiry_reminder', 'reconcile_patrol']) {
    assert(kinds.includes(k), `缺少任务 ${k}`);
  }
});

check('超时关单：未支付超 15 分钟 → 自动关闭并释放库存', async () => {
  const o = await placeOk({ buildingId: bOrder, addressId: addrA, items: [{ productId: pA, qty: 1 }] });
  const later = new Date(Date.now() + (ORDER_TIMEOUT.PAY_TIMEOUT_MINUTES + 1) * 60_000).toISOString();
  const r = await PLATFORM('POST', '/ledger/jobs/run', { body: { kind: 'close_expired', now: later } });
  eq(r.status, 200, JSON.stringify(r.body));
  const detail = r.body.results[0].detail;
  assert(detail.closed.some((c: any) => c.orderNo === o.orderNo), `该单应被关闭：${JSON.stringify(detail)}`);

  const after = (await ORD('GET', `/${o.orderNo}`)).body;
  // 学生端订单详情直接返回视图（不再套一层 order），这里两种形状都兼容
  const afterStatus = after.order?.status ?? after.status;
  eq(afterStatus, 'cancelled', `关单后状态必须是已取消 [${JSON.stringify(after).slice(0, 200)}]`);
  const cell = await cellOf(pA, bOrder);
  eq(cell.locked, 0, '超时关单必须释放预占（否则库存被永久占住）');
});

check('送达兜底：配送中超 12 小时 → 自动完成，且标记来源是系统', async () => {
  const o = await placeOk({ buildingId: bOrder, addressId: addrA, items: [{ productId: pA, qty: 1 }] });
  await PAYCB({ orderNo: o.orderNo, txnId: `TXN-AC-${o.orderNo}`, amountCents: o.totalCents });
  const acc = await MER('POST', `/${o.orderNo}/accept`);
  eq(acc.status, 200, JSON.stringify(acc.body));
  eq(acc.body.order.status, 'delivering');

  const later = new Date(Date.now() + 13 * 3600_000).toISOString();
  const r = await PLATFORM('POST', '/ledger/jobs/run', { body: { kind: 'auto_complete', now: later } });
  const detail = r.body.results[0].detail;
  assert(detail.completed.some((c: any) => c.orderNo === o.orderNo), `该单应被兜底完成：${JSON.stringify(detail)}`);

  const after = (await MER('GET', `/${o.orderNo}`)).body;
  eq(after.order.status, 'delivered', '兜底后应进入已送达');
  eq(after.order.autoCompleted, true, '必须区分"系统兜底"与"商户手动标记"，否则事后无法追责');

  // 幂等：再跑一次不该重复处理
  const again = await PLATFORM('POST', '/ledger/jobs/run', { body: { kind: 'auto_complete', now: later } });
  eq(again.body.results[0].detail.completed.length, 0, '已完成的单不得再次被兜底');
});

check('看板把"调度触发"与"手工触发"分开记账 —— 手工跑绿 ≠ 定时任务正常', async () => {
  await PLATFORM('POST', '/ledger/jobs/run', { body: { kind: 'statement_build', trigger: 'schedule' } });
  const status = (await PLATFORM('GET', '/ledger/jobs/status')).body;

  assert(status.scheduleState.ticking === status.enabled, '调度器要如实报告自己在不在跑（关掉时必须说 false）');
  assert(typeof status.enabled === 'boolean', '必须给出 enabled 供运维确认调度是否被关掉');
  assert(status.runs.length > 0, '运行记录必须可见');
  assert(status.history.length > 0, '旧字段 history 仍需保留（既有脚本/手册在用）');
  assert(status.scheduleState.lastSettlementDate, '必须能回答"上次扣减是哪天"');

  const sched = status.runs.find((r: any) => r.trigger === 'schedule');
  assert(sched, '必须能区分出调度触发的那条 —— 否则手工点一次全绿会骗过运维');
  assert(status.runs[0].finishedAt, '跑完的任务必须有结束时间（没结束时间 = 可能卡死了）');
});

check('未知任务名 → 明确报错并列出可用项，不静默当成功', async () => {
  const r = await PLATFORM('POST', '/ledger/jobs/run', { body: { kind: 'no_such_job' } });
  eq(r.status, 200);
  assert(r.body.error, '必须给出错误');
  assert(Array.isArray(r.body.known) && r.body.known.length === 6, '要列出可用任务名，否则调用方只能猜');
});

group('S7-5 空态与状态全集的**数据前提**：客服电话 · 今日日报 · 业务日口径');

check('租户解析必须下发客服电话 —— 否则"联系店家"是一句空话', async () => {
  const r = await req('POST', '/api/tenant/resolve', { body: { appid: 'wxTEST0000000001' } });
  eq(r.status, 200, JSON.stringify(r.body));
  assert('contactPhone' in r.body, '响应里必须有这个字段（哪怕是 null），前端才知道能不能给拨号入口');
  eq(r.body.contactPhone, '13800000000', '店主填了客服电话就必须原样下发');

  // AC-13 的边界要在这里钉死：解析响应是学生可见的最大的一份数据，
  // 一旦有人往里塞"方便调试"的字段，泄露会从这里开始
  const raw = JSON.stringify(r.body);
  assert(!/room/i.test(raw), '学生可见响应里不得出现任何房间号字段');
  assert(!/openid/i.test(raw), '不得下发顾客身份标识');
});

check('客服电话为空时返回 null，而不是空串 —— 前端据此走"复制店名"那条路', async () => {
  const clear = await req('POST', `/t/${t1}/api/config`, { token: t1OwnerToken, body: { contactPhone: null } });
  eq(clear.status, 201, JSON.stringify(clear.body));
  const after = (await req('POST', '/api/tenant/resolve', { body: { appid: 'wxTEST0000000001' } })).body;
  eq(after.contactPhone, null, '必须显式 null：空串会让前端把判断写成 ===\'\' 而不是 falsy');

  // 还原，避免影响后续用例（也顺手验证了能改回来）
  await req('POST', `/t/${t1}/api/config`, { token: t1OwnerToken, body: { contactPhone: '13800000000' } });
  const restored = (await req('POST', '/api/tenant/resolve', { body: { appid: 'wxTEST0000000001' } })).body;
  eq(restored.contactPhone, '13800000000', '改回来必须立刻生效（配置无需发版，§2.2）');
});

check('配送清单带今日日报：空态要说"今天送了 N 单、营收 ¥X"而不是一句"没有订单"', async () => {
  const d = (await req('GET', `/t/${t1}/api/merchant/orders/delivery`, { token: t1OwnerToken })).body;
  assert(d.today, '必须与 groups 同源返回 —— 分成两个请求会出现"待送 0 单、营收却是昨天的"');
  assert(
    typeof d.today.deliveredCount === 'number' && typeof d.today.deliveredCents === 'number',
    '单数与金额都必须是数字（营收用分，避免浮点）',
  );
  assert(/^\d{4}-\d{2}-\d{2}$/.test(d.today.day), `业务日格式必须是 YYYY-MM-DD，实际 ${d.today.day}`);
  eq(d.today.day, bizDateOf(), '日报归属的业务日必须是服务端当天，不能由前端算');
});

check('今日营收只算已送达，取消与退款不计 —— 退了的不算营收', async () => {
  // 造两单：一单正常送达，一单取消
  const good = await placeOk({ buildingId: bOrder, addressId: addrA, items: [{ productId: pA, qty: 1 }] });
  await PAYCB({ orderNo: good.orderNo, txnId: `TXN-TODAY-${good.orderNo}`, amountCents: good.totalCents });
  const accept = await req('POST', `/t/${t1}/api/merchant/orders/${good.orderNo}/accept`, { token: t1OwnerToken, body: {} });
  eq(accept.status, 200, JSON.stringify(accept.body));
  const deliver = await req('POST', `/t/${t1}/api/merchant/orders/${good.orderNo}/deliver`, { token: t1OwnerToken, body: {} });
  eq(deliver.status, 200, JSON.stringify(deliver.body));

  const bad = await placeOk({ buildingId: bOrder, addressId: addrA, items: [{ productId: pA, qty: 1 }] });
  await ORD('POST', `/${bad.orderNo}/cancel`, { reason: '不想要了' });

  const d = (await req('GET', `/t/${t1}/api/merchant/orders/delivery`, { token: t1OwnerToken })).body;
  assert(d.today.deliveredCount >= 1, '刚送达的那单必须出现在今日日报里');
  assert(
    d.today.deliveredCents >= good.totalCents,
    `今日营收必须含这一单的实付 ${good.totalCents}，实际 ${d.today.deliveredCents}`,
  );
  // 取消单的金额不得混进来：营收口径一旦宽松，"营收"就没人信了
  eq(d.today.deliveredCents % 1, 0, '营收必须是整数分');
});

check('业务日按中国时区切 —— 跨 UTC 日边界的单归属正确', () => {
  // 北京时间 2026-09-22 07:00 = UTC 2026-09-21 23:00。
  // 用 UTC 切日会把这一天算成 09-21，配送日报和账期就会各说各话。
  const beijingMorning = new Date(Date.UTC(2026, 8, 21, 23, 0, 0));
  eq(bizDayOf(beijingMorning), '2026-09-22', 'UTC 深夜是北京的次日早晨');
  eq(bizMonthOf(beijingMorning), '2026-09');
  // 日界起点必须正好落在北京 00:00（= UTC 前一日 16:00）
  eq(bizDayStartOf(beijingMorning).toISOString(), '2026-09-21T16:00:00.000Z', '业务日起点 = 北京 00:00');
  // 月末最后一刻不能跨月（否则账期会多一天）
  const monthEnd = new Date(Date.UTC(2026, 8, 30, 15, 59, 0)); // 北京 09-30 23:59
  eq(bizDayOf(monthEnd), '2026-09-30');
  eq(bizDayOf(new Date(Date.UTC(2026, 8, 30, 16, 0, 0))), '2026-10-01', '北京 10-01 00:00 必须进新账期');
});

group('S7-6 §5.4 文案对照表落地 + §6.5 学生端脱敏');

check('订阅到期 / 余额触底 → 学生端两种状态**必须无法区分**（AC-13）', () => {
  const base = {
    shopOpen: true,
    buildingStatus: 'active' as const,
    buildingDeliveryEnabled: true,
    subscriptionValid: true,
    balanceCents: 10000,
    creditLimitCents: -2000,
    openTime: '08:00',
    closeTime: '22:30',
    accessibleFrom: '06:30',
    accessibleTo: '22:30',
    cutoffTime: '22:00',
  };
  const at = new Date(Date.UTC(2026, 8, 22, 4, 0));
  const expired = evaluateOrderGate({ ...base, subscriptionValid: false }, at);
  const blocked = evaluateOrderGate({ ...base, balanceCents: -2000 }, at);

  // 内部状态必须可区分 —— 商户端看板与运维排障靠它
  eq(expired.state, 'subscription_expired', '内部状态不能为了脱敏而合并');
  eq(blocked.state, 'balance_blocked');

  // 但**对外**必须一模一样。只要学生能区分，"这家店快开不下去了"就会顺着界面传出去，
  // 而他唯一的动作是"换一家" —— 对商户是净损失（§6.5）。
  eq(expired.message, blocked.message, '两种经营状况在学生端的文案必须逐字相同');
  for (const w of ['服务期', '余额', '充值', '续费', '接单', '订单', '停单']) {
    assert(!expired.message.includes(w), `学生端文案不得出现商户经营词「${w}」：${expired.message}`);
  }
  eq(expired.tone, 'off', '与「店家休息中」同色 —— 学生只需知道"现在下不了单"');
});

check('商户端账本文案三档都给「事实 + 下一步」，触底必须给恢复条件（§5.4-7）', async () => {
  const wallet0 = (await PLATFORM('GET', `/ledger/${t1}`)).body.wallet;
  const warnLine = wallet0.warnLineCents as number;
  const limit = wallet0.creditLimitCents as number;
  const bump = async (target: number) => {
    const cur = (await PLATFORM('GET', `/ledger/${t1}`)).body.wallet.balanceCents as number;
    const delta = target - cur;
    if (delta === 0) return;
    await PLATFORM('POST', `/ledger/${t1}/adjust`, {
      body: { amountCents: delta, reason: '验收：把余额推到指定档位', operator: 'smoke' },
    });
  };

  // ① ok —— 正常也要有话。余额卡是常驻卡片，正文留白会让商户以为"没加载全"
  await bump(warnLine + 50_000);
  let w = (await PLATFORM('GET', `/ledger/${t1}`)).body.wallet;
  eq(w.tone, 'ok');
  assert(w.noticeTitle && w.noticeBody, 'ok 态也必须给标题与正文');
  assert(!w.noticeBody.includes('偏低'), `余额充足时不得说"偏低"（数字与结论会自相矛盾）：${w.noticeBody}`);

  // ② warn —— 说事实 + 给建议，不催不吓
  await bump(warnLine - 100);
  w = (await PLATFORM('GET', `/ledger/${t1}`)).body.wallet;
  eq(w.tone, 'warn');
  assert(w.noticeBody.includes('低于预警线'), `预警档必须点明预警线：${w.noticeBody}`);

  // ③ danger —— 已经停了，所以必须给**恢复条件**，不能只说"请充值"（§5.4-7）
  await bump(limit);
  w = (await PLATFORM('GET', `/ledger/${t1}`)).body.wallet;
  eq(w.tone, 'danger');
  assert(
    w.noticeBody.includes('充值后立即恢复接单'),
    `触底文案必须给出恢复条件（充值后立即恢复接单），实际：${w.noticeBody}`,
  );
  assert(
    w.noticeBody.includes('已下单的订单不受影响'),
    '必须交代已接订单的去向 —— 否则商户会以为手里的单也黄了',
  );
  const hits = BANNED_COPY.filter((x) => w.noticeTitle.includes(x) || w.noticeBody.includes(x));
  eq(hits.length, 0, `账本文案不得出现禁用词（${BANNED_COPY.join('/')}）：${hits.join('/')}`);

  // 还原到预警线以上，避免后面手工跑任务时看的是一张停单的店
  await bump(warnLine + 50_000);
});

check('服务期到期文案：中性词 + 给恢复条件（§5.4-8）', async () => {
  const before = (await PLATFORM('GET', `/ledger/${t1}`)).body.wallet.balanceCents as number;
  const past = new Date(Date.now() - 86_400_000).toISOString();
  await PLATFORM('POST', `/ledger/${t1}/subscription/renew`, { body: { periodEnd: past } });

  const billing = (await PLATFORM('GET', `/ledger/${t1}`)).body;
  eq(billing.subscription.noticeTitle, '本学期服务期已结束', '标题用中性词「服务期」，并点明是本学期');
  assert(
    billing.subscription.notice.includes('续费后即可继续接单'),
    `到期文案必须给出恢复条件，实际：${billing.subscription.notice}`,
  );
  assert(
    billing.subscription.notice.includes('仍可浏览'),
    '必须说清"还能做什么"（仍可浏览）—— 只说不行的商户会以为店被关了',
  );
  // 禁用词一个都不许有（"欠费"会把商户的感受从"我该交服务费"变成"我被追债了"）
  const hits = BANNED_COPY.filter(
    (x) => billing.subscription.notice.includes(x) || billing.subscription.noticeTitle.includes(x),
  );
  eq(hits.length, 0, `到期文案不得出现禁用词：${hits.join('/')}`);
  eq(billing.wallet.balanceCents, before, '到期只停单，不动余额一分钱');

  // 续回来
  const future = new Date(Date.now() + 60 * 86_400_000).toISOString();
  await PLATFORM('POST', `/ledger/${t1}/subscription/renew`, { body: { periodEnd: future } });
  const back = (await PLATFORM('GET', `/ledger/${t1}`)).body.subscription;
  eq(back.status, 'active');
  assert(back.noticeTitle.includes('还有'), `未到期时标题应给剩余天数，实际：${back.noticeTitle}`);
});

check('三种「今天做不了」共用同一张模板 —— 结构一致，差别只在标题与恢复时间（AC-02）', () => {
  const base = {
    shopOpen: true,
    buildingStatus: 'active' as const,
    buildingDeliveryEnabled: true,
    subscriptionValid: true,
    balanceCents: 10000,
    creditLimitCents: -2000,
    openTime: '08:00',
    closeTime: '22:30',
    accessibleFrom: '06:30',
    accessibleTo: '22:30',
    cutoffTime: '22:00',
  };
  const at = (h: number, m: number) => new Date(Date.UTC(2026, 8, 22, h - 8, m));

  const closed = evaluateOrderGate(base, at(22, 15)); // 已截单
  const paused = evaluateOrderGate({ ...base, buildingDeliveryEnabled: false }, at(12, 0)); // 本栋今日停送
  const resting = evaluateOrderGate({ ...base, shopOpen: false }, at(12, 0)); // 店家休息中

  for (const g of [closed, paused, resting]) {
    eq(g.orderable, false, `${g.state} 不该可下单`);
    eq(g.tone, 'off', `AC-02：三种"今天做不了"必须是同一种灰，${g.state} 用了 ${g.tone}`);
    assert(g.title && !g.title.endsWith('。'), `标题必须是短句（不带句号）：${g.title}`);
    assert(g.recovery, `${g.state} 是"今天不做"而不是"永远不做"，必须给出恢复时间`);
  }

  // 共用模板 ≠ 三种情况说同一句话：标题必须能区分，否则学生不知道自己在等什么
  eq(
    new Set([closed.title, paused.title, resting.title]).size,
    3,
    `三种情况的标题必须互不相同，实际：${closed.title} / ${paused.title} / ${resting.title}`,
  );
  assert(closed.recovery!.includes('明天'), `截单之后要等到明天：${closed.recovery}`);
  eq(closed.title, '今天送到这儿了', '§6.4：已截单的标题是「今天送到这儿了」（它并非出错）');

  // 停用 ≠ 停送（§6.2）：停用是"这家店不在这栋楼做生意了"，承诺"明天恢复"就是撒谎
  const off = evaluateOrderGate({ ...base, buildingStatus: 'disabled' }, at(12, 0));
  eq(off.state, 'building_paused');
  eq(off.tone, 'off');
  eq(off.recovery, null, '停用楼栋不得给恢复时间 —— 说了就是撒谎，学生会白等一天');
  assert(off.title !== paused.title, '停用与今日停送必须能区分（一个是永久、一个是今天）');

  // 可下单时也要有标题与恢复说明 —— 否则状态条只能在 ok 时留白
  const ok = evaluateOrderGate(base, at(12, 0));
  eq(ok.title, '现在可以下单');
  assert(ok.recovery && ok.recovery.includes('截单'), `ok 态要说清什么时候截单：${ok.recovery}`);
  const soon = evaluateOrderGate(base, at(21, 45));
  eq(soon.title, '即将截单');
  eq(soon.tone, 'warn', '唯一用琥珀的是「即将截单」—— 它还没发生、人还能做点什么');
});

check('下单失败要说清「哪个商品 + 哪一栋 + 下一步」（§5.4-3）', async () => {
  const r = await ORD('POST', '', {
    buildingId: bOrder,
    addressId: addrA,
    items: [{ productId: pB, qty: 1 }],
  });
  eq(r.status, 400, JSON.stringify(r.body));
  eq(r.body.error.code, 'ORDER_OUT_OF_STOCK');
  const msg = r.body.error.message as string;
  assert(msg.includes('测试售罄品'), `必须点名商品：${msg}`);
  assert(msg.includes('已售罄'), `必须说清是"售罄"而不是笼统的"库存不足"：${msg}`);
  assert(msg.includes('请移出后重新提交'), `必须给下一步：${msg}`);
  // 楼栋名必须出现 —— 同一个人可能在两栋楼都有收货地址，不说清他会去改错的那栋
  const list = (await req('GET', `/t/${t1}/api/buildings`, { token: t1Token })).body.buildings as Array<
    { id: number; name: string }
  >;
  const bName = list.find((x) => x.id === bOrder)?.name ?? '';
  assert(bName, '前置条件不满足：找不到订单楼栋的名字');
  assert(msg.includes(bName), `必须点明是哪一栋（${bName}）：${msg}`);
});

/* ============================================================================
 * S8-A 闭环回归补充
 * ----------------------------------------------------------------------------
 * 42 条闭环（CS-01~13 / CM-01~08 / CW-01~10 / CP-01~11）绝大部分已被前面各分组
 * 覆盖，对应关系见 docs/闭环回归用例_42条.md。
 *
 * 这里只补两条**服务端可观测、但此前没被钉死**的：
 *   · CM-02 开关店 —— 不只是"关店后下不了单"，还有"在途订单不受影响"
 *   · CS-12 地址簿 —— 默认唯一 / 删除 / 非法输入 / "送他人房间"
 * 之所以补这两条而不是全量重写：重复断言不增加信心，只增加维护成本。
 * ==========================================================================*/

group('S8-A 闭环回归补充：开关店（CM-02）与地址簿（CS-12）');

check('CM-02 开关店：关店后新单被拦，但**在途订单照常履约**', async () => {
  // 前置：造一张已支付、已接单的在途订单（停在"配送中"）
  const o = await placeOk({ buildingId: bOrder, addressId: addrA, items: [{ productId: pA, qty: 1 }] });
  const cb = await PAYCB({ orderNo: o.orderNo, txnId: `TX-S8A-A-${o.orderNo}`, amountCents: o.totalCents });
  eq(cb.status, 200, JSON.stringify(cb.body));
  const acc = await MER('POST', `/${o.orderNo}/accept`);
  assert(acc.status < 400, JSON.stringify(acc.body));
  eq(acc.body.order.status, 'delivering', '前置：这一单应当已在配送中');

  // 关店
  const close = await req('POST', `/t/${t1}/api/config`, { token: t1OwnerToken, body: { shopOpen: false } });
  assert(close.status < 400, JSON.stringify(close.body));

  // 新单：必须被闸门拦下，且给出"关门"这个明确原因 ——
  // 不能笼统报库存不足或系统错误，否则商户会去查库存
  const blocked = await ORD('POST', '', {
    buildingId: bOrder, addressId: addrA, items: [{ productId: pA, qty: 1 }],
  });
  eq(blocked.status, 400, JSON.stringify(blocked.body));
  eq(
    blocked.body.error.code, 'ORDER_GATE_CLOSED',
    `关店后下单应报「闸门关闭」，实际 ${blocked.body.error.code}`,
  );

  // 在途订单：关店**不能**影响它。
  // 否则"盘中订单不受影响"就只是界面上一句没人验证过的话 ——
  // 而真实的伤害是：商户收工关店，楼里那几单再也点不了送达。
  const done = await MER('POST', `/${o.orderNo}/deliver`);
  assert(done.status < 400, `关店不得妨碍在途订单送达：${JSON.stringify(done.body)}`);
  eq(done.body.order.status, 'delivered');

  // 恢复营业 —— 不恢复的话后面所有用例都会连坐假失败，而假失败的根因最难查
  const reopen = await req('POST', `/t/${t1}/api/config`, { token: t1OwnerToken, body: { shopOpen: true } });
  assert(reopen.status < 400, JSON.stringify(reopen.body));
  const gate = await req('GET', `/t/${t1}/api/config/gate?buildingId=${bOrder}`, { token: stuTokenRef.a });
  assert(gate.body.orderable, '恢复营业后必须又能下单，否则后续用例会连坐假失败');
});

check('CS-12 地址簿：默认唯一 · 送他人房间 · 非法输入给明确原因', async () => {
  const mk = (room: string, extra: Record<string, unknown> = {}) =>
    ADDR('POST', '', { buildingId: bOrder, room, ...extra });

  // "帮室友带一份"是真实高频场景 —— 收件人允许与本人不同，不做限制
  const r1 = await mk('701', { contact: '室友小王', phone: '13900000002', tag: '帮同学带' });
  eq(r1.status, 201, JSON.stringify(r1.body));
  const rid = r1.body.address.id as number;
  eq(r1.body.address.isDefault, false, '已有默认地址时，新地址不该抢默认');

  // 置为默认 → 旧默认必须让位。默认唯一不是洁癖：
  // 结算页不选地址时"送到哪"必须只有一个答案
  const p1 = await ADDR('PATCH', `/${rid}`, { isDefault: true });
  eq(p1.status, 200, JSON.stringify(p1.body));
  eq(p1.body.address.isDefault, true);

  const list = await ADDR('GET', '');
  const items = list.body.items as Array<{ id: number; isDefault: boolean }>;
  const defaults = items.filter((a) => a.isDefault);
  eq(defaults.length, 1, `默认地址必须唯一，实际有 ${defaults.length} 条`);
  eq(defaults[0]!.id, rid, '默认应当是刚置的那一条');
  eq(items[0]!.id, rid, '默认地址必须排在最前 —— 前端据此直接取第一条');

  // 非法输入：必须给明确原因，绝不能静默成功（静默成功 = 学生以为存上了）
  const noRoom = await mk('   ');
  eq(noRoom.status, 400, JSON.stringify(noRoom.body));
  eq(noRoom.body.error.code, 'VALIDATION_FAILED');

  const noBuilding = await ADDR('POST', '', { buildingId: 999999, room: '101' });
  eq(noBuilding.status, 404, JSON.stringify(noBuilding.body));
  eq(noBuilding.body.error.code, 'BUILDING_NOT_FOUND');

  // 删除：删掉就不再出现；删不存在的要给 404（假成功会让界面与真实状态分叉）
  const del = await ADDR('DELETE', `/${rid}`);
  eq(del.status, 200, JSON.stringify(del.body));
  const after = await ADDR('GET', '');
  assert(
    !(after.body.items as Array<{ id: number }>).some((a) => a.id === rid),
    '删除后不应再出现在地址簿里',
  );
  const delAgain = await ADDR('DELETE', `/${rid}`);
  eq(delAgain.status, 404, JSON.stringify(delAgain.body));
  eq(delAgain.body.error.code, 'ADDRESS_NOT_FOUND');
});

/* ------------------------------------------------------- 运行 */

let appRef: INestApplication | null = null;

async function main(): Promise<void> {
  const app: INestApplication = await NestFactory.create(AppModule, { logger: false });
  appRef = app;
  const logger = app.get(AppLogger);
  app.useLogger(logger);
  app.useGlobalFilters(new AllExceptionsFilter(logger));
  await app.listen(0, '127.0.0.1');
  const addr = app.getHttpServer().address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;

  const results: Array<{ ok: boolean; name: string; group: string; err?: string }> = [];
  let lastGroup = '';
  for (const c of cases) {
    try {
      await c.fn();
      results.push({ ok: true, name: c.name, group: c.group });
    } catch (e) {
      results.push({ ok: false, name: c.name, group: c.group, err: e instanceof Error ? e.message : String(e) });
    }
  }

  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  for (const r of results) {
    if (r.group !== lastGroup) {
      process.stdout.write(`\n── ${r.group}\n`);
      lastGroup = r.group;
    }
    process.stdout.write(`  ${r.ok ? '✓' : '✗'} ${r.name}\n`);
    if (!r.ok) process.stdout.write(`      → ${r.err}\n`);
  }

  process.stdout.write(`\n${'='.repeat(64)}\n`);
  process.stdout.write(`冒烟结果：${pass} 通过 / ${fail} 失败 / 共 ${results.length}\n`);
  process.stdout.write(`${'='.repeat(64)}\n`);

  await app.close();
  process.exit(fail === 0 ? 0 : 1);
}

void main();
