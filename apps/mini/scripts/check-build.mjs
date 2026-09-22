#!/usr/bin/env node
/**
 * 产物级守卫（两道）：
 *
 * ① 组件注册：抓「组件被引用但未注册」。
 *   为什么必须有这道检查：
 *     vue-tsc 不会报「模板里用了没 import 的组件」，uni-app 编译器也不报 ——
 *     它会照常把 <sn-sticky-bar> 写进 wxml，但不写进同目录 json 的 usingComponents。
 *     结果是构建全绿、开发者工具里才炸/白屏。我们已经因此真实踩过一次。
 *
 * ② 本机地址：抓「127.0.0.1 被打进包」。
 *    默认只**警告**（`build:mp` + 本机服务 + 开发者工具是合法的日常流程），
 *    加 `--release` 时**失败** —— 那是发布卡口。
 *    为什么需要它：`VITE_API_BASE` 没配会静默落到内置的 `http://127.0.0.1:3000`，
 *    构建全绿、真机才炸，且第一反应会去查域名备案，绕一大圈。
 *
 * 用法：
 *   node scripts/check-build.mjs              开发自检（本机地址仅警告）
 *   node scripts/check-build.mjs --release    发布卡口（本机地址直接失败）
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist', 'build', 'mp-weixin');
const RELEASE = process.argv.includes('--release');

if (!fs.existsSync(DIST)) {
  console.error(`[check-build] 产物不存在：${DIST}\n  先跑 npm run build:mp`);
  process.exit(1);
}

/** wxml 里的内置标签与 uni 运行时标签，不需要在 usingComponents 里注册 */
const BUILTIN = new Set([
  'view', 'text', 'block', 'image', 'scroll-view', 'swiper', 'swiper-item', 'template',
  'input', 'textarea', 'button', 'navigator', 'form', 'label', 'picker', 'picker-view',
  'checkbox', 'checkbox-group', 'radio', 'radio-group', 'switch', 'slider', 'progress',
  'icon', 'rich-text', 'video', 'audio', 'canvas', 'map', 'web-view', 'movable-area',
  'movable-view', 'cover-view', 'cover-image', 'open-data', 'ad', 'official-account',
  'wxs', 'slot', 'page-meta', 'navigation-bar', 'page-container', 'share-element',
  'match-media', 'functional-page-navigator', 'live-player', 'live-pusher',
]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const all = walk(DIST);
const wxmlFiles = all.filter((f) => f.endsWith('.wxml'));

const problems = [];
let checkedTags = 0;

for (const wxml of wxmlFiles) {
  const src = fs.readFileSync(wxml, 'utf8');
  // 取所有 <tag ...，排除自闭合与注释
  const tags = new Set(
    [...src.matchAll(/<([a-zA-Z][\w-]*)[\s/>]/g)]
      .map((m) => m[1])
      // 只关心自定义组件：含连字符且不是内置标签
      .filter((t) => t.includes('-') && !BUILTIN.has(t)),
  );
  if (!tags.size) continue;

  const jsonPath = wxml.replace(/\.wxml$/, '.json');
  let using = {};
  if (fs.existsSync(jsonPath)) {
    try {
      using = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).usingComponents ?? {};
    } catch (e) {
      problems.push({ file: path.relative(DIST, jsonPath), tag: '—', why: `json 解析失败：${e.message}` });
      continue;
    }
  }

  for (const t of tags) {
    checkedTags++;
    if (!(t in using)) {
      problems.push({
        file: path.relative(DIST, wxml),
        tag: t,
        why: '被 wxml 使用，但同目录 json 的 usingComponents 里没有它 —— 运行时必然报「组件未找到」',
      });
    } else {
      // 注册了还要看目标文件在不在（uni 有时会写字面路径却漏产物）
      const target = using[t];
      if (typeof target === 'string' && target.startsWith('.')) {
        const abs = path.resolve(path.dirname(wxml), target);
        const ok = ['.js', '.json', '.wxml', '.wxss'].every((ext) => fs.existsSync(abs + ext));
        if (!ok) {
          problems.push({
            file: path.relative(DIST, wxml),
            tag: t,
            why: `注册指向 ${target}，但产物文件不全（缺 ${['.js', '.json', '.wxml', '.wxss']
              .filter((ext) => !fs.existsSync(abs + ext))
              .join('/')}）`,
          });
        }
      }
    }
  }
}

if (problems.length) {
  console.error(`[check-build] 失败 —— 发现 ${problems.length} 处组件引用问题：\n`);
  for (const p of problems) console.error(`  ✗ ${p.file}\n     <${p.tag}> ${p.why}`);
  process.exit(1);
}

/* ---- 第二道：产物里的接口地址不得是本机 ---------------------------------- */

const LOOPBACK = /https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0)(?::\d+)?/gi;
const loopbackHits = [];

for (const file of all) {
  if (!file.endsWith('.js')) continue;
  const found = [...fs.readFileSync(file, 'utf8').matchAll(LOOPBACK)].map((m) => m[0]);
  if (found.length) loopbackHits.push({ file: path.relative(DIST, file), urls: [...new Set(found)] });
}

if (loopbackHits.length) {
  const lines = loopbackHits.map((h) => `  ✗ ${h.file} → ${h.urls.join(', ')}`).join('\n');
  if (RELEASE) {
    console.error(
      `[check-build] 发布卡口未通过 —— 产物里含本机地址，真机 / 体验版 / 正式版一定连不上：\n${lines}\n\n` +
        '  修法：把 apps/mini/.env.local 的 VITE_API_BASE 改成 https + 已备案域名，\n' +
        '        并在公众平台【开发 → 开发管理 → 服务器域名】加入 request 合法域名，然后重新 build:mp。',
    );
    process.exit(1);
  }
  console.warn(
    `[check-build] ⚠ 产物里含本机地址（开发模式可接受，发布前必须换掉）：\n${lines}\n` +
      '  真机 / 体验版 / 正式版连不上本机地址 —— 发布前跑 `npm run check:build -- --release` 卡一次。',
  );
}

console.log(
  `[check-build] 通过 —— ${wxmlFiles.length} 个 wxml、${checkedTags} 处自定义标签，全部已在 usingComponents 注册且产物完整` +
    (loopbackHits.length ? `；接口地址：本机（${RELEASE ? '已拦截' : '开发模式放行'}）` : '；接口地址：非本机'),
);
