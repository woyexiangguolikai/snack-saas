/**
 * 一次性迁移：把「错误表达」收敛到页顶唯一的 ErrorBanner。
 *
 * 迁移前的问题（三种并存，语义还不对）：
 *   · 有的页面用 `<EmptyState v-else-if="error">` —— 错误**占了空态的位置**。
 *     用户看到"没有符合条件的订单"，而他真正的处境是"这次没取到数据"。
 *     这两句话的下一步完全不同：前者要改筛选，后者要重试。
 *   · 有的页面用一个 `<Panel title="加载失败">`（只此一处）。
 *   · 有的页面干脆不显示错误（Orders / Products / StockLogs / StockMatrix / Settings）——
 *     失败时列表报"没有数据"，商户会以为订单真的没了。
 *
 * 迁移后的规则（全后台一条）：
 *   错误只由页顶 `<ErrorBanner>` 表达（带重试、不清空内容）；
 *   内容区只有三支：首批加载 → 骨架；确实为空且无错误 → 空态；否则 → 内容。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const web = join(process.cwd(), 'apps', 'web', 'src');
const IMPORT_LINE = "import ErrorBanner from '@/components/ErrorBanner.vue';";

/** 平台后台：useLoad 是解构出来的，模板里直接用 error / run */
const PLATFORM = ['Gates', 'Pipeline', 'Rework', 'TenantDetail', 'Versions', 'Tenants', 'Alerts', 'Schools', 'Secrets', 'Tickets'];
/** 平台后台里空态需要额外排除错误的页面：{ 文件名: 空态条件里的列表表达式 } */
const PLATFORM_EMPTY_GATE = { Tenants: 'filtered', Alerts: 'items', Schools: 'filtered' };

/** 商户后台：useLoad 返回对象，模板里要写 X.error.value */
const MERCHANT = {
  Orders: { store: 'orders', lists: ['items'] },
  Products: { store: 'products', lists: ['filtered'] },
  StockLogs: { store: 'logs', lists: ['items'] },
  StockMatrix: { store: 'matrix', lists: ['rows'] },
  Buildings: { store: 'list', lists: ['active'] },
  Dashboard: { store: 'orders', lists: ['recent'] },
  Billing: { store: 'billing', lists: ['runs', 'txns'] },
  Settings: { store: 'config', lists: [] },
};

const report = [];

function load(p) {
  return readFileSync(join(web, p), 'utf8');
}
function save(p, src) {
  writeFileSync(join(web, p), src, 'utf8');
}

/** 在最后一个 PageHeader 之后插入横幅（PageHeader 有成对与自闭合两种写法） */
function insertBanner(src, expr, retry) {
  let at = src.lastIndexOf('</PageHeader>');
  let end;
  if (at >= 0) {
    end = src.indexOf('\n', at);
  } else {
    // 自闭合写法：<PageHeader … /> —— 取最后一个以此**开头**的行的行尾
    const re = /^[ \t]*<PageHeader[\s\S]*?\/>[ \t]*$/gm;
    let m;
    let last = null;
    while ((m = re.exec(src)) !== null) last = m;
    if (!last) return null;
    at = last.index + last[0].length - 2; // 指向 "/>"
    end = last.index + last[0].length;
  }
  const lineStart = src.lastIndexOf('\n', at) + 1;
  const indent = src.slice(lineStart, at).match(/^[ \t]*/)[0];
  const banner = `\n\n${indent}<ErrorBanner :text="${expr}" @retry="${retry}" />`;
  return { src: src.slice(0, end) + banner + src.slice(end), indent };
}

function ensureImport(src) {
  if (src.includes(IMPORT_LINE)) return src;
  for (const anchor of [
    "import PageSkeleton from '@/components/PageSkeleton.vue';",
    "import EmptyState from '@/components/EmptyState.vue';",
  ]) {
    if (src.includes(anchor)) return src.replace(anchor, `${anchor}\n${IMPORT_LINE}`);
  }
  // 兜底：插在最后一条 import 之后（有的页面既没有骨架也没有空态，例如设置页）
  const m = [...src.matchAll(/^import .*;$/gm)].pop();
  if (!m) throw new Error('没有可用的 import 锚点');
  const end = m.index + m[0].length;
  return src.slice(0, end) + `\n${IMPORT_LINE}` + src.slice(end);
}

/** 删掉占用空态位置的错误分支（自闭合与块两种写法） */
function dropErrorBranch(src) {
  const before = src;
  src = src.replace(/[ \t]*<EmptyState\s+v-else-if="error"[^>]*\/>\n/g, '');
  src = src.replace(/[ \t]*<EmptyState\s+v-else-if="error"[\s\S]*?<\/EmptyState>\n/g, '');
  return { src, dropped: src !== before };
}

/* ============================================================ 平台后台 */
for (const name of PLATFORM) {
  const rel = join('pages', 'platform', `${name}.vue`);
  let src = load(rel);
  if (src.includes('ErrorBanner')) {
    report.push(`  - ${name}：已迁移，跳过`);
    continue;
  }
  const { src: s2, dropped } = dropErrorBranch(src);
  src = s2;
  const ins = insertBanner(src, 'error', 'run()');
  if (!ins) {
    report.push(`  ! ${name}：找不到 PageHeader，跳过`);
    continue;
  }
  src = ensureImport(ins.src);
  const list = PLATFORM_EMPTY_GATE[name];
  if (list) {
    const from = `v-else-if="!${list}.length"`;
    const to = `v-else-if="!${list}.length && !error"`;
    if (src.includes(from)) src = src.replace(from, to);
    else report.push(`  ! ${name}：未找到空态条件 ${from}`);
  }
  save(rel, src);
  report.push(`  ✓ ${name}${dropped ? '（删除错误空态 + 新增横幅）' : '（新增横幅）'}`);
}

/* ============================================================ 商户后台 */
for (const [name, cfg] of Object.entries(MERCHANT)) {
  const rel = join('pages', `${name}.vue`);
  let src = load(rel);
  if (src.includes('ErrorBanner')) {
    report.push(`  - ${name}：已迁移，跳过`);
    continue;
  }
  const expr = `${cfg.store}.error.value`;
  const retry = `${cfg.store}.run()`;

  // Buildings：先摘掉那个只此一处的 <Panel title="加载失败">
  if (name === 'Buildings') {
    src = src.replace(/[ \t]*<Panel v-if="list\.error\.value" title="加载失败">[\s\S]*?<\/Panel>\n\n?/g, '');
  }
  // Dashboard / Billing：把原有的手写横幅换成组件，避免两套错误表达
  if (name === 'Dashboard') {
    src = src.replace(
      /[ \t]*<div v-if="orders\.error\.value \|\| billing\.error\.value \|\| config\.error\.value"[\s\S]*?<\/div>\n/,
      '',
    );
  }
  if (name === 'Billing') {
    src = src.replace(/[ \t]*<div v-if="billing\.error\.value"[\s\S]*?<\/div>\n/, '');
  }

  const ins = insertBanner(src, expr, retry);
  if (!ins) {
    report.push(`  ! ${name}：找不到 PageHeader，跳过`);
    continue;
  }
  src = ensureImport(ins.src);

  for (const l of cfg.lists) {
    const from = `v-else-if="!${l}.length"`;
    const to = `v-else-if="!${l}.length && !${expr}"`;
    if (src.includes(from)) src = src.replace(from, to);
    else report.push(`  ! ${name}：未找到空态条件 ${from}`);
  }

  // Settings：取数失败时表单是空的，绝不能让"保存"把店铺设置覆盖成空值
  if (name === 'Settings') {
    src = src.replace(':disabled="saving" @click="save()"', ':disabled="saving || !config.data.value" @click="save()"');
    src = src.replace('<button class="btn" type="button" @click="config.run()">放弃修改</button>', '<button class="btn" type="button" :disabled="!config.data.value" @click="config.run()">放弃修改</button>');
  }

  save(rel, src);
  report.push(`  ✓ ${name}（横幅 text=${expr}）`);
}

console.log(report.join('\n'));
