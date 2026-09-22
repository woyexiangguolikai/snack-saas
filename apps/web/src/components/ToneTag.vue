<script setup lang="ts">
/**
 * 状态标签。**颜色只由服务端给的 tone 决定**（AC-11），前端不自己映射状态→颜色。
 *
 * 理由和手机端那份一样：状态机在服务端，前端若也写一份 `status === 'x' ? 绿 : 红`，
 * 状态机新增一条边时前端不会报错，只会"颜色不对" —— 而颜色不对在系统里等于没提示。
 */
import type { Tone } from '@/api/types';

const props = defineProps<{ tone: Tone; text: string }>();

const BG: Record<Tone, string> = {
  ok: 'var(--ok-bg)',
  warn: 'var(--warn-bg)',
  danger: 'var(--danger-bg)',
  off: 'var(--off-bg)',
  info: 'var(--info-bg)',
};
const FG: Record<Tone, string> = {
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  danger: 'var(--danger)',
  off: 'var(--off)',
  info: 'var(--info)',
};
</script>

<template>
  <span class="tag" :style="{ background: BG[props.tone], color: FG[props.tone] }">{{ props.text }}</span>
</template>

<style scoped>
.tag {
  display: inline-block;
  padding: 2px var(--sp-2);
  border-radius: var(--r-sm);
  font-size: var(--fs-tag);
  line-height: var(--lh-tag);
  font-weight: var(--fw-medium);
  white-space: nowrap;
}
</style>
