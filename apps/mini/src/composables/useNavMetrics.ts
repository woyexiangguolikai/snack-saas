/**
 * 自定义导航栏的几何量 —— 状态栏高度 + 胶囊位置，全项目**唯一来源**。
 *
 * 为什么必须用 JS 量，不能靠 CSS（这两个坑都真实踩过）：
 *
 *   ① `env(safe-area-inset-top)` 在微信小程序 webview 里恒为 0。
 *      它只覆盖 iOS 底部 home 条（`env(safe-area-inset-bottom)` 才有效）。
 *      拿它做顶部安全区，等于没做 —— 表现就是标题压在状态栏上、按钮压进胶囊里。
 *
 *   ② 即便 ① 成立也仍然会失效：页面样式表在 `app.wxss` **之后**加载，
 *      同优先级的 `.home__top { padding: 8px ... }` 会把 `.sn-safe-top { padding-top }`
 *      覆盖掉（后加载者赢）。所以顶部内边距**只能走行内样式** —— 行内样式不受样式表顺序影响。
 *
 *   ③ 胶囊（右上角「···⊙」）不保证恒为 87×32/距右 7（不同机型、不同微信版本都不同），
 *      一律用 `getMenuButtonBoundingClientRect()` 实测；量不到时回落官方默认值。
 *
 * 用法：
 *   const nav = useNavMetrics();
 *   <view :style="{ paddingTop: nav.statusBarHeight + 'px' }">
 *   <view :style="{ height: nav.navBarHeight + 'px', paddingRight: nav.rightReserve + 'px' }">
 */
import { computed } from 'vue';

export interface CapsuleRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

export interface NavMetrics {
  /** 状态栏高度（含刘海/挖孔） */
  statusBarHeight: number;
  /** 导航栏高度：与胶囊同高且垂直居中（= (胶囊上沿 − 状态栏) × 2 + 胶囊高） */
  navBarHeight: number;
  /**
   * 右侧必须留空的宽度：从屏幕右沿到胶囊左沿，再加一点呼吸位。
   * 这个宽度内**不得放任何可点元素** —— 胶囊是微信的，点不到也点不穿。
   */
  rightReserve: number;
  capsule: CapsuleRect | null;
  windowWidth: number;
}

/** 量不到胶囊时的兜底导航栏高度（微信官方示例值） */
const FALLBACK_NAV_BAR = 44;
/** 导航栏最小高度：低于这个值触摸目标太局促 */
const MIN_NAV_BAR = 40;
/** 胶囊左沿与右侧内容之间的呼吸位 */
const CAPSULE_GAP = 8;
/** 量不到窗口宽度时的兜底（iPhone 逻辑宽） */
const FALLBACK_WIDTH = 375;

let cached: NavMetrics | null = null;

function readWindow(): { statusBarHeight: number; windowWidth: number } {
  try {
    const u = uni as unknown as {
      getWindowInfo?: () => { statusBarHeight?: number; windowWidth?: number };
    };
    // getWindowInfo 是新接口；旧基础库上退回 getSystemInfoSync
    const info = u.getWindowInfo?.() ?? uni.getSystemInfoSync();
    return {
      statusBarHeight: info?.statusBarHeight ?? 0,
      windowWidth: info?.windowWidth ?? FALLBACK_WIDTH,
    };
  } catch {
    return { statusBarHeight: 0, windowWidth: FALLBACK_WIDTH };
  }
}

function readCapsule(): CapsuleRect | null {
  try {
    const u = uni as unknown as {
      getMenuButtonBoundingClientRect?: () => CapsuleRect;
    };
    // H5 端没有这个接口 —— 返回 null，由调用方按 0 处理
    const r = u.getMenuButtonBoundingClientRect?.();
    if (!r || !r.width || !r.height) return null;
    return r;
  } catch {
    return null;
  }
}

/** 量一次就缓存：这些值在一次会话内不会变（不支持横竖屏切换） */
export function readNavMetrics(): NavMetrics {
  if (cached) return cached;

  const { statusBarHeight, windowWidth } = readWindow();
  cached = computeNavMetrics(statusBarHeight, windowWidth, readCapsule());
  return cached;
}

/**
 * 纯计算部分，与 `uni.*` 解耦。
 *
 * 拆出来不是为了"好看"：真机差异只能靠一台台手机去试，而这里可以**在 Playground 里
 * 用几组真实机型参数当场验算**（见 `pages/playground/index.vue` 的自检面板）。
 * 把"我以为算对了"变成"这几个机型算对了"，代价只是把纯函数暴露出来。
 */
export function computeNavMetrics(
  statusBarHeight: number,
  windowWidth: number,
  capsule: CapsuleRect | null,
): NavMetrics {
  // 导航栏与胶囊同高且垂直居中 → 胶囊上下的留白相等，所以总高 = 上下留白 + 胶囊高
  const measured = capsule ? (capsule.top - statusBarHeight) * 2 + capsule.height : FALLBACK_NAV_BAR;
  const navBarHeight = Math.max(MIN_NAV_BAR, Math.round(measured));
  const rightReserve = capsule ? Math.round(windowWidth - capsule.left + CAPSULE_GAP) : 0;
  return { statusBarHeight, navBarHeight, rightReserve, capsule, windowWidth };
}

export function useNavMetrics(): NavMetrics {
  return readNavMetrics();
}

/** 顶部整块内容的下推高度：状态栏 + 导航栏（想整块内容落在胶囊下方时用它） */
export function useNavTotalHeight() {
  return computed(() => {
    const m = readNavMetrics();
    return m.statusBarHeight + m.navBarHeight;
  });
}
