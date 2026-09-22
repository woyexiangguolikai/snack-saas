/**
 * Token 同步（网页后端台）—— 保证 AC-04「Token 单一真相源」在浏览器端不被破坏。
 *
 * 与小程序那份的差异只有一处：小程序要把 `:root` 扩成 `:root, page`
 * （WXSS 里没有 `:root`），而浏览器端直接用 `:root` 即可。
 * 所以这里不改写选择器，只做搬运 —— **生成物与源必须逐字节相同**，
 * 这样"两边 Token 是否一致"这件事可以用 diff 一眼看出来。
 *
 *   --check 模式：比对生成物是否与源一致，不一致直接失败（用于 CI / verify）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../../../packages/tokens/src/tokens.css');
const OUT = resolve(here, '../src/styles/tokens.generated.css');
const checkOnly = process.argv.includes('--check');

const HEADER = `/* ============================================================================
 * 本文件由 apps/web/scripts/sync-tokens.mjs 自动生成，请勿手工修改。
 * 唯一真相源：packages/tokens/src/tokens.css
 * 修改 Token 请改源文件，然后运行：npm run tokens:sync -w @snack/web
 * ==========================================================================*/\n`;

const output = HEADER + readFileSync(SRC, 'utf8');

if (checkOnly) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (current !== output) {
    console.error(
      '[tokens] 生成物与源不一致（或尚未生成）。\n' +
        '        请运行：npm run tokens:sync -w @snack/web\n' +
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
