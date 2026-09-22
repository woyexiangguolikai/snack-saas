/**
 * CSV 解析与生成。
 *
 * 为什么只做 CSV 而不是直接读 .xlsx：解析在浏览器里做，.xlsx 需要引入一整个
 * SheetJS（几百 KB）才能解开 zip + XML。CSV 覆盖了绝大多数实际场景 ——
 * 商户手里的进货表本来就是 Excel 另存为 CSV 得到的。
 * 等真的需要 .xlsx 时，只需把 parseCsv() 换成 SheetJS 的 read()，后面的流程一行不用改。
 */

/** 解析 CSV 文本 → 二维数组。支持引号包裹、引号内的逗号与换行、CRLF */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuote = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"') {
        // 连续两个引号 = 一个字面引号
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuote = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuote = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      cell = '';
      rows.push(row);
      row = [];
    } else if (ch !== '\r') {
      cell += ch;
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** 生成 CSV。每个字段都加引号 —— 商品名里带逗号是一件很正常的事 */
export function toCsv(header: string[], rows: Array<Array<string | number>>): string {
  const esc = (v: string | number) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [header, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
}

export function downloadCsv(filename: string, content: string): void {
  // 带 BOM —— 否则 Excel 打开中文是乱码，而"打开是乱码"会被当成导入功能坏了
  const blob = new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
