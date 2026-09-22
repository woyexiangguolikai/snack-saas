/**
 * 金额排版（设计系统 A-09）—— 全站唯一金额格式化实现。
 *
 * 铁律：服务端一律返回整数分，前端只做展示，不参与金额运算（A-09「数据来源」）。
 * 格式规则（这些是验收时会逐条对的）：
 *   ① 整元省去 .00（¥12 而非 ¥12.00）；有零头固定 2 位（¥12.50）
 *   ② 绝不出现一位小数（¥12.5 ✗）
 *   ③ ¥ 为半角，字号为主数字的 .62em，与数字基线对齐，不加空格
 *   ④ ≥10000 元加千分位（¥12,480）
 *   ⑤ 负数用 U+2212（−），不用连字符（-）；账本场景正数显式带 +
 */

export type AmountSign = '' | '+' | '−';

export interface AmountParts {
  sign: AmountSign;
  symbol: '¥';
  /** 整数部分（含千分位） */
  int: string;
  /** 小数部分（含前导小数点）；整元为 null */
  dec: string | null;
}

export interface AmountOptions {
  /** 账本/对账场景：正数显式显示 + */
  signed?: boolean;
}

const THOUSANDS_THRESHOLD = 10_000;

function withThousands(intDigits: string): string {
  if (Number(intDigits) < THOUSANDS_THRESHOLD) return intDigits;
  return intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 把整数分拆成可独立排版的片段。
 * 拆片段而不是直接给字符串，是因为大档金额里 ¥ 的字号是主数字的 .62em ——
 * 必须能分开加样式（A-09「符号」）。
 */
export function parseAmount(fen: number, opts: AmountOptions = {}): AmountParts {
  const n = Number.isFinite(fen) ? Math.trunc(fen) : 0;
  const abs = Math.abs(n);
  const yuan = Math.floor(abs / 100);
  const cents = abs % 100;

  let sign: AmountSign = '';
  if (n < 0) sign = '−';
  else if (n > 0 && opts.signed) sign = '+';

  return {
    sign,
    symbol: '¥',
    int: withThousands(String(yuan)),
    dec: cents === 0 ? null : '.' + String(cents).padStart(2, '0'),
  };
}

/** 纯文本形式（列表、导出、日志用） */
export function formatAmount(fen: number, opts: AmountOptions = {}): string {
  const p = parseAmount(fen, opts);
  return `${p.symbol}${p.sign}${p.int}${p.dec ?? ''}`;
}

/** 小档金额的语义色：入账 ok / 出账 danger / 持平 off（A-09） */
export function amountTone(fen: number): 'ok' | 'danger' | 'off' {
  if (fen > 0) return 'ok';
  if (fen < 0) return 'danger';
  return 'off';
}
