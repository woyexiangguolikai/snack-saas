/**
 * 元 ↔ 分 的换算。**只在这里做**。
 *
 * 服务端一律用分（整数）存储与计算，界面一律用元（小数）输入与显示。
 * 换算如果散落在各页面，迟早有一处漏乘 100 —— 而"配送费变成 200 元"
 * 这种错误在界面上看起来只是"数字有点大"，等到学生投诉才发现。
 */

export function yuanToCents(yuan: string | number): number {
  const n = typeof yuan === 'number' ? yuan : Number(String(yuan).trim());
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

export function centsToYuan(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** 输入框里只接受"最多两位小数的正数"，粘贴乱字符不会把配置写坏 */
export function sanitizeYuan(raw: string): string {
  const s = raw.replace(/[^\d.]/g, '');
  const parts = s.split('.');
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts[0]}.${(parts[1] ?? '').slice(0, 2)}`;
}
