/**
 * Token 同步 —— 保证 AC-04「Token 单一真相源」在 uni-app 侧不被破坏。
 *
 * 为什么需要这一步：
 *   packages/tokens/src/tokens.css 用 `:root` 选择器（浏览器语义），
 *   而微信小程序的根选择器是 `page`（WXSS 里没有 :root）。
 *   如果在小程序里手抄一份，就出现了第二个真相源 —— 换肤时必然漏改一处。
 *
 * 做法：不手抄，构建前从唯一真相源生成，生成物带 DO NOT EDIT 头。
 *   --check 模式：比对生成物是否与源一致，不一致直接失败（用于 CI 与 typecheck）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../../../packages/tokens/src/tokens.css');
const OUT = resolve(here, '../src/styles/tokens.generated.css');
const checkOnly = process.argv.includes('--check');

const HEADER = `/* ============================================================================
 * 本文件由 apps/mini/scripts/sync-tokens.mjs 自动生成，请勿手工修改。
 * 唯一真相源：packages/tokens/src/tokens.css
 * 生成动作只做一件事：把 :root 选择器扩展为 ":root, page"，
 *   使同一份 Token 同时命中浏览器（:root）与微信小程序（page）。
 * 修改 Token 请改源文件，然后运行：npm run tokens:sync -w @snack/mini
 * ==========================================================================*/\n`;

const source = readFileSync(SRC, 'utf8');

// 单位策略：全站（含小程序）统一使用 px。
// 理由：设计系统的硬约束是「触摸目标 ≥44px」「描边 1px」——
// 这两条必须以 CSS px 为基准才成立；若换 rpx 会在小屏机上等比缩小，
// 反而破坏「拇指舒适区」与「1px 描边」两项设计要求。
// 代价：不做等比放大；收益：四端尺寸语义完全一致，Token 只需一份。
const output = HEADER + source.replace(/(^|[^\w-]):root\b/g, '$1:root, page');

if (checkOnly) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (current !== output) {
    console.error(
      '[tokens] 生成物与源不一致（或尚未生成）。\n' +
        '        请运行：npm run tokens:sync -w @snack/mini\n' +
        `        源：${SRC}\n` +
        `        生成物：${OUT}`,
    );
    process.exit(1);
  }
  console.log('[tokens] 一致 —— Token 单一真相源未被破坏');
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, output, 'utf8');
  console.log(`[tokens] 已生成 ${OUT}`);
}
