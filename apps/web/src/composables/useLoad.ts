/**
 * 页面数据加载的四态收敛（加载中 / 出错 / 空 / 有内容）。
 *
 * 与小程序端 `useAsync` 是同一条纪律：每个列表页都必须能回答"现在是什么状态"，
 * 而不是让用户在"白屏"和"不知道有没有数据"之间猜。后台页面多，这个封装省掉的是
 * 十几份一模一样的 try/catch —— 更重要的是省掉"某个页面忘了处理出错"的可能。
 */
import { ref, type Ref } from 'vue';
import { ApiFailure } from '@/api/http';

export interface LoadResult<T> {
  data: Ref<T | null>;
  loading: Ref<boolean>;
  error: Ref<string>;
  run: () => Promise<void>;
}

export function useLoad<T>(fn: () => Promise<T>, opts: { immediate?: boolean } = {}): LoadResult<T> {
  const data = ref<T | null>(null) as Ref<T | null>;
  const loading = ref(false);
  const error = ref('');

  async function run(): Promise<void> {
    loading.value = true;
    error.value = '';
    try {
      data.value = await fn();
    } catch (e) {
      // ⚠️ **不清空 data**（AC-20）。
      // 失败的大多数是"这一次刷新"失败，上一次的数据仍然是当时正确的事实。
      // 把 data 置空等于告诉正在看盘的商户"你刚才看到的数字不算数了" ——
      // 而他把页面切走再切回来就能看到那些数字还在。
      // 错误由页顶 ErrorBanner 单独表达，内容区继续显示上一份数据。
      // 服务端给的业务话术直接显示（它们已经过中性文案审查），
      // 只在不是业务错误时才兜底成一句通用的话。
      // ⚠️ 兜底话也必须说清「哪件事 + 下一步」：写「加载失败」等于把问题退回给用户。
      error.value = e instanceof ApiFailure ? e.message : '页面数据没能加载出来，可能是网络不稳定。可以重新加载。';
    } finally {
      loading.value = false;
    }
  }

  if (opts.immediate !== false) void run();
  return { data, loading, error, run };
}

/** 把未知异常统一成一句话（用于写操作）—— 必须说清"数据有没有被改动" */
export function messageOf(e: unknown): string {
  return e instanceof ApiFailure ? e.message : '这一步没有完成，本次改动没有保存。可以再试一次。';
}
