/**
 * 换肤护栏（验收项 AC-06）+ 主题色阶生成
 *
 * 商户提交的主题色 不允许直接使用。服务端生成九级色阶后必须校验
 * brand-600 与白字的对比度：
 *   · ≥ 4.5:1              → 直接采用
 *   · 3.5:1 ≤ x < 4.5:1    → 整体加深一级
 *   · < 3.5:1              → 整体加深两级 + 一句人话提示
 *
 * 不允许出现"提交什么就用什么"的实现 —— 那会让白字按钮在浅色主题下彻底看不清。
 */

export const BRAND_SCALE_STOPS = [50, 100, 200, 300, 400, 500, 600, 700, 800] as const;
export type BrandStop = (typeof BRAND_SCALE_STOPS)[number];
export type BrandScale = Record<BrandStop, string>;

export const WHITE = '#FFFFFF';
/** 白字需要的最低对比度。注意：校验对象是 brand-600（悬停/深文字位），不是 brand-500。 */
export const MIN_TEXT_CONTRAST = 4.5;

/** 默认色阶（蜜橙），与 tokens.css 中 --brand-* 完全一致 —— 改这里就必须同步改 tokens.css */
export const DEFAULT_BRAND_SCALE: BrandScale = {
  50: '#FFF6F0', 100: '#FFE8D9', 200: '#FFCFB0', 300: '#FFAE7E', 400: '#FF8B4D',
  500: '#F26B21', 600: '#D8551A', 700: '#B8440F', 800: '#8F3208',
};

/* ---------------------------------------------------------------- 颜色工具 */

type RGB = { r: number; g: number; b: number };
type HSL = { h: number; s: number; l: number };

export function normalizeHex(input: string): string {
  let hex = String(input ?? '').trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(hex)) hex = hex.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) throw new Error(`无效色值：${input}`);
  return `#${hex.toUpperCase()}`;
}

export function hexToRgb(hex: string): RGB {
  const h = normalizeHex(hex).slice(1);
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

export function rgbToHex({ r, g, b }: RGB): string {
  const c = (n: number) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0').toUpperCase();
  return `#${c(r)}${c(g)}${c(b)}`;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function rgbToHsl({ r, g, b }: RGB): HSL {
  const rr = r / 255, gg = g / 255, bb = b / 255;
  const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l: l * 100 };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6;
  else if (max === gg) h = ((bb - rr) / d + 2) / 6;
  else h = ((rr - gg) / d + 4) / 6;
  return { h: h * 360, s: s * 100, l: l * 100 };
}

export function hslToRgb({ h, s, l }: HSL): RGB {
  const hh = ((h % 360) + 360) % 360 / 360;
  const ss = clamp(s, 0, 100) / 100;
  const ll = clamp(l, 0, 100) / 100;
  if (ss === 0) {
    const v = ll * 255;
    return { r: v, g: v, b: v };
  }
  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
  const p = 2 * ll - q;
  const hue = (t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return { r: hue(hh + 1 / 3) * 255, g: hue(hh) * 255, b: hue(hh - 1 / 3) * 255 };
}

/** WCAG 相对亮度 */
export function relativeLuminance(color: string): number {
  const { r, g, b } = hexToRgb(color);
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/** WCAG 对比度，返回 1–21 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a), lb = relativeLuminance(b);
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/* ------------------------------------------------------------ 色阶生成 */

/**
 * 由商户提交的单色生成九级色阶。
 * 500 位置 = 提交色本身，浅色向 50 递浅、深色向 800 递深，保持色相不变、略降饱和。
 * 目标亮度锚点（L%）：让各级之间有可预期的视觉间距，而不是等分。
 */
const LIGHTNESS_ANCHORS: Record<BrandStop, number> = {
  50: 97, 100: 93, 200: 85, 300: 75, 400: 64, 500: 54, 600: 45, 700: 36, 800: 27,
};

export function generateBrandScale(seedHex: string, baseLightnessOverride?: number): BrandScale {
  const base = rgbToHsl(hexToRgb(normalizeHex(seedHex)));
  const baseL = baseLightnessOverride ?? base.l;
  // 平移量必须夹住：不做夹紧时，极浅的提交色会把整条色阶（含 800）都抬高到
  // 根本压不出深色的亮度区间，护栏就再也救不回来。
  const shift = clamp(baseL - LIGHTNESS_ANCHORS[500], -10, 10);
  const out = {} as BrandScale;
  for (const stop of BRAND_SCALE_STOPS) {
    const anchor = LIGHTNESS_ANCHORS[stop];
    const l = clamp(anchor + shift * (1 - Math.abs(anchor - LIGHTNESS_ANCHORS[500]) / 100), 4, 99);
    // 越浅越降饱和（避免浅底发灰）、越深越提饱和（避免深色发浊）
    const s = clamp(base.s * (stop < 500 ? 0.92 : stop === 500 ? 1 : 1.04), 8, 96);
    out[stop] = rgbToHex(hslToRgb({ h: base.h, s, l }));
  }
  out[500] = normalizeHex(seedHex); // 500 永远是提交色原值，避免回算偏差
  return out;
}

/** 整条色阶按给定档数加深：把色阶向深端平移（600 的值成为新的 500，其余按比例下移） */
export function deepenScale(scale: BrandScale, levels: 1 | 2): BrandScale {
  const shift = (stop: BrandStop): BrandStop =>
    clamp(stop + levels * 100, 50, 800) as BrandStop;
  const out = {} as BrandScale;
  for (const stop of BRAND_SCALE_STOPS) out[stop] = scale[shift(stop)];
  return out;
}

/**
 * 结构性保证「深端与白字的对比度达标」。
 *
 * 为什么不能只靠"加深一级/两级"：对高饱和暖色（橙、红），**即使把亮度压到 8%，
 * 与白字的对比度也上不去**（R 通道始终接近满值，相对亮度降不下来）。
 * 实测 #FFEEDD 这类极浅提交色，反复加深到色阶触底仍只有 2.34:1。
 * 因此只能同时**降饱和**——把纯色往灰里带，亮度才真正降得下来。
 * 这一步是"白字看得清"的唯一保证；"加深一级/两级"负责的是视觉层次，不是可读性。
 */
export function enforceTextContrast(
  scale: BrandScale,
  target: number = MIN_TEXT_CONTRAST,
  stops: readonly BrandStop[] = [600, 700, 800],
): BrandScale {
  const out = { ...scale };
  let guard = 0;
  while (contrastRatio(out[600], WHITE) < target && guard < 40) {
    for (const s of stops) {
      const hsl = rgbToHsl(hexToRgb(out[s]));
      out[s] = rgbToHex(
        hslToRgb({
          h: hsl.h,
          s: clamp(hsl.s - 6, 4, 100),
          l: clamp(hsl.l - 3, 5, 100),
        }),
      );
    }
    guard += 1;
  }
  return out;
}

/* ------------------------------------------------------------ 护栏主入口 */

export interface ThemeGuardResult {
  /** 最终采用的色阶 */
  scale: BrandScale;
  /** 触发了几级加深：0 = 直接采用 */
  deepened: 0 | 1 | 2;
  /** 提交色与白字的对比度（原始值，未经加深） */
  submittedContrast: number;
  /** 最终 brand-600 与白字的对比度 */
  finalContrast: number;
  /** 给商户看的人话提示，null = 无需提示 */
  notice: string | null;
}

/**
 * 校验并修正商户提交的主题色。
 * 这是 AC-06 的唯一实现入口 —— 服务端保存店铺配置时必须走这里，不允许旁路。
 */
export function guardThemeColor(submittedHex: string): ThemeGuardResult {
  const submitted = normalizeHex(submittedHex);
  const scale500 = generateBrandScale(submitted);
  const submittedContrast = round2(contrastRatio(submitted, WHITE));

  let deepened: 0 | 1 | 2 = 0;
  let scale = scale500;

  if (submittedContrast < 4.5 && submittedContrast >= 3.5) {
    deepened = 1;
    scale = deepenScale(scale500, 1);
  } else if (submittedContrast < 3.5) {
    deepened = 2;
    scale = deepenScale(scale500, 2);
  }

  // 结构性收口：不论色相多极端，"深端白字可读"由算法保证，不靠反复加深去碰运气
  scale = enforceTextContrast(scale);
  let finalContrast = round2(contrastRatio(scale[600], WHITE));

  return {
    scale,
    deepened,
    submittedContrast,
    finalContrast,
    notice:
      deepened === 0
        ? null
        : '这个颜色偏浅，为了白字看得清，我们稍微调深了一点',
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 把色阶渲染成可注入的 CSS 变量块（服务端下发给前端时使用） */
export function scaleToCssVars(scale: BrandScale, selector = ':root'): string {
  const body = BRAND_SCALE_STOPS.map((s) => `  --brand-${s}: ${scale[s]};`).join('\n');
  return `${selector} {\n${body}\n}`;
}
