/**
 * 一次性迁移：给已有 ErrorBanner 补上第 ③ 要素「哪些状态被保留了」（§5.1 ①），
 * 并把「局部失败」（§5.1 ②）接进三个并发多请求的页面。
 *
 * 为什么不给每一页都补 kept：
 *   只有当页面上**真的有状态会被保留**时才写。TenantDetail / Secrets 这类
 *   整页只有一条数据的页面，写"数据已保留"就是编 —— 编一句不如不写。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const web = join(process.cwd(), 'apps', 'web', 'src');

/** 文件 → kept 文案（未列出 = 该页确实没有可保留的状态，不写） */
const KEPT = {
  'pages/platform/Tenants.vue': '已勾选的租户和当前筛选都还在。',
  'pages/platform/Pipeline.vue': '当前选中的租户还在。',
  'pages/platform/Versions.vue': '当前分类筛选还在。',
  'pages/platform/Rework.vue': '已勾选的待重提单还在。',
  'pages/platform/Alerts.vue': '「只看待处理」的开关状态还在。',
  'pages/platform/Schools.vue': '搜过的关键词还在。',
  'pages/platform/Tickets.vue': '当前状态筛选还在。',
  'pages/Orders.vue': '你选的订单状态和搜索词都还在，重试后不用重新选。',
  'pages/Products.vue': '已显示的商品和当前筛选都还在。',
  'pages/StockLogs.vue': '已显示的流水还在。',
  'pages/StockMatrix.vue': '楼栋列与搜索条件都还在。',
  'pages/Dashboard.vue': '店铺状态、余额与服务期这些信息还在页面上，不受影响。',
  'pages/Billing.vue': '已显示的结算批次与流水还在页面上。',
};

let changed = 0;

for (const [rel, kept] of Object.entries(KEPT)) {
  if (!kept) continue;
  const abs = join(web, rel);
  let src = readFileSync(abs, 'utf8');
  const re = /<ErrorBanner(\s[^>]*?)\s*\/>/;
  const m = src.match(re);
  if (!m) {
    console.log('  ! 未找到 ErrorBanner', rel);
    continue;
  }
  if (m[1].includes('kept')) {
    console.log('  - 已有 kept，跳过', rel);
    continue;
  }
  src = src.replace(re, `<ErrorBanner${m[1]} :kept="'${kept.replace(/'/g, "\\'")}'" />`);
  writeFileSync(abs, src, 'utf8');
  changed += 1;
  console.log('  ✓', rel);
}

/* --------------------------------------------------- 局部失败（§5.1 ②） */

/** 每个页面的局部失败配置：只列出"确实还有可用内容"的次要请求 */
const PARTIAL = [
  {
    rel: 'pages/Products.vue',
    // 分类下拉挂了 → 商品照样能管，只是"全部分类"这一项失效
    cond: 'categories.error.value && products.data.value',
    title: '商品分类没加载出来',
    safe: '已显示的商品可以直接增删改，「按分类筛选」暂时用不了。',
    retry: 'categories.run()',
    retryLabel: '只重试分类',
    anchor: '<ErrorBanner',
  },
  {
    rel: 'pages/StockLogs.vue',
    // 筛选下拉挂了 → 流水照样能看，只是筛选维度少了
    cond: '(products.error.value || buildings.error.value) && logs.data.value',
    title: '筛选项没加载出来',
    safe: '已显示的流水可以直接查看，按商品或楼栋筛选暂时用不了。',
    retry: 'products.run(); buildings.run()',
    retryLabel: '只重试筛选项',
    anchor: '<ErrorBanner',
  },
  {
    rel: 'pages/Dashboard.vue',
    // 账务与店铺配置挂了 → 订单照常处理，只是顶部几张卡与打烊提示缺失
    cond: '(billing.error.value || config.error.value) && orders.data.value',
    title: '店铺状态与账务卡没加载出来',
    safe: '已显示的订单可以直接接单、配送，不受影响。',
    retry: 'billing.run(); config.run()',
    retryLabel: '只重试这部分',
    anchor: '<ErrorBanner',
  },
];

for (const p of PARTIAL) {
  const abs = join(web, p.rel);
  let src = readFileSync(abs, 'utf8');
  if (src.includes('PartialFailure')) {
    console.log('  - 已接局部失败，跳过', p.rel);
    continue;
  }
  const at = src.indexOf(p.anchor);
  if (at < 0) {
    console.log('  ! 未找到锚点', p.rel);
    continue;
  }
  const lineEnd = src.indexOf('\n', at);
  const indent = src.slice(src.lastIndexOf('\n', at) + 1, at);
  const block =
    `\n${indent}<PartialFailure\n` +
    `${indent}  v-if="${p.cond}"\n` +
    `${indent}  title="${p.title}"\n` +
    `${indent}  safe="${p.safe}"\n` +
    `${indent}  @retry="${p.retry}"\n` +
    `${indent}  retry-label="${p.retryLabel}"\n` +
    `${indent}/>`;
  src = src.slice(0, lineEnd) + block + src.slice(lineEnd);

  // 补 import（放在 ErrorBanner import 之后）
  const imp = "import ErrorBanner from '@/components/ErrorBanner.vue';";
  src = src.replace(imp, `${imp}\nimport PartialFailure from '@/components/PartialFailure.vue';`);
  writeFileSync(abs, src, 'utf8');
  changed += 1;
  console.log('  ✓ 局部失败', p.rel);
}

console.log(`\n共修改 ${changed} 处。`);
