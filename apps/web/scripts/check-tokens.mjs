/**
 * AC-04 强制检查（网页后端台）：不得出现硬编码色值。
 *
 * 与 apps/mini/scripts/check-tokens.mjs 是同一条规则的两个执行点 ——
 * 规则本身只在 packages/tokens 里定义一次，两端各自跑各自的扫描，
 * 因为产物形态不同（小程序是 WXSS，网页是 CSS），但**纪律必须一样严**。
 *
 * 为什么需要脚本而不是靠评审：
 *   「Token 单一真相源」被绕过一次（写死一个 #F26B21），换肤就在那一处失效，
 *   而默认主题下颜色是对的 —— 只在切到第二个租户时才暴露，那时已经上线了。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../src');

/** 白名单：文件路径（相对 src）→ 理由 */
const WHITELIST = {
  'styles/tokens.generated.css': 'Token 生成物 —— 色值的唯一容器',
};

const SCAN_EXT = ['.vue', '.css', '.ts'];
const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(/g;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const violations = [];

for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  if (!SCAN_EXT.includes(extname(file))) continue;
  if (WHITELIST[rel]) continue;

  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    // 注释里的色值不算 —— 设计说明本身会引用色值
    const stripped = line.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/, '');
    const found = stripped.match(COLOR_RE);
    if (found) violations.push({ rel, line: i + 1, match: found.join(', '), text: line.trim() });
  });
}

if (violations.length) {
  console.error(`\n[AC-04] 发现 ${violations.length} 处硬编码色值（应改为引用 Token）：\n`);
  for (const v of violations) {
    console.error(`  ${v.rel}:${v.line}  ${v.match}\n      ${v.text}`);
  }
  console.error('\n修复方式：把色值换成 packages/tokens/src/tokens.css 里的变量。');
  console.error('若确属特殊场景，请在本脚本 WHITELIST 中登记并写明理由。\n');
  process.exit(1);
}

console.log('[AC-04] 通过 —— 未发现硬编码色值，样式全部走 Token');
