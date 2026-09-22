<script setup lang="ts">
/**
 * A-11 批量操作条 BulkBar（原子 · 网页端专用）
 * 勾选后从底部升起 220ms，用深色 var(--dark-surface) 而不是白色 ——
 * 它必须明显「浮」在表格之上，且不能被误认为表格的一部分。
 */
withDefaults(defineProps<{ count: number }>(), { count: 0 });

const emit = defineEmits<{ (e: 'clear'): void }>();
</script>

<template>
  <view v-if="count > 0" class="sn-bulk">
    <text class="sn-bulk__count">已选 {{ count }} 项</text>
    <view class="sn-bulk__sep"><text>|</text></view>
    <view class="sn-bulk__actions">
      <slot />
    </view>
    <text class="sn-bulk__clear" @click="emit('clear')">取消选择</text>
  </view>
</template>

<style>
.sn-bulk {
  display: flex;
  align-items: center;
  padding: var(--sp-3) var(--sp-4);
  background: var(--dark-surface);
  border-radius: var(--r-md);
  animation: sn-fade-in var(--d-fade) var(--e-out);
}
.sn-bulk__count {
  font-size: var(--fs-sub);
  font-weight: var(--fw-semibold);
  color: var(--on-brand);
}
.sn-bulk__sep {
  margin: 0 var(--sp-3);
  color: var(--off);
  font-size: var(--fs-sub);
}
.sn-bulk__actions {
  flex: 1;
  display: flex;
  align-items: center;
}
.sn-bulk__clear {
  font-size: var(--fs-sub);
  color: var(--ink-300);
}
</style>
