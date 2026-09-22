/**
 * 一次性迁移脚本：把网页端各列表页的"加载中…"占位换成结构同构的骨架屏。
 *
 * 为什么需要脚本而不是手工改 18 个文件：
 *   这个替换是**同一条纪律的机械展开** —— "首屏数据未到时必须给出与真实结构一致的骨架"。
 *   手工改一遍容易漏掉某页，而漏掉的那一页恰好就是下次上线时白屏的那一页。
 *
 * 迁移完成后本脚本即失效（幂等：已经改过的文件再跑一遍不会重复插入）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const web = join(process.cwd(), 'apps', 'web', 'src');

/** 平台后台：`<div class="pad">加载中…</div>` 形态的页面 → 骨架预设 */
const PAD_PAGES = {
  Gates: 'table',
  Pipeline: 'table',
  Rework: 'table',
  TenantDetail: 'table',
  Versions: 'table',
  Tenants: 'tenantList',
};

/** 平台后台：裸 `<EmptyState text="加载中…" />` 形态的页面 */
const EMPTY_PAGES = ['Alerts', 'Schools', 'Secrets', 'Tickets'];

/**
 * 商户后台：`<EmptyState v-if="!X.length && !Y.loading.value" … />` + `<div v-else class="tbl-wrap">`。
 * 这两句合起来在**加载中必然白屏**（两个分支都不成立）—— 是要修的核心问题。
 * 值 = { list: 列表表达式, preset }。
 */
const MERCHANT_PAGES = {
  Orders: { list: 'items', preset: 'table', rows: 6 },
  Products: { list: 'filtered', preset: 'table', rows: 6 },
  StockLogs: { list: 'items', preset: 'table', rows: 6 },
  Buildings: { list: 'active', preset: 'table', rows: 4 },
  Dashboard: { list: 'recent', preset: 'table', rows: 4 },
  StockMatrix: { list: 'rows', preset: 'stockMatrix', rows: 5 },
};

const IMPORT_LINE = "import PageSkeleton from '@/components/PageSkeleton.vue';";
const ANCHOR = "import EmptyState from '@/components/EmptyState.vue';";

let changed = 0;

function ensureImport(src) {
  if (src.includes(IMPORT_LINE)) return src;
  if (!src.includes(ANCHOR)) throw new Error('找不到 EmptyState import 锚点');
  return src.replace(ANCHOR, `${ANCHOR}\n${IMPORT_LINE}`);
}

function write(relPath, src) {
  writeFileSync(join(web, relPath), src, 'utf8');
  changed += 1;
  console.log('  ✓', relPath);
}

/* ---------------------------------------------- 平台后台 A：div.pad 形态 */
for (const [name, preset] of Object.entries(PAD_PAGES)) {
  const rel = join('pages', 'platform', `${name}.vue`);
  let src = readFileSync(join(web, rel), 'utf8');
  if (src.includes('PageSkeleton')) {
    console.log('  - 已迁移，跳过', name);
    continue;
  }
  const from = '<div v-if="loading" class="pad">加载中…</div>';
  const to = `<div v-if="loading" class="pad"><PageSkeleton preset="${preset}" /></div>`;
  if (!src.includes(from)) {
    console.log('  ! 形态不符，跳过', name);
    continue;
  }
  src = ensureImport(src.replace(from, to));
  write(rel, src);
}

/* ---------------------------------------------- 平台后台 B：裸 EmptyState 形态 */
for (const name of EMPTY_PAGES) {
  const rel = join('pages', 'platform', `${name}.vue`);
  let src = readFileSync(join(web, rel), 'utf8');
  if (src.includes('PageSkeleton')) {
    console.log('  - 已迁移，跳过', name);
    continue;
  }
  const from = '<EmptyState v-if="loading" text="加载中…" />';
  const to = '<PageSkeleton v-if="loading" preset="table" />';
  if (!src.includes(from)) {
    console.log('  ! 形态不符，跳过', name);
    continue;
  }
  src = ensureImport(src.replace(from, to));
  write(rel, src);
}

/* ---------------------------------------------- 商户后台 C：!items.length && !loading */
for (const [name, cfg] of Object.entries(MERCHANT_PAGES)) {
  const rel = join('pages', `${name}.vue`);
  let src = readFileSync(join(web, rel), 'utf8');
  if (src.includes('PageSkeleton')) {
    console.log('  - 已迁移，跳过', name);
    continue;
  }
  const { list, preset, rows } = cfg;
  // 形如：`v-if="!items.length && !orders.loading.value"`（换行与缩进不固定）
  const re = new RegExp(
    `(<EmptyState(?:\\s+)v-if="!${list}\\.length && !([A-Za-z_$][\\w$]*)\\.loading\\.value")`,
    'g',
  );
  const hits = [...src.matchAll(re)];
  if (!hits.length) {
    console.log('  ! 形态不符，跳过', name);
    continue;
  }
  // 每个命中的 store 名（orders/products/logs…）可能不同，逐个替换
  src = src.replace(re, (_m, head, store) => {
    const sk = `<PageSkeleton v-if="${store}.loading.value && !${list}.length" preset="${preset}"${preset === 'stockMatrix' ? ' :cols="buildings.length"' : ` :rows="${rows}"`} />\n      `;
    return `${sk}<EmptyState v-else${head.slice('<EmptyState'.length)}`;
  });
  src = ensureImport(src);
  write(rel, src);
}

console.log(`\n共修改 ${changed} 个文件。`);
