import { computed, onUnmounted, ref, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { useSessionStore } from '../stores/session';

/* ============================================================================
 * 倒计时（AC-14：显示可以用本地时钟平滑，**判定必须用服务端**）
 * ----------------------------------------------------------------------------
 * 为什么不能直接 `new Date()`：
 *   学生手机的时钟经常不准（手动改过时间、时区错、系统时间漂移）。
 *   待支付倒计时一旦用设备时钟算，就会出现"显示还剩 12 分钟，实际已经超时关单"——
 *   学生拿着这 12 分钟去充钱，回来发现单没了。这不是体验问题，是钱的问题。
 *
 * 做法：把服务端给的"剩余秒数"换算成一个**绝对到期时刻**（基于服务端时间轴），
 *       之后每次 tick 都用 `session.now()`（= 本地时间 + 启动时算出的偏移）去减。
 *       偏移在会话期内是常量，所以倒计时速率与真实时间一致，只是基准被校正了。
 *
 * 为什么共用一个定时器：
 *   订单列表里可能有 5 个待支付单。每行一个 setInterval 在小程序里是实打实的
 *   性能开销（低端安卓上能感到列表滚动发涩）。所以这里是**一个**定时器广播给所有订阅者，
 *   且没有订阅者时自动停掉 —— 不留"页面已卸载但定时器还在跑"的泄漏。
 * ==========================================================================*/

type Subscriber = (now: number) => void;

const subscribers = new Set<Subscriber>();
let timer: ReturnType<typeof setInterval> | null = null;

function tick(): void {
  const session = useSessionStore();
  const now = session.now();
  for (const fn of subscribers) fn(now);
}

function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  if (!timer) timer = setInterval(tick, 1_000);
  return () => {
    subscribers.delete(fn);
    if (!subscribers.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/**
 * @param source 剩余秒数。**支持传 ref/computed** —— 因为实际用法几乎总是
 *   "等接口回来才知道还剩多少秒"，而接口是异步的。如果这里只接受一个数字，
 *   调用方就得自己盯着 gate 什么时候加载完再去 new 一个倒计时，
 *   每多一个这样的手工同步点，就多一处"倒计时没启动"的静默 bug。
 *   null = 不适用（如已支付单）。
 * @returns remain：剩余秒数（不小于 0）；text：'MM:SS'；expired：是否已到期
 */
export function useCountdown(source: MaybeRefOrGetter<number | null>, onExpire?: () => void) {
  const remain = ref(0);
  const expired = ref(false);

  let expiresAtMs = 0;
  let fired = false;

  const off = subscribe((now) => {
    if (!expiresAtMs) return;
    const next = Math.max(0, Math.ceil((expiresAtMs - now) / 1_000));
    remain.value = next;
    if (next <= 0 && !fired) {
      fired = true;
      expired.value = true;
      // 到期回调只触发一次：调用方通常在这里去拉服务端确认（**不是**本地判定订单已关闭）
      onExpire?.();
    }
  });

  // 源变化 = 有了新的"剩余秒数"（通常是接口回来了），据此重算绝对到期时刻
  watch(
    () => toValue(source),
    (seconds) => {
      const session = useSessionStore();
      fired = false;
      expired.value = false;
      if (seconds === null || seconds === undefined) {
        expiresAtMs = 0;
        remain.value = 0;
        return;
      }
      expiresAtMs = session.now() + Math.max(0, seconds) * 1_000;
      remain.value = Math.max(0, Math.ceil(seconds));
    },
    { immediate: true },
  );

  onUnmounted(() => off());

  const text = computed(() => {
    const m = Math.floor(remain.value / 60);
    const s = remain.value % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  });

  return { remain, text, expired };
}

/** 相对时间（订单列表用）：刚刚 / 12 分钟前 / 昨天 18:20 */
export function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diffMin = Math.floor((Date.now() - t) / 60_000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (diffMin < 24 * 60) return `今天 ${hh}:${mm}`;
  if (diffMin < 48 * 60) return `昨天 ${hh}:${mm}`;
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${hh}:${mm}`;
}
