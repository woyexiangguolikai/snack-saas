import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

/**
 * 租户换肤（AC-05 / AC-06 / AC-12 的前端落点）。
 *
 * 边界划分：
 *   服务端  —— 持有换肤护栏算法（guardThemeColor），负责「浅色自动加深 + 白字对比度达标」，
 *              下发的一定是一整条已校验的 brand 色阶。
 *   前端    —— 只负责把这条色阶塞进 CSS 变量，不做任何颜色运算。
 *              前端再算一次就出现了第二个真相源。
 *
 * 两条结构性护栏（写在代码里，不靠自觉）：
 *   ① 只允许写 --brand-* ：语义色（--ok/--warn/--danger/--info/--off）永不换肤（AC-05）
 *   ② 平台后台锁死中性色：lockNeutral() 一旦调用，之后任何 applyTenantTheme 都是空操作（AC-12）
 */

export type BrandScaleInput = Record<string | number, string>;

const BRAND_STOPS = [50, 100, 200, 300, 400, 500, 600, 700, 800] as const;

/**
 * 注意这里**没有**一份「默认品牌色阶」的副本。
 * 默认值只存在于 packages/tokens/src/tokens.css —— 如果在这里再写一遍，
 * 就等于把 Token 抄成两份，将来改基线色时必然漏改一处。
 * 因此：没有租户主题时，themeStyle 返回空串，让 CSS 里的 Token 生效（而不是注入一份副本）。
 */
/**
 * 合法换肤键白名单。
 *
 * 为什么必须同时接受「裸数字键」和「带前缀键」：
 *   服务端 packages/tokens 的 generateBrandScale() 返回的是 `Record<BrandStop, string>`，
 *   即 `{ 50: '#..', 500: '#..' }` —— 这是最自然的序列化形态。
 *   如果前端只认 `--brand-500` 这种写法，就会出现「服务端下发的颜色被前端自己的护栏拦掉」
 *   这种最恶心的一类 bug：两端各自都对，合起来不工作。
 *   所以这里的判据是「是不是品牌色阶」，而不是「长什么样」。
 */
function isAllowedBrandKey(key: string): boolean {
  return (
    /^((--)?brand[-_]?)?(50|100|200|300|400|500|600|700|800)$/.test(key) ||
    /^(--)?brand[-_]?ring$/.test(key)
  );
}

export const useThemeStore = defineStore('theme', () => {
  const tenantCode = ref<string | null>(null);
  const scale = ref<BrandScaleInput | null>(null);
  /** 平台后台标记：置位后永久拒绝租户主题色 */
  const neutralLocked = ref(false);

  /** 生效中的租户覆盖值；null 表示「不注入，用 Token 默认值」 */
  const brandOverride = computed<Record<string, string> | null>(() => {
    if (neutralLocked.value || !scale.value) return null;
    return scale.value as Record<string, string>;
  });

  /** 注入到页面根节点的内联样式串；无租户主题时为空串 —— 空串是「什么都没改」，不是「改成了空」 */
  const themeStyle = computed(() => {
    const src = brandOverride.value;
    if (!src) return '';
    const parts: string[] = [];
    for (const stop of BRAND_STOPS) {
      const v = src[stop] ?? src[String(stop)];
      if (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) parts.push(`--brand-${stop}:${v}`);
    }
    const ring = src['--brand-ring'] ?? src.brandRing;
    if (typeof ring === 'string' && ring) parts.push(`--brand-ring:${ring}`);
    return parts.join(';');
  });

  /**
   * 应用租户主题。
   * 关键设计：**失败时返回结果而不是抛异常** ——
   * 换肤护栏是「不该发生」的不变量，但它一旦被触发，不该让整个页面白屏。
   * 非法键永远不会被写入（不变量仍然成立），同时把拒绝清单交回给调用方，让它可被观测和断言。
   */
  function applyTenantTheme(
    next: BrandScaleInput,
    code: string,
  ): { ok: boolean; rejected: string[] } {
    const rejected = Object.keys(next).filter((k) => !isAllowedBrandKey(String(k)));
    if (rejected.length) {
      console.error(
        `[theme] 拒绝非法换肤键（AC-05：语义色零换肤）：${rejected.join(', ')} —— 本次换肤整体放弃`,
      );
      return { ok: false, rejected };
    }
    // 护栏：平台后台锁死中性色（AC-12）
    if (neutralLocked.value) {
      return { ok: false, rejected: ['平台后台已锁死中性色，不接受租户主题色（AC-12）'] };
    }
    scale.value = next;
    tenantCode.value = code;
    return { ok: true, rejected: [] };
  }

  /** 平台后台入口调用一次即可锁死中性色 */
  function lockNeutral() {
    neutralLocked.value = true;
    scale.value = null;
  }

  function reset() {
    scale.value = null;
    tenantCode.value = null;
    neutralLocked.value = false;
  }

  return {
    tenantCode,
    neutralLocked,
    brandOverride,
    themeStyle,
    applyTenantTheme,
    lockNeutral,
    reset,
  };
});
