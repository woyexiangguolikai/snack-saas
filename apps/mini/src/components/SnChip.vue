<script setup lang="ts">
/**
 * A-07 Chip 筛选片（原子）
 * 高 32、圆角 999、padding 0 13、字号 12.5；选中 brand-500 底 + 白字 + 600。
 * 结构性规则：禁用态必须保留在列表里并带原因（「乳制品（本栋未上架）」），
 * 直接隐藏会让学生反复找。reason 会渲染成「名称（原因）」。
 */
const props = withDefaults(
  defineProps<{
    label: string;
    selected?: boolean;
    disabled?: boolean;
    /** 禁用原因：会渲染成「名称（原因）」 */
    reason?: string;
  }>(),
  { selected: false, disabled: false, reason: '' },
);

const emit = defineEmits<{ (e: 'click'): void }>();

function onClick() {
  if (props.disabled) return;
  emit('click');
}
</script>

<template>
  <view
    class="sn-chip"
    :class="{ 'is-on': selected && !disabled, 'is-disabled': disabled }"
    :aria-label="label"
    :aria-selected="selected ? 'true' : 'false'"
    role="button"
    @click="onClick"
  >
    <text class="sn-chip__text">{{ label }}<text v-if="disabled && reason">（{{ reason }}）</text></text>
  </view>
</template>

<style>
.sn-chip {
  flex: none;
  height: 32px;
  padding: 0 13px;
  border-radius: var(--r-full);
  background: var(--surface);
  border: var(--bw) solid var(--line-200);
  display: flex;
  align-items: center;
  transition: background-color var(--d-color) var(--e-std), border-color var(--d-color) var(--e-std);
}
.sn-chip__text {
  font-size: var(--fs-sub);
  color: var(--ink-700);
}
.sn-chip.is-on {
  background: var(--brand-500);
  border-color: var(--brand-500);
}
.sn-chip.is-on .sn-chip__text {
  color: var(--on-brand);
  font-weight: var(--fw-semibold);
}
.sn-chip.is-disabled {
  background: var(--line-100);
  border-color: var(--line-100);
}
.sn-chip.is-disabled .sn-chip__text {
  color: var(--ink-400);
}
</style>
