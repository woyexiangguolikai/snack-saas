<script setup lang="ts">
/**
 * 金额显示。分 → 元，**全部过这一个组件**。
 *
 * 为什么要有它：金额散落在十几个页面里，若各自写 `(cents / 100).toFixed(2)`，
 * 迟早有一处忘了除以 100 或忘了补零 —— 而这种错误在界面上看起来"只是数字有点怪"。
 * 顺带把 AC-07（数字等宽）一次性做完：`.num` 类在这里加，不在每个页面各加一次。
 */
const props = defineProps<{ cents: number; muted?: boolean }>();

function yuan(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}${(Math.abs(cents) / 100).toFixed(2)}`;
}
</script>

<template>
  <span class="num money" :class="{ 'money--muted': props.muted }">¥{{ yuan(props.cents) }}</span>
</template>

<style scoped>
.money {
  font-size: inherit;
  font-weight: var(--fw-medium);
  color: var(--ink-900);
}
.money--muted {
  color: var(--ink-500);
  font-weight: var(--fw-normal);
}
</style>
