<script setup lang="ts">
import { computed } from 'vue';

/**
 * A-06 复选 / 单选（原子）
 * 19×19，复选圆角 5px / 单选圆形；热区扩至 44×44。
 * 结构性规则：禁用项保留在列表中并说明原因（「3 号宿舍楼今日停送」），
 * 而不是直接消失 —— 消失会让商户以为功能坏了。
 */
const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    /** radio：单选（圆形）；checkbox：复选（圆角方） */
    shape?: 'checkbox' | 'radio';
    /** 半选态：仅用于「表头全选」场景，单选无半选 */
    indeterminate?: boolean;
    disabled?: boolean;
    disabledReason?: string;
    label?: string;
    /** 值区（右侧），用于「已选 3 / 18 项」这类补充说明 */
    trailing?: string;
  }>(),
  {
    shape: 'checkbox',
    indeterminate: false,
    disabled: false,
    disabledReason: '',
    label: '',
    trailing: '',
  },
);

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'change', v: boolean): void;
}>();

const checked = computed(() => props.modelValue);

function toggle() {
  if (props.disabled) return;
  emit('update:modelValue', !props.modelValue);
  emit('change', !props.modelValue);
}
</script>

<template>
  <view class="sn-check" :class="{ 'is-disabled': disabled }">
    <view class="sn-check__row" @click="toggle">
      <view
        class="sn-check__box"
        :class="[`sn-check__box--${shape}`, { 'is-on': checked, 'is-half': indeterminate && !checked }]"
        :aria-label="label || '选择'"
        :aria-checked="checked ? 'true' : 'false'"
        role="checkbox"
      >
        <text v-if="checked && shape === 'checkbox'" class="sn-check__tick">✓</text>
        <view v-if="indeterminate && !checked" class="sn-check__dash" />
        <view v-if="checked && shape === 'radio'" class="sn-check__dot" />
      </view>
      <text v-if="label" class="sn-check__label">{{ label }}</text>
      <text v-if="trailing" class="sn-check__trailing num">{{ trailing }}</text>
    </view>
    <text v-if="disabled && disabledReason" class="sn-check__reason">{{ disabledReason }}</text>
  </view>
</template>

<style>
.sn-check {
  display: flex;
  flex-direction: column;
}
.sn-check__row {
  display: flex;
  align-items: center;
  min-height: 44px; /* 热区 ≥44 */
}
.sn-check__box {
  flex: none;
  width: 19px;
  height: 19px;
  border: 1.4px solid var(--ink-300);
  background: var(--surface);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color 80ms var(--e-out), border-color 80ms var(--e-out);
}
.sn-check__box--checkbox {
  border-radius: 5px;
}
.sn-check__box--radio {
  border-radius: var(--r-full);
}
.sn-check__box.is-on {
  background: var(--brand-500);
  border-color: var(--brand-500);
}
.sn-check__box.is-half {
  background: var(--brand-500);
  border-color: var(--brand-500);
}
.sn-check__tick {
  color: var(--on-brand);
  font-size: 12px;
  line-height: 12px;
}
.sn-check__dash {
  width: 9px;
  height: 2px;
  background: var(--on-brand);
}
.sn-check__dot {
  width: 8px;
  height: 8px;
  border-radius: var(--r-full);
  background: var(--on-brand);
}

.sn-check__label {
  margin-left: var(--sp-2);
  flex: 1;
  font-size: var(--fs-body);
  color: var(--ink-900);
}
.sn-check__trailing {
  font-size: var(--fs-sub);
  color: var(--ink-500);
}

.sn-check.is-disabled .sn-check__box {
  background: var(--line-100);
  border-color: var(--line-200);
}
.sn-check.is-disabled .sn-check__box.is-on {
  background: var(--ink-300);
  border-color: var(--ink-300);
}
.sn-check.is-disabled .sn-check__label,
.sn-check.is-disabled .sn-check__trailing {
  color: var(--ink-400);
}
.sn-check__reason {
  margin-left: 27px;
  font-size: var(--fs-tag);
  color: var(--ink-500);
}
</style>
