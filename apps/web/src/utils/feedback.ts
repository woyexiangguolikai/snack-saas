/**
 * 轻量提示条。
 *
 * 不用 `alert()`：它会阻塞整个页面，而后台的批量操作往往要连着点几下 ——
 * 一次 alert 就把操作节奏打断。也不引第三方 toast 库：这里只需要"一条会自己消失的横幅"。
 *
 * 颜色走 AC-05 的语义色：ok=已闭环、warn=即将需要处理、danger=需要你立刻动手、info=纯告知。
 */
import { reactive } from 'vue';
import type { Tone } from '@/api/types';

export interface Toast {
  id: number;
  tone: Tone;
  text: string;
}

export const toasts = reactive<Toast[]>([]);

let seq = 0;

export function toast(text: string, tone: Tone = 'info'): void {
  const id = ++seq;
  toasts.push({ id, tone, text });
  // 4 秒：够读完一句话，又不至于要用户手动关
  setTimeout(() => {
    const i = toasts.findIndex((t) => t.id === id);
    if (i >= 0) toasts.splice(i, 1);
  }, 4000);
}

export function dismiss(id: number): void {
  const i = toasts.findIndex((t) => t.id === id);
  if (i >= 0) toasts.splice(i, 1);
}
