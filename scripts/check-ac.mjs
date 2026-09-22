#!/usr/bin/env node
/**
 * AC 守卫：把《全量页面与闭环 v3.0》§7 的 20 条验收项里**能机器判定的几条**固化成断言。
 *
 * 为什么只管这几条，而不是 20 条全判：
 *   20 条里有相当一部分是"视觉判断"（骨架是否同构、库存格是否双重编码），
 *   机器只能验证"引用了正确的 Token"，验证不了"看起来对不对"。
 *   把它们写成子串匹配只会产生一种**假的安全感** —— 护栏全绿，
 *   但页面上依然是错的。所以这里只收"能 100% 判定、零误报"的那几条，
 *   其余的留在 `docs/AC自查_20条.md` 里人工逐条核对并写明判据。
 *
 * 收录的判据与理由：
 *   AC-01 楼栋牌只有一处实现 —— 它是签名组件，各页各画一版就会长成不同高度
 *                                （历史上真的长成过：结算页 32px、地址页 46px）。
 *   AC-13 房间号不出现在平台端 —— 数据访问层不返回，而不是前端隐藏。
 *                                这条能判是因为"不返回"是代码事实，不是渲染事实。
 *   AC-15 学生端没有"确认收货" —— D15 定了送达即终态。
 *   AC-16 每个状态块都要说"为什么" —— 空态只写"暂无数据"是最常见的偷懒。
 *   AC-17 停送不清库存 —— 停送与清库存是两个动作，代码里若同时改 stock 就是错。
 *
 * 用法：
 *   node scripts/check-ac.mjs           扫描并报告
 *   node scripts/check-ac.mjs --list    打印每条命中所在的文件与行号
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const LIST = process.argv.includes('--list');

/** 剥离注释：注释里必然会引用被禁的词（"禁止写 X"本身就是一句正确的话） */
function stripComments(src, isVue) {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  if (isVue) s = s.replace(/<!--[\s\S]*?-->/g, '');
  return s;
}

function read(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return stripComments(raw, file.endsWith('.vue'));
}

/* ------------------------------------------------------------------ AC-01 */

/**
 * 楼栋牌（签名组件）只允许有一个实现：`SnBuildingBar.vue`。
 * 骨架屏要占位，所以 `SnPageSkeleton.vue` 也允许引用它的尺寸 Token ——
 * 但**只允许引用尺寸**，不允许自己定义底色和文字（那等于又画了一版）。
 */
const CHIP_OWNER = 'SnBuildingBar.vue';
const CHIP_PLACEHOLDER = 'SnPageSkeleton.vue';
const CHIP_TOKENS = ['--building-chip-h', '--building-chip-r', '--building-chip-bg', '--building-chip-fg'];

function checkAC01(files) {
  const bad = [];
  for (const f of files) {
    const base = path.basename(f);
    if (base === CHIP_OWNER) continue;
    const src = read(f);
    const isPlaceholder = base === CHIP_PLACEHOLDER;
    src.split('\n').forEach((line, i) => {
      const hit = CHIP_TOKENS.find((t) => line.includes(t));
      if (!hit) return;
      if (isPlaceholder && (hit === '--building-chip-h' || hit === '--building-chip-r')) return;
      bad.push({ file: f, line: i + 1, hit });
    });
  }
  return bad;
}

/* ------------------------------------------------------------------ AC-13 */

/**
 * 平台端（P-xx）不得接触房间号。
 * 判据：platform 模块里不出现 room 系列的**字段访问**。
 * 只拦字段访问（`room` / `roomNo` / `room_no` / `roomNumber`），
 * 不拦"房间号"这三个汉字 —— 注释里需要解释为什么不能有。
 */
const ROOM_FIELD = /\b(room|roomNo|room_no|roomNumber|roomCode)\b/;

function checkAC13(files) {
  const bad = [];
  for (const f of files) {
    if (!/apps[\\/]server[\\/]src[\\/]platform[\\/]/.test(f)) continue;
    const src = read(f);
    src.split('\n').forEach((line, i) => {
      if (ROOM_FIELD.test(line)) bad.push({ file: f, line: i + 1, hit: line.trim().slice(0, 60) });
    });
  }
  return bad;
}

/* ------------------------------------------------------------------ AC-15 */

/**
 * 学生端不得出现"确认收货"**这个动作**。送达是商户动作（D15），
 * 学生确认收货只会引入"学生忘了点 → 钱卡在中间"的一整类问题。
 *
 * 为什么不拦这四个字本身：
 *   订单详情页写着「送达由店家标记……不需要你确认收货」——
 *   这句话恰恰是在**解释为什么没有这个按钮**，是有价值的说明，删掉它反而更差。
 *   所以判据落在"这一行是否在提供这个动作"上：带否定词的说明放行，
 *   其余（按钮文案、标题、提示）一律拦下。
 */
const STUDENT_PAGES = /apps[\\/]mini[\\/]src[\\/]pages[\\/]/;
const NOT_DOING = /不需要|无需|不必|没有|不存在|不做|不用/;

function checkAC15(files) {
  const bad = [];
  for (const f of files) {
    if (!STUDENT_PAGES.test(f) || f.includes('pages-merchant')) continue;
    const src = read(f);
    src.split('\n').forEach((line, i) => {
      if (!line.includes('确认收货')) return;
      if (NOT_DOING.test(line)) return;
      bad.push({ file: f, line: i + 1, hit: '确认收货' });
    });
  }
  return bad;
}

/* ------------------------------------------------------------------ AC-16 */

/**
 * 每个 SnStateBlock 都必须给 `desc`（"为什么是这样"）。
 *
 * 只判 desc，不判"有没有按钮"：有几种空态的出路**不在本页**
 * （例如"到电脑端添加商品"、"看看左边其他分类"），
 * 硬要给按钮就只能给一个点了没反应的假按钮，那比不给更糟。
 * 那几种在 `docs/AC自查_20条.md` 里逐条写明理由。
 *
 * 标签结束的判定：匹配到「行首缩进 + 可选 / + >」，
 * 这样才不会被属性值里的 `>`（三元表达式很常见）提前截断。
 */
const STATE_TAG = /<SnStateBlock\b([\s\S]*?)\n[ \t]*(?:\/)?>/g;

function checkAC16(files) {
  const bad = [];
  for (const f of files) {
    if (!f.endsWith('.vue')) continue;
    const src = read(f);
    for (const m of src.matchAll(STATE_TAG)) {
      const block = m[1];
      if (/(?<![a-zA-Z-])desc/.test(block)) continue;
      const line = src.slice(0, m.index).split('\n').length;
      bad.push({ file: f, line, hit: 'SnStateBlock 缺少 desc' });
    }
  }
  return bad;
}

/* ------------------------------------------------------------------ AC-17 */

/**
 * 停送 ≠ 清库存。
 * 判据：楼栋停送/启用的服务端代码里，不得出现把 stock 归零或重置的写法。
 * 命中不代表一定错了（可能是别处的库存操作），所以这条只报位置、不自动失败，
 * 由人确认 —— 宁可让人看一眼，也不要静默放过"停送顺手清零"。
 */
const STOCK_ZERO = /(stock\s*=\s*0|stock\s*=\s*\{|stock:\s*0\b|resetStock|clearStock|stock\.clear\(\))/;

function checkAC17(files) {
  const bad = [];
  for (const f of files) {
    if (!/apps[\\/]server[\\/]src[\\/]/.test(f)) continue;
    if (!/building|deliver|停送/.test(f)) continue;
    const src = read(f);
    src.split('\n').forEach((line, i) => {
      if (STOCK_ZERO.test(line)) bad.push({ file: f, line: i + 1, hit: line.trim().slice(0, 60) });
    });
  }
  return bad;
}

/* ------------------------------------------------------------------ 扫描 */

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', '.build-prev']);
const EXTS = new Set(['.ts', '.vue', '.mjs', '.js']);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (EXTS.has(path.extname(e.name))) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const files = walk(path.join(ROOT, 'apps'));

const RULES = [
  { id: 'AC-01', what: '楼栋牌只有一处实现（其余页面不得自己画）', run: checkAC01, fatal: true },
  { id: 'AC-13', what: '平台端不接触房间号字段', run: checkAC13, fatal: true },
  { id: 'AC-15', what: '学生端没有「确认收货」', run: checkAC15, fatal: true },
  { id: 'AC-16', what: '每个状态块都写了「为什么」', run: checkAC16, fatal: true },
  { id: 'AC-17', what: '停送不清库存（命中需人工确认）', run: checkAC17, fatal: false },
];

let failed = 0;
let warned = 0;

for (const r of RULES) {
  const hits = r.run(files);
  if (!hits.length) {
    console.log(`  ✓ ${r.id} ${r.what}`);
    continue;
  }
  if (r.fatal) failed += 1;
  else warned += 1;
  console.log(`  ${r.fatal ? '✗' : '!'} ${r.id} ${r.what} —— ${hits.length} 处`);
  if (LIST) for (const h of hits) console.log(`      ${path.relative(ROOT, h.file)}:${h.line}  ${h.hit}`);
}

console.log('');
if (failed) {
  console.error(`[check-ac] 失败 —— ${failed} 条验收项未通过${warned ? `，另有 ${warned} 条需人工确认` : ''}`);
  process.exit(1);
}
console.log(`[check-ac] 通过 —— ${RULES.length - warned} 条机器可判的验收项全部满足${warned ? `，${warned} 条需人工确认（已列出位置）` : ''}`);
