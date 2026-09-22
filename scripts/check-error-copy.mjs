#!/usr/bin/env node
/**
 * AC 守卫：错误文案不得「单独出现」。
 *
 * 依据：《加载过渡与状态全集 v3.0》§5.4 文案对照表 ——
 *   以下六个短语**不得单独出现**：操作失败 / 系统错误 / 未知异常 / 请稍后重试 /
 *   网络异常 / 请求失败。每条错误必须是「原因 + 下一步」的结构，
 *   只写「操作失败」等于把问题原样退回给用户，他只能去问客服。
 *
 * 为什么不做"全库 0 命中"：
 *   「请稍后重试」写在「网络不太顺，请稍后重试」里是**对的** ——
 *   它已经带了原因。真正要拦的是"整条文案就只有这六个字"那种写法。
 *   所以判据落在**字符串字面量**上，而不是全文子串：
 *     ① 字面量恰好等于禁用短语                → 违规
 *     ② 字面量以禁用短语开头，紧跟标点/括号     → 违规（如「操作失败，请稍后重试」）
 *   这两条零误报：正常写法（原因在前）不会命中，而两种典型反模式都会被抓住。
 *
 * 诚实声明本护栏的边界：它只拦得住"句式"，拦不住"原因写错了"。
 * 后者靠人工按 §5.4 对照表逐条核对（需求原文也是这么要求的）。
 *
 * 用法：
 *   node scripts/check-error-copy.mjs           扫描并报告
 *   node scripts/check-error-copy.mjs --list    打印每条命中所在的文件与行号
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');

/** 禁用短语（唯一真相源就在这一行；本文件不在扫描范围内，所以不会自己命中自己） */
const BANNED = ['操作失败', '系统错误', '未知异常', '请稍后重试', '网络异常', '请求失败'];

/** 紧跟在这些字符后面，说明短语就是这条文案的开头（= 没有先说原因） */
const AFTER = new Set(['，', '。', '、', '（', '(', ',', '!', '！', '?', '？', ' ']);

/**
 * §5.4 文案对照表的「✓ 应改为」列 —— 这一列必须**真的出现在代码里**。
 *
 * 为什么要把这张表变成断言：
 *   上面那三条只禁止"句式不对"，禁止不了"根本没改"。对照表里的 10 条
 *   是需求方逐条给出的替换方案，如果只写在文档里，实现时漏掉两条没人会发现 ——
 *   漏掉的那两条正好是"商户和学生会看到的最差的两句话"。
 *
 * 判据是**关键词**而不是整句：整句里带业务变量（商品名、楼栋号、行号），
 * 不可能原样出现在代码里。关键词取的是每句话里"承载信息的那半句"。
 */
const REQUIRED = [
  { need: '可能是网络不稳定', why: '§5.4-1：页面级失败必须给出可能原因，不能只说"加载失败"' },
  { need: '购物车还在', why: '§5.4-2：提交失败必须说清数据保不保留（购物车还在）' },
  { need: '已售罄，请移出后重新提交', why: '§5.4-3：库存不足必须说清是哪个商品、哪栋楼' },
  { need: '正在重试（第', why: '§5.4-4：超时必须说明系统已在自动处理，并带上重试次数' },
  { need: '需要重新打开小程序', why: '§5.4-5：会话过期要说人话，不能写"登录已过期"' },
  { need: '今日已停送', why: '§5.4-6：楼栋不可用必须点明楼栋与恢复时间' },
  { need: '充值后立即恢复接单', why: '§5.4-7：不能只给要求（请充值），必须给恢复条件' },
  { need: '续费后即可继续接单', why: '§5.4-8：禁用"欠费"，用中性词并给出恢复条件' },
  { need: '不是数字', why: '§5.4-9：导入格式错误必须给行号与具体修复方式' },
  { need: '其余', why: '§5.4-10：导入失败要给出"能做什么"（其余 N 行可先导入）' },
];

/**
 * §5.4 文案对照表的「✕ 禁止出现」列 —— 这些写法**不得出现在用户可见文案里**。
 *
 * 判据是**子串**，和上面三条不同：这些反模式天生嵌在句子中间，
 * 「本栋库存不足了」既不是整条也不在开头，但正是对照表要拦的东西。
 *
 * 为什么这里**不重复**列「操作失败 / 系统错误 / 请稍后重试 / 网络异常 / 请求失败」：
 *   它们已经在 `BANNED` 里，而且用的是"整条 / 开头"判据。那种判据是**故意的**——
 *   「微信服务繁忙，请稍后重试」这种"先给原因再给下一步"的写法是合法的，
 *   换成子串判据会把正确写法也一起拦掉。✕ 列里这几条属于"句式错"，归 BANNED 管；
 *   剩下的（库存不足、请求超时、登录已过期……）属于"用词错"，才归这里管。
 *   「店铺已欠费」同理：`npm run check:copy` 已经在全库禁止"欠费"两个字。
 *
 * 扫描范围**排除测试文件**（见 SKIP_FORBIDDEN）：smoke.ts 里
 * `check('连续预占抢 1 件：只得一个成功，另一个库存不足')` 是写给人看的测试描述，
 * 不是用户文案。把它也拦下来只会逼着人把测试名改含糊 ——
 * 用降低可读性换护栏整齐，不划算。
 */
const FORBIDDEN = [
  { text: '库存不足', why: '§5.4-3：要说清哪个商品、哪一栋、还剩几件（例如"本栋最多能买 24 件"）' },
  { text: '请求超时', why: '§5.4-4：要说清系统已在自动重试，并带上第几次' },
  { text: '登录已过期', why: '§5.4-5：学生不知道"登录"指什么，要说"需要重新打开小程序"' },
  { text: '该楼栋不可用', why: '§5.4-6：要点明是哪一栋、什么时候恢复' },
  { text: '余额不足，请充值', why: '§5.4-7：要给恢复条件（"充值后立即恢复接单"），不能只提要求' },
  { text: '文件格式错误', why: '§5.4-9：要给行号与具体修复方式（"第 12 行价格「7.5元」不是数字，请改为 7.5"）' },
  { text: '导入失败', why: '§5.4-10：要说"能做什么"（"其余 237 行可先导入"）' },
];

const SCAN_DIRS = ['packages', 'apps'];
const EXTS = new Set(['.ts', '.tsx', '.vue', '.mjs', '.js', '.json']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage']);
/** 生成物不算文案来源（它们是 tokens 派生文件，不含用户可见句子） */
const SKIP_FILES = new Set(['tokens.generated.css']);
/** 测试文件：里面的字符串是测试描述，不是用户可见文案（理由见 FORBIDDEN 注释） */
const SKIP_FORBIDDEN = new Set(['smoke.ts']);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (EXTS.has(path.extname(e.name)) && !SKIP_FILES.has(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

/** 剥注释：注释里必然会引用这些词（"禁止写 X"本身就是一句正确的话） */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 取出所有字符串字面量（含反引号模板串的静态部分），带行号 */
function literals(src) {
  const out = [];
  const re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const text = m[1] ?? m[2] ?? m[3] ?? '';
    if (!text) continue;
    out.push({ text, line: src.slice(0, m.index).split('\n').length });
  }
  return out;
}

const files = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
const violations = [];
const forbidden = [];
/** 全库的字符串字面量拼成一个大串，用来查"必须存在"的关键词 */
const haystack = [];
let scanned = 0;

for (const f of files) {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  let body;
  try {
    body = stripComments(fs.readFileSync(f, 'utf8'));
  } catch {
    continue;
  }
  const lits = literals(body);
  scanned += lits.length;
  const skipForbidden = SKIP_FORBIDDEN.has(path.basename(f));
  for (const { text, line } of lits) {
    const t = text.trim();
    haystack.push(`${rel}\u0000${line}\u0000${t}`);
    for (const w of BANNED) {
      const isWhole = t === w;
      const startsHere = t.startsWith(w) && t.length > w.length && AFTER.has(t[w.length]);
      if (isWhole) {
        violations.push({ word: w, file: rel, line, text: t, how: '整条文案只有这六个字' });
      } else if (startsHere) {
        violations.push({ word: w, file: rel, line, text: t, how: '以禁用短语开头，没有先说原因' });
      }
    }
    if (!skipForbidden) {
      for (const w of FORBIDDEN) {
        if (t.includes(w.text)) forbidden.push({ word: w.text, why: w.why, file: rel, line, text: t });
      }
    }
  }
}

/* ---------------------------------------------- §5.4 对照表：必须已落地 */
const allText = haystack.join('\n');
const missing = REQUIRED.filter((r) => !allText.includes(r.need));

if (process.argv.includes('--list')) {
  console.log(`[check-error-copy] 禁用短语（${BANNED.length}）：${BANNED.join(' / ')}`);
  console.log(`[check-error-copy] §5.4 ✕ 列禁用写法（${FORBIDDEN.length} 条）：${FORBIDDEN.map((f) => f.text).join(' / ')}`);
  console.log(`[check-error-copy] §5.4 对照表必含关键词（${REQUIRED.length} 条）`);
  console.log(`[check-error-copy] 扫描 ${files.length} 个文件、${scanned} 条字符串字面量`);
}

if (missing.length) {
  console.error(`\n[check-error-copy] 失败 —— §5.4 文案对照表的替换方案有 ${missing.length} 条没有落地：\n`);
  for (const m of missing) {
    console.error(`  ✗ 找不到「${m.need}」`);
    console.error(`      ${m.why}`);
  }
  console.error('\n  这张表是需求方逐条给出的替换方案，不是建议。缺哪条就补哪条。\n');
  process.exit(1);
}

if (forbidden.length) {
  console.error(`\n[check-error-copy] 失败 —— §5.4 ✕ 列的禁用写法仍然出现（共 ${forbidden.length} 处）：\n`);
  for (const v of forbidden) {
    console.error(`  ✗ ${v.file}:${v.line}  「${v.text}」  ← 含禁用写法「${v.word}」`);
    console.error(`      ${v.why}`);
  }
  console.error('\n  修法：把"只说不行"改成"说清是哪件事 + 现在能做什么"。\n');
  process.exit(1);
}

if (violations.length) {
  console.error(`\n[check-error-copy] 失败 —— 错误文案"单独出现"（共 ${violations.length} 处）：\n`);
  for (const v of violations) {
    console.error(`  ✗ ${v.file}:${v.line}  「${v.text}」  ← ${v.how}`);
  }
  console.error(
    '\n  修法：改成「原因 + 下一步」结构，例如' +
      '\n    ✕ 操作失败              → ✓ 这一步没有完成，本次改动没有保存。可以再试一次。' +
      '\n    ✕ 网络异常              → ✓ 网络连不上，请检查网络后重试' +
      '\n    ✕ 请求失败（500）        → ✓ 服务器没有返回结果（状态 500），可以重新加载试试\n',
  );
  process.exit(1);
}

console.log(
  `[check-error-copy] 通过 —— 扫描 ${files.length} 个文件、${scanned} 条字符串字面量，` +
    `${BANNED.length} 个禁用短语未单独出现、${FORBIDDEN.length} 条 ✕ 列禁用写法未出现，` +
    `§5.4 对照表 ${REQUIRED.length} 条替换方案均已落地`,
);
