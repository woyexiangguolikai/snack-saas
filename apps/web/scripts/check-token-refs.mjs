#!/usr/bin/env node
/**
 * Token 引用完整性守卫（网页后端台）—— 抓「引用了不存在的 Token」。
 *
 * 与 AC-04 的「不许写死色值」互补：那条管**多出来的字面量**，这条管**引用了不存在的东西**。
 * CSS 里 `var(--does-not-exist)` 不会报任何错，整条声明静默失效、颜色回落成继承值，
 * 表现是"样式看起来不太对"，但构建全绿、控制台干净，查起来极其费时。
 *
 * 逻辑与 apps/mini/scripts/check-token-refs.mjs 完全一致，只是根目录不同
 * （两份脚本各管各的 src，不共用以免跨端路径假设互相污染）。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');
const GENERATED = path.join(SRC, 'styles', 'tokens.generated.css');

if (!fs.existsSync(GENERATED)) {
  console.error(`[check-token-refs] 找不到 Token 文件：${GENERATED}\n  先跑 npm run tokens:sync`);
  process.exit(1);
}

/* ① 定义侧：Token 文件里声明过的全部名字。
      一行可能写多个（如 `--fw-normal: 400; --fw-medium: 500;`），
      所以不能用行首匹配 —— 那样会漏掉同一行后面的 Token。 */
const definitions = new Set(
  [...fs.readFileSync(GENERATED, 'utf8').matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]),
);

/* ② 引用侧：src 下所有样式来源（生成物本身除外） */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(vue|css)$/.test(e.name)) out.push(p);
  }
  return out;
}

const problems = [];
let checkedRefs = 0;
let checkedFiles = 0;

for (const file of walk(SRC)) {
  if (path.resolve(file) === path.resolve(GENERATED)) continue;
  checkedFiles += 1;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/var\((--[a-z0-9-]*)/g)) {
      const name = m[1];
      // 动态拼接（如 var(--brand-${level})）会截出以 - 结尾的名字，跳过不误报
      if (name.endsWith('-')) continue;
      checkedRefs += 1;
      if (!definitions.has(name)) {
        problems.push({ file: path.relative(ROOT, file), line: i + 1, name });
      }
    }
  });
}

if (problems.length) {
  console.error(`[check-token-refs] 失败 —— ${problems.length} 处引用了未定义的 Token：\n`);
  for (const p of problems) {
    const near = [...definitions]
      .map((d) => ({ d, score: commonPrefix(d, p.name) }))
      .sort((a, b) => b.score - a.score)[0]?.d;
    console.error(`  ✗ ${p.file}:${p.line}  var(${p.name})  —— 未定义${near ? `，是不是想写 var(${near})` : ''}`);
  }
  console.error('\n  CSS 里 var() 引错名字不会报错，只会静默失效。请改成 Token 表里的名字。');
  process.exit(1);
}

console.log(
  `[check-token-refs] 通过 —— ${definitions.size} 个 Token、${checkedFiles} 个样式文件、${checkedRefs} 处引用全部有定义`,
);

function commonPrefix(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
}
