/**
 * 平台后台的显示格式化。
 *
 * 只做"把服务端给的值变成人能一眼读的字符串"，不做任何计算 ——
 * **尤其是"卡了几天"这类派生数字，一律由服务端算好下发**：
 * 用浏览器时间算的话，用户改一下系统时间就能让看板全绿，
 * 而看板全绿恰恰是"没人在管"最危险的信号。
 */

/** 只取日期：2026-09-22 */
export function d10(iso: string | null | undefined): string {
  if (!iso) return '—';
  return iso.slice(0, 10);
}

/** 日期 + 时分：09-22 14:30 */
export function dt(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** "3 天前 / 今天 / 从没" —— 比裸时间戳更快读懂 */
export function ago(iso: string | null | undefined): string {
  if (!iso) return '从没';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  return `${days} 天前`;
}

/** 「订阅剩余」这类数字要带单位，且 null 有专门的说法（不是 0） */
export function daysText(n: number | null | undefined): string {
  if (n === null || n === undefined) return '无订阅';
  if (n < 0) return `已过期 ${Math.abs(n)} 天`;
  if (n === 0) return '今天到期';
  return `剩 ${n} 天`;
}

/** 卡点天数：0 天要写成"今天"，否则满屏的"0"看起来像没数据 */
export function stuckText(n: number): string {
  return n <= 0 ? '今天开始' : `卡 ${n} 个工作日`;
}

export const TONE_BG: Record<string, string> = {
  ok: 'var(--ok-bg)',
  warn: 'var(--warn-bg)',
  danger: 'var(--danger-bg)',
  off: 'var(--off-bg)',
  info: 'var(--info-bg)',
};

/** 语义色 → 文字色。平台侧只用这四类，永不接受租户主题色（AC-12） */
export function toneOf(v: 'ok' | 'warn' | 'danger' | 'off' | 'info'): string {
  return v;
}
