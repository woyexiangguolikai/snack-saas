import { ref, shallowRef, computed } from 'vue';
import { ApiFailure } from '../utils/request';

/* ============================================================================
 * 异步数据状态机（"加载过渡与状态全集"的前端落点）
 * ----------------------------------------------------------------------------
 * 为什么必须统一成一个 composable，而不是每个页面自己写 `loading/error/data`：
 *
 * ① 三态各自容易写，**难的是三态之间的转换**：
 *    刷新时不能回到骨架（会闪）、重试失败不能把旧数据清掉（会更空）、
 *    空数据和"加载失败"必须分开（前者要说"没有商品"，后者要说"没连上"）。
 *    每个页面手写一遍，必然有页面把"请求失败"渲染成"暂无数据"——
 *    这是最误导用户的一类 bug。
 *
 * ② 错误必须**分类**。`NETWORK` 是可重试的，`TENANT_NOT_FOUND` 是要跳专用页的，
 *    403/401 是要触发登录的。统一在这里分类，页面只做 switch。
 * ==========================================================================*/

export type AsyncPhase = 'loading' | 'ready' | 'error';

export interface AsyncError {
  code: string;
  message: string;
  /** 值不值得给"重试"按钮：网络类 / 服务端 5xx 值得；业务拒绝不值得（重试还是一样的结果） */
  retryable: boolean;
}

export interface UseAsyncOptions<T> {
  /** 数据"空"的判据 —— 不传则用默认（数组长度为 0，或对象为 null） */
  isEmpty?: (data: T) => boolean;
  /** 草稿态：先用本地缓存渲染，避免首屏空一下（如购物车、上次的楼栋） */
  initial?: T | null;
}

const RETRYABLE_CODES = new Set(['NETWORK', 'HTTP_500', 'HTTP_502', 'HTTP_503', 'HTTP_504']);

function toAsyncError(e: unknown): AsyncError {
  if (e instanceof ApiFailure) {
    return { code: e.code, message: e.message, retryable: RETRYABLE_CODES.has(e.code) || e.status >= 500 };
  }
  const msg = e instanceof Error ? e.message : '操作没有完成，请重试';
  return { code: 'UNKNOWN', message: msg, retryable: true };
}

function defaultIsEmpty(data: unknown): boolean {
  if (data === null || data === undefined) return true;
  if (Array.isArray(data)) return data.length === 0;
  if (typeof data === 'object' && 'items' in (data as object)) {
    const items = (data as { items?: unknown }).items;
    return Array.isArray(items) ? items.length === 0 : false;
  }
  return false;
}

export function useAsync<T>(fetcher: () => Promise<T>, opts: UseAsyncOptions<T> = {}) {
  const phase = ref<AsyncPhase>('loading');
  const error = ref<AsyncError | null>(null);
  /** shallowRef：列表整体替换，不需要深层响应式（大列表下这是十倍级差异） */
  const data = shallowRef<T | null>((opts.initial ?? null) as T | null);
  /** 已有数据时的再次刷新 —— 与首次加载区分，前者不出骨架 */
  const refreshing = ref(false);

  const isEmpty = computed(() => (phase.value === 'ready' ? (opts.isEmpty ?? defaultIsEmpty)(data.value as T) : false));

  async function run(isRetry = false): Promise<void> {
    // 已有数据 → 只标记 refreshing，页面继续显示旧内容；无数据 → 出骨架
    if (data.value === null && !isRetry) phase.value = 'loading';
    else refreshing.value = true;
    error.value = null;

    try {
      data.value = await fetcher();
      phase.value = 'ready';
    } catch (e) {
      const err = toAsyncError(e);
      // 关键：**有旧数据时不清空**。刷新失败仍然让学生看到上一次的内容 + 一条错误提示，
      // 比整页变成错误页好得多（他至少还能看见商品）。
      if (data.value === null) phase.value = 'error';
      error.value = err;
    } finally {
      refreshing.value = false;
    }
  }

  /** 首次加载 / 重新加载（会出骨架） */
  function load(): Promise<void> {
    return run(false);
  }

  /** 重试：保留旧数据，只清错误 */
  function reload(): Promise<void> {
    return run(true);
  }

  /** 本地改写数据（如把某商品标为售罄）而不重新请求 */
  function patch(fn: (cur: T) => T): void {
    if (data.value !== null) data.value = fn(data.value);
  }

  /** 丢弃当前数据，回到"还没加载"—— 换楼栋后必须走这一步：
   *  否则新楼栋的列表会短暂显示旧楼栋的商品，学生看到别的楼的东西会很困惑 */
  function reset(): void {
    data.value = null;
    error.value = null;
    phase.value = 'loading';
  }

  return { phase, error, data, refreshing, isEmpty, load, reload, patch, reset };
}

/** 供页面：把错误码翻成"下一步该做什么"，页面据此决定是给重试按钮还是跳登录 */
export function errorAction(err: AsyncError | null): 'retry' | 'login' | 'none' {
  if (!err) return 'none';
  if (err.code === 'LOGIN_REQUIRED' || err.code === 'TOKEN_INVALID') return 'login';
  return err.retryable ? 'retry' : 'none';
}
