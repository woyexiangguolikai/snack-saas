<script setup lang="ts">
import { computed } from 'vue';

/**
 * A-11 分页 Pagination（原子 · 网页端专用）
 * 必须显示总数 —— 只写「上一页/下一页」会让运营无法判断数据规模。
 */
const props = withDefaults(
  defineProps<{
    total: number;
    page: number;
    pageSize?: number;
    /** 中间最多显示几个页码按钮 */
    window?: number;
  }>(),
  { pageSize: 20, window: 5 },
);

const emit = defineEmits<{ (e: 'update:page', v: number): void; (e: 'change', v: number): void }>();

const totalPages = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)));

/** 页码窗口：1 2 3 … 13 */
const pages = computed<Array<number | '…'>>(() => {
  const tp = totalPages.value;
  const cur = props.page;
  const w = props.window;
  if (tp <= w + 2) return Array.from({ length: tp }, (_, i) => i + 1);
  const out: Array<number | '…'> = [1];
  const start = Math.max(2, cur - 1);
  const end = Math.min(tp - 1, cur + 1);
  if (start > 2) out.push('…');
  for (let i = start; i <= end; i += 1) out.push(i);
  if (end < tp - 1) out.push('…');
  out.push(tp);
  return out;
});

function go(p: number) {
  if (p < 1 || p > totalPages.value || p === props.page) return;
  emit('update:page', p);
  emit('change', p);
}
</script>

<template>
  <view class="sn-pager">
    <text class="sn-pager__total">共 {{ total }} 条 · 每页 {{ pageSize }} 条</text>
    <view class="sn-pager__pages">
      <view class="sn-pager__btn" :class="{ 'is-off': page <= 1 }" aria-label="上一页" @click="go(page - 1)">
        <text>‹</text>
      </view>
      <view
        v-for="(p, i) in pages"
        :key="i"
        class="sn-pager__btn"
        :class="{ 'is-on': p === page, 'is-gap': p === '…' }"
        @click="p === '…' ? null : go(p as number)"
      >
        <text>{{ p }}</text>
      </view>
      <view class="sn-pager__btn" :class="{ 'is-off': page >= totalPages }" aria-label="下一页" @click="go(page + 1)">
        <text>›</text>
      </view>
    </view>
  </view>
</template>

<style>
.sn-pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-3) 0;
}
.sn-pager__total {
  font-size: var(--fs-sub);
  color: var(--ink-500);
}
.sn-pager__pages {
  display: flex;
  align-items: center;
}
.sn-pager__btn {
  min-width: 28px;
  height: 28px;
  margin-left: var(--sp-1);
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-sub);
  color: var(--ink-700);
  background: var(--surface);
  border: var(--bw) solid var(--line-200);
}
.sn-pager__btn.is-on {
  background: var(--brand-500);
  border-color: var(--brand-500);
  color: var(--on-brand);
  font-weight: var(--fw-semibold);
}
.sn-pager__btn.is-off {
  color: var(--ink-300);
}
.sn-pager__btn.is-gap {
  border-color: transparent;
  background: transparent;
}
</style>
