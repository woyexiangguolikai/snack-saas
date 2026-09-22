<script setup lang="ts">
import { computed } from 'vue';
import { usePressable } from '../composables/usePressable';

/**
 * A-01 按钮（原子）
 * 全站唯一的主操作入口。设计约束由组件结构性保证，不靠调用方自觉：
 *   · 一屏只能有一个主按钮 —— 由代码评审 + Playground 比对，不做运行时限制
 *   · 禁用必须给出原因（disabledReason）—— 传了就一定会渲染在按钮下方
 *   · loading 期间内部拦截重复点击，不依赖调用方
 */

const props = withDefaults(
  defineProps<{
    type?: 'pri' | 'sec' | 'tex' | 'dan' | 'danf';
    size?: 'sm' | 'md' | 'lg';
    /** 占满容器宽度 */
    block?: boolean;
    disabled?: boolean;
    /** 禁用原因：禁用态必填，会渲染在按钮下方（否则用户不知道为什么点不了） */
    disabledReason?: string;
    loading?: boolean;
    /** 加载态文案，默认「处理中」 */
    loadingText?: string;
    /** 右上角计数，如「批量送达（5）」 */
    badge?: number;
    ariaLabel?: string;
  }>(),
  {
    type: 'pri',
    size: 'md',
    block: false,
    disabled: false,
    disabledReason: '',
    loading: false,
    loadingText: '',
    badge: 0,
    ariaLabel: '',
  },
);

const emit = defineEmits<{ (e: 'click'): void }>();

const isDisabled = computed(() => props.disabled || props.loading);
const { pressed, onTouchstart, onTouchend, onTouchcancel } = usePressable(() => isDisabled.value);

function onClick() {
  if (isDisabled.value) return;
  emit('click');
}

const label = computed(() =>
  props.loading ? props.loadingText || '处理中' : '',
);
const badgeText = computed(() => (props.badge > 99 ? '99+' : String(props.badge)));
</script>

<template>
  <view class="sn-btn-wrap" :class="{ 'is-block': block }">
    <view
      class="sn-btn"
      :class="[
        `sn-btn--${type}`,
        `sn-btn--${size}`,
        { 'is-block': block, 'is-press': pressed, 'is-disabled': isDisabled },
      ]"
      :aria-label="ariaLabel || undefined"
      :aria-disabled="isDisabled ? 'true' : undefined"
      @touchstart="onTouchstart"
      @touchend="onTouchend"
      @touchcancel="onTouchcancel"
      @click="onClick"
    >
      <view v-if="loading" class="sn-spin sn-btn__spin" />
      <view v-else-if="$slots.icon" class="sn-btn__icon"><slot name="icon" /></view>
      <view class="sn-btn__label">
        <text v-if="loading">{{ label }}</text>
        <slot v-else />
      </view>
      <view v-if="badge" class="sn-btn__badge num"><text>{{ badgeText }}</text></view>
    </view>
    <text v-if="isDisabled && disabledReason" class="sn-btn__reason">{{ disabledReason }}</text>
  </view>
</template>

<style>
.sn-btn-wrap {
  display: flex;
  flex-direction: column;
}
.sn-btn-wrap.is-block {
  width: 100%;
}

.sn-btn {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--r-md);
  font-size: var(--fs-card);
  font-weight: var(--fw-semibold);
  transition: transform var(--d-press) var(--e-out), background-color var(--d-color) var(--e-std),
    opacity var(--d-color) var(--e-std);
  /* 拇指舒适点击区最小 46px 由 md 档保证 */
}
.sn-btn.is-block {
  width: 100%;
}

/* ---- 尺寸：sm 34 / md 46 / lg 52 ---- */
.sn-btn--sm {
  height: 34px;
  padding: 0 13px;
  border-radius: 8px;
  font-size: var(--fs-sub);
}
.sn-btn--md {
  height: 46px;
  padding: 0 20px;
}
.sn-btn--lg {
  height: 52px;
  padding: 0 20px;
  border-radius: var(--r-lg);
  font-size: var(--fs-card);
}
.sn-btn--tex {
  height: auto;
  padding: 0 8px;
}

/* ---- 类型 ---- */
.sn-btn--pri {
  background: var(--brand-500);
  color: var(--on-brand);
}
.sn-btn--pri.is-press {
  background: var(--brand-400);
  transform: scale(0.985);
}

.sn-btn--sec {
  background: var(--surface);
  color: var(--brand-700);
  border: var(--bw) solid var(--brand-200);
}
.sn-btn--sec.is-press {
  background: var(--brand-50);
  transform: scale(0.985);
}

.sn-btn--tex {
  background: transparent;
  color: var(--brand-700);
}
.sn-btn--tex.is-press {
  opacity: 0.6;
}

.sn-btn--dan {
  background: var(--surface);
  color: var(--danger);
  border: var(--bw) solid var(--danger);
}
.sn-btn--dan.is-press {
  background: var(--danger-bg);
  transform: scale(0.985);
}

.sn-btn--danf {
  background: var(--danger);
  color: var(--on-brand);
}
.sn-btn--danf.is-press {
  transform: scale(0.985);
  opacity: 0.9;
}

/* ---- 禁用：opacity .42 + 不响应点击 ---- */
.sn-btn.is-disabled {
  opacity: 0.42;
}
.sn-btn--pri.is-disabled {
  background: var(--brand-300);
}

.sn-btn__label {
  display: flex;
  align-items: center;
}
.sn-btn__spin {
  margin-right: 6px;
  color: currentColor;
}
.sn-btn__icon {
  margin-right: 6px;
  display: flex;
  align-items: center;
}
.sn-btn__badge {
  position: absolute;
  top: -6px;
  right: -6px;
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  border-radius: var(--r-full);
  background: var(--danger);
  color: var(--on-brand);
  font-size: 10.5px;
  font-weight: var(--fw-semibold);
  line-height: 17px;
  text-align: center;
}

/* 禁用原因：紧贴按钮下方，11px danger —— 禁用必须可解释 */
.sn-btn__reason {
  margin-top: var(--sp-1);
  padding: 0 var(--sp-1);
  font-size: var(--fs-tag);
  color: var(--danger);
}
</style>
