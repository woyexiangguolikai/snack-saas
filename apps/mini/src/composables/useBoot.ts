import { ref, onUnmounted } from 'vue';
import { useSessionStore } from '../stores/session';

/**
 * S-01 启动闪屏 / S-02 租户解析骨架 —— 启动三态的唯一实现。
 *
 * 为什么不做成两个独立页面：
 *   ① 独立页要 `redirectTo` 跳一次，会闪一下白屏；
 *   ② 更要命的是 S-02 的骨架**必须带 TabBar**（原型图上 TabBar 就在），
 *      而跳页会把 TabBar 连同页面栈一起重建 —— 视觉上"底部栏闪了两下"。
 *   所以两者都落在首页内部，是首页的阶段，不是首页的上一页。
 *
 * 三个阶段的判定：
 *   splash   —— 有本地缓存（店名）才能"立刻有内容"，所以只有缓存存在时才值得停留。
 *              没有缓存的首次安装只遮 300ms 白屏，绝不让人盯着一块空的品牌色发呆。
 *   skeleton —— resolve 超过闪屏上限还没回来，就渲染首页骨架。
 *              骨架预留了楼栋牌、时间条的位置，数据到达时不会跳版（AC-06）。
 *   content  —— resolve 结束（无论成功还是业务失败）。
 *              业务失败（未开通/停用）由页面跳 S-03，不在这一层处理。
 */
export type BootPhase = 'splash' | 'skeleton' | 'content';

/** 闪屏上限仅作**封顶**，不是目标时长 —— resolve 一回来就立刻进内容，不刻意停留 */
const SPLASH_MAX_WITH_CACHE = 1_200;
/** 没缓存时只够遮住白屏，多停一毫秒都是浪费用户的时间 */
const SPLASH_MAX_NO_CACHE = 300;
/** 超过这个时间还没解析完，就在骨架顶部给一句人话 */
const SLOW_NETWORK_MS = 3_000;
/**
 * 与 .home__splash 的 opacity 过渡时长必须一致 —— 用 Token `--d-fade`（220ms）。
 * 早了会在动画播完前把元素卸掉，看到的就是一次硬切。
 */
const SPLASH_FADE_MS = 220;

export function useBoot() {
  const session = useSessionStore();

  const phase = ref<BootPhase>('splash');
  /** 闪屏是否还挂在 DOM 上（淡出动画播完才卸载，否则会"啪"地消失） */
  const splashMounted = ref(true);
  /** 慢网提示：骨架顶部细条 */
  const slow = ref(false);

  let started = false;
  let splashTimer: ReturnType<typeof setTimeout> | null = null;
  let fadeTimer: ReturnType<typeof setTimeout> | null = null;
  let slowTimer: ReturnType<typeof setTimeout> | null = null;

  function clearTimers(): void {
    if (splashTimer) clearTimeout(splashTimer);
    if (slowTimer) clearTimeout(slowTimer);
    splashTimer = null;
    slowTimer = null;
  }

  /** 进入内容态：启动一次闪屏淡出 */
  function toContent(): void {
    phase.value = 'content';
    slow.value = false;
    if (fadeTimer) clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => {
      splashMounted.value = false;
    }, SPLASH_FADE_MS);
  }

  /**
   * 页面 onLoad 里调用一次。
   * 重复调用无效果 —— tab 页切回来会再触发 onShow，闪屏不该重放。
   */
  function begin(): void {
    if (started) return;
    started = true;

    // 别处（如冷启动预热）已经解析完，直接进内容，不补播闪屏动画
    if (session.resolved) {
      phase.value = 'content';
      splashMounted.value = false;
      return;
    }

    const hasCache = !!session.shopName;
    splashTimer = setTimeout(() => {
      // 到上限：解析好了就进内容，没好就进骨架。
      // 绝不停在闪屏上等 —— 闪屏超时还能看，闪屏长时间不动就是"卡住了"。
      if (session.resolved) toContent();
      else phase.value = 'skeleton';
    }, hasCache ? SPLASH_MAX_WITH_CACHE : SPLASH_MAX_NO_CACHE);

    slowTimer = setTimeout(() => {
      slow.value = true;
    }, SLOW_NETWORK_MS);
  }

  /**
   * resolve 结束时调用。
   * @param ok 是否解析成功。失败时不进骨架（骨架会一直转下去），交给页面自己的错误态。
   */
  function settle(ok: boolean): void {
    clearTimers();
    if (ok) toContent();
    else {
      // 业务失败：立刻收掉闪屏，让页面的错误/跳转接管
      phase.value = 'content';
      slow.value = false;
      splashMounted.value = false;
    }
  }

  /** 慢网重试：把慢网条撤掉，让骨架继续转（重试由调用方发起） */
  function retrying(): void {
    slow.value = false;
    if (slowTimer) clearTimeout(slowTimer);
    slowTimer = setTimeout(() => {
      slow.value = true;
    }, SLOW_NETWORK_MS);
  }

  onUnmounted(() => {
    clearTimers();
    if (fadeTimer) clearTimeout(fadeTimer);
  });

  return { phase, splashMounted, slow, begin, settle, retrying };
}
