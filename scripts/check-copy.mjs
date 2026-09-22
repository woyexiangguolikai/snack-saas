#!/usr/bin/env node
/**
 * AC 守卫：中性文案 —— 禁用词不得进入产品文案。
 *
 * 规则不是"全库 0 命中"，而是**"只允许命中 1 个文件"**：
 *   禁用词必须被写下来才能被查，所以它天然要存在于一张表里
 *   （`apps/server/src/ledger/copy.ts` 的 BANNED_COPY）。
 *   如果某个词出现在第二个文件，说明有人把它写进了对用户展示的字符串 ——
 *   那就不是"词表"，而是"文案"了。
 * 这样既不留后门（不能靠"反正是词表"混过去），也不需要人去读几百个字符串。
 *
 * 与 check-tokens 一致：先剥注释。理由是需求/设计说明里必然会引用这些词
 * （"禁止使用 X"本身就是一句正确的话），注释不该被判违规。
 *
 * 用法：
 *   node scripts/check-copy.mjs            扫描并报告
 *   node scripts/check-copy.mjs --list     额外打印每个词命中的文件
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');

/** 词表的唯一合法归属地（相对仓库根） */
const VOCAB_FILE = path.posix.join('apps', 'server', 'src', 'ledger', 'copy.ts');

/** 扫描范围：只扫产品代码。设计文档是需求的来源，不是被交付的文案。 */
const SCAN_DIRS = ['packages', 'apps'];
const EXTS = new Set(['.ts', '.tsx', '.vue', '.mjs', '.js', '.json', '.wxml', '.wxss', '.css']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage']);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else {
      const ext = path.extname(e.name);
      if (EXTS.has(ext)) out.push(path.join(dir, e.name));
    }
  }
  return out;
}

/** 剥注释：块注释 + 行注释。字符串里的 // 不受影响（本仓的文案不含该序列）。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// 词表从 copy.ts 里读，避免在扫描器里再抄一份（抄一份就又成了第二个真相源）
const vocabSrc = fs.readFileSync(path.join(ROOT, VOCAB_FILE), 'utf8');
const banned = [...vocabSrc.matchAll(/^\s*'([^']+)',/gm)].map((m) => m[1]);
if (!banned.length) {
  console.error('[check-copy] 未能从词表文件解析出任何禁用词 —— 词表格式变了，请同步本脚本');
  process.exit(1);
}

const files = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
const hits = new Map(); // 词 → Set<相对路径>

for (const f of files) {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  let body;
  try {
    body = stripComments(fs.readFileSync(f, 'utf8'));
  } catch {
    continue;
  }
  for (const w of banned) {
    if (body.includes(w)) {
      if (!hits.has(w)) hits.set(w, new Set());
      hits.get(w).add(rel);
    }
  }
}

const violations = [];
for (const [word, set] of hits) {
  for (const rel of set) {
    if (rel !== VOCAB_FILE) violations.push({ word, file: rel });
  }
}

if (process.argv.includes('--list')) {
  console.log(`[check-copy] 词表（${banned.length} 词）：${banned.join(' / ')}`);
  console.log(`[check-copy] 扫描 ${files.length} 个文件，命中情况：`);
  for (const [w, set] of hits) console.log(`  ${w} → ${[...set].join(', ')}`);
}

if (violations.length) {
  console.error(`\n[check-copy] 失败 —— 禁用词进入了产品文案（共 ${violations.length} 处）：\n`);
  for (const v of violations) console.error(`  ✗ 「${v.word}」出现在 ${v.file}`);
  console.error(
    '\n  修法：把该处措辞换成中性说法（服务费 / 服务期 / 余额 / 充值），' +
      '\n  或从 @snack/server 的 ledger/copy.ts 里引用现成文案。',
  );
  process.exit(1);
}

const vocabHits = [...hits.values()].filter((s) => s.has(VOCAB_FILE)).length;
console.log(
  `[check-copy] 通过 —— 扫描 ${files.length} 个文件，` +
    `${banned.length} 个禁用词只出现在词表文件（${vocabHits}/${banned.length} 词已登记），` +
    `其余文件命中 0`,
);
