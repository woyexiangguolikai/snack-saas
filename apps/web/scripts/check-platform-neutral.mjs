#!/usr/bin/env node
/**
 * AC-12 / AC-13 的平台侧静态护栏。
 *
 * 两条规矩靠人工评审守不住：
 *
 *   ① **平台后台永不接受租户主题色**（AC-12）。
 *      危险之处在于它不需要有人故意违反 —— 只要有人在平台页里写了
 *      `class="btn btn--primary"`，那是个共用类，内部就引用 --brand-500，
 *      平台页当场跟着商户主题色走。这种泄漏在 code review 里极难看出来。
 *
 *   ② **平台侧任何页面不得出现房间号 / 楼层**（AC-13）。
 *      房间号只存在于租户库，平台视角没有正当的可见理由。
 *      服务端已经有出参断言（assertNoTenantPrivateFields），
 *      但前端也可能从别处拼出这个字段名，所以这里再扫一遍源码。
 *
 * 之所以做成脚本而不是写进文档：**文档约束的是记得它的人**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 按脚本自身位置定位 src，而不是 cwd —— 否则从仓库根直接跑会扫到 0 个文件，
// 然后打印"✓ 通过"。**静默通过比报错危险得多**：它会让护栏看起来是好的。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'src');

if (!fs.existsSync(SRC)) {
  console.error(`✗ 找不到源码目录：${SRC}（护栏脚本位置不对，拒绝静默通过）`);
  process.exit(1);
}

/** 平台侧的源码范围：平台页面 + 平台外壳 */
const PLATFORM_DIRS = ['pages/platform', 'platform'];

/** 平台专属文件里允许出现的"中性例外"（这个文件本身就是规则的定义处，暂无例外） */
const BRAND_ALLOW = new Set();

/**
 * 字段级检查只认**标识符**（roomNo / room_no / floorNo）。
 *
 * 中文「房间号」故意不做硬失败：它在平台侧的合法出现方式恰恰是**告诉操作者它不存在**
 * （租户详情页那句"只到楼栋级 —— 楼层与房间号属于租户库"就是合规的隐私护栏文案）。
 * 把这句话也禁掉，等于把护栏本身从界面上赶走，比不加检查更糟。
 * 所以中文词只统计、不拦，留给人工看一眼。
 */
const PRIVATE_FIELD_IDS = [
  { re: /\broomNo\b/, name: 'roomNo（房间号）' },
  { re: /\broom_no\b/, name: 'room_no（房间号）' },
  { re: /\bfloorNo\b/, name: 'floorNo（楼层）' },
  { re: /\bfullAddress\b/, name: 'fullAddress（完整门牌）' },
];

const PRIVATE_FIELD_WORDS = [/房间号/, /楼层号/];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (/\.(vue|ts)$/.test(f)) out.push(p);
  }
  return out;
}

const files = [];
for (const d of PLATFORM_DIRS) walk(path.join(SRC, d), files);

const problems = [];
const notes = [];
let brandRefs = 0;
let privateRefs = 0;
let wordRefs = 0;

for (const file of files) {
  const rel = path.relative(SRC, file).replace(/\\/g, '/');
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

  lines.forEach((line, i) => {
    const at = `${rel}:${i + 1}`;

    // ① 品牌色引用
    if (/var\(\s*--brand[-)]/.test(line)) {
      brandRefs += 1;
      if (!BRAND_ALLOW.has(rel)) {
        problems.push(
          `${at}  平台侧引用了品牌色 —— 商户换主题色时这里会跟着变色（AC-12）\n      ${line.trim()}`,
        );
      }
    }
    // 直接写死品牌色十六进制（tokens.css 里 --brand-500 就是这个值）
    if (/#F26B21/i.test(line)) {
      brandRefs += 1;
      problems.push(`${at}  平台侧写死了品牌色 #F26B21（AC-12 / AC-04）\n      ${line.trim()}`);
    }

    // ② 租户私有字段（标识符 → 硬失败）
    for (const f of PRIVATE_FIELD_IDS) {
      if (f.re.test(line)) {
        privateRefs += 1;
        problems.push(`${at}  平台侧出现了 ${f.name} —— 平台视角没有这个字段（AC-13）\n      ${line.trim()}`);
      }
    }

    // ③ 中文词 → 只统计（见文件上方说明）
    for (const w of PRIVATE_FIELD_WORDS) {
      if (w.test(line)) {
        wordRefs += 1;
        notes.push(`${at}  ${line.trim()}`);
      }
    }
  });
}

console.log(
  `[check-platform-neutral] 扫描 ${files.length} 个平台侧文件 · ` +
    `品牌色引用 ${brandRefs} · 私有字段标识符 ${privateRefs} · 中文词提及 ${wordRefs}（仅提示）`,
);

if (notes.length) {
  console.log('\n  「房间号 / 楼层号」字样出现位置（人工确认是护栏文案而非真取值）：');
  for (const n of notes) console.log(`    ${n}`);
}

if (problems.length) {
  console.error(`\n✗ 平台侧中性化检查失败（${problems.length} 项）：\n`);
  for (const p of problems) console.error(`  ${p}\n`);
  console.error(
    '  修法：平台侧只用 ink / line / paper / surface / ok / warn / danger / info；' +
      '需要"强调"时用 .pbtn--primary（墨色底）而不是 .btn--primary（品牌底）。\n',
  );
  process.exit(1);
}

console.log('✓ 平台侧中性化检查通过（零品牌色、零房间号）');
