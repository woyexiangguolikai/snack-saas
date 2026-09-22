<script setup lang="ts">
import { computed, ref } from 'vue';

/**
 * A-03 输入框（原子）
 * 六态：默认 / 聚焦 / 已填 / 错误 / 禁用 / 成功。
 * 两条由组件结构性保证的规则：
 *   · 错误提示写在框下方，不用 Toast（Toast 会消失，用户回头不知道哪里错了）
 *   · 错误说明必须可行动 —— 由调用方提供文案，Playground 里给了正反例
 */

const props = withDefaults(
  defineProps<{
    modelValue: string;
    label?: string;
    required?: boolean;
    /** 必须是示例值（如「302 室」），不是字段名 */
    placeholder?: string;
    type?: 'text' | 'number' | 'digit' | 'textarea';
    clearable?: boolean;
    /** 非空即进入错误态，值为错误说明 */
    error?: string;
    /** 成功说明（仅用于「校验通过且有额外信息要告知」） */
    success?: string;
    /** 常态说明，错误态时被 error 覆盖 */
    helper?: string;
    /** 右上角说明，如「可留空」 */
    hint?: string;
    maxlength?: number;
    disabled?: boolean;
    disabledReason?: string;
    /** 键盘右下角按键的文案 —— 搜索框要显示「搜索」，不要用默认的「完成」 */
    confirmType?: 'done' | 'search' | 'send' | 'next' | 'go';
    /** 进页面自动聚焦并唤起键盘（搜索页用）。默认关闭：
     *  普通表单里自动弹键盘会把页面顶上去，学生还没看清标题就被键盘挡了一半 */
    autoFocus?: boolean;
  }>(),
  {
    label: '',
    required: false,
    placeholder: '',
    type: 'text',
    clearable: false,
    error: '',
    success: '',
    helper: '',
    hint: '',
    maxlength: 0,
    disabled: false,
    disabledReason: '',
    confirmType: 'done',
    autoFocus: false,
  },
);

const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void;
  (e: 'focus'): void;
  (e: 'blur'): void;
  /**
   * 键盘「完成 / 搜索」键。
   * 为什么必须有：搜索框上，学生打完字最自然的动作是**按键盘上的搜索键**，
   * 而不是把手指挪到页面里某个按钮上。没有这个事件时那个键是死的 ——
   * 表现为"按了没反应"，而这类问题在自查时几乎不会被发现（我们习惯点按钮）。
   */
  (e: 'confirm', v: string): void;
}>();

const focused = ref(false);

const state = computed(() => {
  if (props.disabled) return 'disabled';
  if (props.error) return 'error';
  if (props.success) return 'success';
  if (focused.value) return 'focus';
  if (props.modelValue) return 'filled';
  return 'default';
});

/** 清除按钮只在有内容且聚焦时出现，失焦后隐藏 */
const showClear = computed(() => props.clearable && !!props.modelValue && focused.value && !props.disabled);

const message = computed(() => props.error || props.success || props.helper || '');
const messageTone = computed(() => (props.error ? 'error' : props.success ? 'success' : 'helper'));
const length = computed(() => props.modelValue.length);

function onInput(e: { detail: { value: string } }) {
  emit('update:modelValue', e.detail.value);
}
function onFocus() {
  focused.value = true;
  emit('focus');
}
function onBlur() {
  focused.value = false;
  emit('blur');
}
function onClear() {
  emit('update:modelValue', '');
}
function onConfirm(e: { detail: { value: string } }) {
  emit('confirm', e.detail.value);
}
</script>

<template>
  <view class="sn-input" :class="{ 'is-disabled': disabled }">
    <view v-if="label || hint" class="sn-input__head">
      <text class="sn-input__label">
        {{ label }}<text v-if="required" class="sn-input__star"> *</text>
      </text>
      <text v-if="hint" class="sn-input__hint">{{ hint }}</text>
    </view>

    <view class="sn-input__box" :class="`is-${state}`">
      <text v-if="$slots.prefix" class="sn-input__affix"><slot name="prefix" /></text>

      <textarea
        v-if="type === 'textarea'"
        class="sn-input__ctl sn-input__ctl--area"
        :value="modelValue"
        :placeholder="placeholder"
        :disabled="disabled"
        :maxlength="maxlength > 0 ? maxlength : -1"
        :cursor-spacing="20"
        placeholder-class="sn-input__ph"
        @input="onInput"
        @focus="onFocus"
        @blur="onBlur"
      />
      <input
        v-else
        class="sn-input__ctl"
        :value="modelValue"
        :type="type === 'text' ? 'text' : type"
        :placeholder="placeholder"
        :disabled="disabled"
        :maxlength="maxlength > 0 ? maxlength : 140"
        :cursor-spacing="20"
        :confirm-type="confirmType"
        :focus="autoFocus"
        placeholder-class="sn-input__ph"
        @input="onInput"
        @focus="onFocus"
        @blur="onBlur"
        @confirm="onConfirm"
      />

      <view v-if="showClear" class="sn-input__clear" @click="onClear">
        <text>×</text>
      </view>
      <text v-if="$slots.suffix" class="sn-input__affix"><slot name="suffix" /></text>
    </view>

    <view class="sn-input__foot">
      <text v-if="message" class="sn-input__msg" :class="`is-${messageTone}`">{{ message }}</text>
      <text v-if="maxlength > 0" class="sn-input__count num">{{ length }} / {{ maxlength }}</text>
    </view>

    <text v-if="disabled && disabledReason" class="sn-input__reason">{{ disabledReason }}</text>
  </view>
</template>

<style>
.sn-input {
  display: flex;
  flex-direction: column;
}

.sn-input__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: var(--sp-1);
}
.sn-input__label {
  font-size: var(--fs-sub);
  font-weight: var(--fw-medium);
  color: var(--ink-700);
}
.sn-input__star {
  color: var(--danger);
}
.sn-input__hint {
  font-size: var(--fs-tag);
  color: var(--ink-400);
}

.sn-input__box {
  display: flex;
  align-items: center;
  min-height: 46px;
  padding: 0 var(--sp-3);
  background: var(--surface);
  border: var(--bw) solid var(--line-200);
  border-radius: var(--r-md);
  transition: border-color var(--d-color) var(--e-std), box-shadow var(--d-color) var(--e-std);
}
.sn-input__box.is-focus {
  border-color: var(--brand-500);
  box-shadow: 0 0 0 3px var(--brand-ring);
}
.sn-input__box.is-error {
  border-color: var(--danger);
  box-shadow: 0 0 0 3px var(--danger-ring);
}
.sn-input__box.is-disabled {
  background: var(--line-100);
}
.sn-input__box.is-success {
  border-color: var(--line-200);
}

.sn-input__ctl {
  flex: 1;
  min-height: 44px;
  font-size: var(--fs-body);
  color: var(--ink-900);
  background: transparent;
}
.sn-input__ctl--area {
  min-height: 84px;
  padding: var(--sp-3) 0;
  line-height: var(--lh-body);
}
.sn-input__ph {
  color: var(--ink-400);
}
.sn-input__box.is-disabled .sn-input__ctl {
  color: var(--ink-400);
}

.sn-input__affix {
  font-size: var(--fs-body);
  color: var(--ink-500);
  margin: 0 var(--sp-1);
}

.sn-input__clear {
  width: 16px;
  height: 16px;
  border-radius: var(--r-full);
  background: var(--ink-300);
  color: var(--surface);
  font-size: 12px;
  line-height: 16px;
  text-align: center;
  margin-left: var(--sp-1);
}

.sn-input__foot {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-top: var(--sp-1);
}
.sn-input__msg {
  flex: 1;
  font-size: var(--fs-tag);
  line-height: var(--lh-tag);
}
.sn-input__msg.is-error {
  color: var(--danger);
}
.sn-input__msg.is-success {
  color: var(--ok);
}
.sn-input__msg.is-helper {
  color: var(--ink-500);
}
.sn-input__count {
  font-size: var(--fs-tag);
  color: var(--ink-400);
  margin-left: var(--sp-2);
}

.sn-input__reason {
  margin-top: var(--sp-1);
  font-size: var(--fs-tag);
  color: var(--ink-500);
}
</style>
