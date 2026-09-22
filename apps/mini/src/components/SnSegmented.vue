<script setup lang="ts">
/**
 * A-07 分段控件 Segmented（原子）
 * 固定 2–4 项，不滚动；容器 line-100 圆角 10，内边距 3；选中项白底 + --s1。
 * 与 Chip 的分工：Chip 是横滑筛选（可滚动、可多选），Segmented 是固定分段切换。
 */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    options: Array<{ value: string; label: string; count?: number }>;
  }>(),
  {},
);

const emit = defineEmits<{ (e: 'update:modelValue', v: string): void; (e: 'change', v: string): void }>();

function pick(v: string) {
  if (v === props.modelValue) return;
  emit('update:modelValue', v);
  emit('change', v);
}
</script>

<template>
  <view class="sn-seg">
    <view
      v-for="opt in options"
      :key="opt.value"
      class="sn-seg__item"
      :class="{ 'is-on': opt.value === modelValue }"
      :aria-label="opt.label"
      :aria-selected="opt.value === modelValue ? 'true' : 'false'"
      role="tab"
      @click="pick(opt.value)"
    >
      <text class="sn-seg__label">{{ opt.label }}</text>
      <text v-if="typeof opt.count === 'number'" class="sn-seg__count num">{{ opt.count }}</text>
    </view>
  </view>
</template>

<style>
.sn-seg {
  display: flex;
  align-self: flex-start;
  padding: 3px;
  background: var(--line-100);
  border-radius: var(--r-md);
}
.sn-seg__item {
  display: flex;
  align-items: baseline;
  padding: 6px 15px;
  border-radius: 7px;
  transition: background-color var(--d-color) var(--e-std);
}
.sn-seg__item.is-on {
  background: var(--surface);
  box-shadow: var(--s1);
}
.sn-seg__label {
  font-size: var(--fs-sub);
  color: var(--ink-500);
}
.sn-seg__item.is-on .sn-seg__label {
  color: var(--ink-900);
  font-weight: var(--fw-semibold);
}
.sn-seg__count {
  margin-left: 4px;
  font-size: var(--fs-tag);
  color: var(--ink-400);
}
.sn-seg__item.is-on .sn-seg__count {
  color: var(--brand-700);
}
</style>
