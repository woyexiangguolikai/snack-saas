<script setup lang="ts">
import { computed } from 'vue';

/**
 * A-05 开关（原子）
 * 表示「持续状态」的开启与关闭，不表示「执行一个动作」。
 * 关键决策（写进代码而不是靠记忆）：
 *   表示状态语义（营业中/启用楼栋）→ 开启色用 --ok（语义绿）；
 *   仅「非状态语义」的选项型开关（如设为推荐）才用 brand，换肤时应随之变色。
 * 关闭色固定 ink-300 —— 关闭是正常状态，不是错误。
 */
const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    /** ok：状态语义（默认，零换肤）；brand：选项语义（随主题色） */
    tone?: 'ok' | 'brand';
    disabled?: boolean;
    disabledReason?: string;
    /** 左侧文案 */
    label?: string;
    /** 文案下方的解释（说明影响范围） */
    description?: string;
  }>(),
  { tone: 'ok', disabled: false, disabledReason: '', label: '', description: '' },
);

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'change', v: boolean): void;
}>();

const onColor = computed(() => (props.tone === 'brand' ? 'var(--brand-500)' : 'var(--ok)'));

function toggle() {
  if (props.disabled) return;
  const next = !props.modelValue;
  emit('update:modelValue', next);
  emit('change', next);
}
</script>

<template>
  <view class="sn-switch" :class="{ 'is-disabled': disabled }">
    <view class="sn-switch__main" @click="toggle">
      <view class="sn-switch__texts">
        <text v-if="label" class="sn-switch__label">{{ label }}</text>
        <text v-if="description" class="sn-switch__desc">{{ description }}</text>
      </view>
      <view
        class="sn-switch__track"
        :class="{ 'is-on': modelValue }"
        :style="modelValue ? `background:${onColor}` : ''"
        :aria-label="label || '开关'"
        :aria-checked="modelValue ? 'true' : 'false'"
        role="switch"
      >
        <view class="sn-switch__knob" />
      </view>
    </view>
    <text v-if="disabled && disabledReason" class="sn-switch__reason">{{ disabledReason }}</text>
  </view>
</template>

<style>
.sn-switch {
  display: flex;
  flex-direction: column;
}
.sn-switch__main {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.sn-switch__texts {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding-right: var(--sp-3);
}
.sn-switch__label {
  font-size: var(--fs-body);
  color: var(--ink-900);
}
.sn-switch__desc {
  margin-top: 2px;
  font-size: var(--fs-tag);
  line-height: var(--lh-tag);
  color: var(--ink-500);
}

/* 46×27，滑块 21，内边距 3 → 位移 19px */
.sn-switch__track {
  flex: none;
  width: 46px;
  height: 27px;
  padding: 3px;
  border-radius: var(--r-full);
  background: var(--ink-300);
  transition: background-color 200ms var(--e-std);
}
.sn-switch__knob {
  width: 21px;
  height: 21px;
  border-radius: var(--r-full);
  background: var(--surface);
  transition: margin-left 200ms var(--e-std);
}
.sn-switch__track.is-on .sn-switch__knob {
  margin-left: 19px;
}

.sn-switch.is-disabled {
  opacity: 0.4;
}
.sn-switch__reason {
  margin-top: var(--sp-1);
  font-size: var(--fs-tag);
  color: var(--ink-500);
}
</style>
