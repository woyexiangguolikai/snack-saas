/**
 * AC-04 强制检查：全库不得出现硬编码色值。
 *
 * 为什么需要脚本而不是靠评审：
 *   「Token 单一真相源」一旦被绕过一次（比如某人在组件里写死 #F26B21），
 *   换肤功能就会在那一处失效，而且极难被肉眼发现 —— 因为默认主题下颜色是对的。
 *   这类问题只在切到第二个租户时才暴露，那时已经上线了。
 *
 * 允许的例外（白名单，必须显式登记并说明理由）：
 *   · tokens.generated.css            生成物，本身就是色值的唯一容器
 *   · #FFFFFF / #000000 之外的纯黑白 也一律走 Token，不给例外
 *   · SnBulkBar 的深色底 #221E1B     设计系统指定值，且不属于品牌/语义色族
 *   · 组件内 position 遮罩等 alpha 色 走 Token（--mask / --brand-ring / --danger-ring）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../src');

/** 白名单：文件路径（相对 src）→ 允许的色值及其理由 */
const WHITELIST = {
  'styles/tokens.generated.css': 'Token 生成物 —— 色值的唯一容器',
  'mock/theme-samples.ts':
    '灰盒换肤演示数据：模拟服务端下发的色阶，属于接口数据而非样式；删掉它组件照常工作，写进组件则换肤失效',
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

  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    // 注释行里的色值不算（设计说明会引用色值）
    const stripped = line.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/, '');
    const found = stripped.match(COLOR_RE);
    if (found) {
      violations.push({ rel, line: i + 1, match: found.join(', '), text: line.trim() });
    }
  });
}

if (violations.length) {
  console.error(`\n[AC-04] 发现 ${violations.length} 处硬编码色值（应改为引用 Token）：\n`);
  for (const v of violations) {
    console.error(`  ${v.rel}:${v.line}  ${v.match}\n      ${v.text}`);
  }
  console.error('\n修复方式：把色值换成 packages/tokens/src/tokens.css 里的变量，');
  console.error('若确属特殊场景（如深色批量条），请在本脚本 WHITELIST 中登记并写明理由。\n');
  process.exit(1);
}

console.log('[AC-04] 通过 —— 未发现硬编码色值，样式全部走 Token');
