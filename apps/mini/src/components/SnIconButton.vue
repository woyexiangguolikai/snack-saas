<script setup lang="ts">
import { computed } from 'vue';
import { usePressable } from '../composables/usePressable';

/**
 * A-02 图标按钮 / 工具条（原子）
 * 视觉 34×34 圆形容器，热区 ≥44×44（靠 wrapper padding 扩大，不放大视觉）。
 * label（aria-label）必填 —— 图标无文字，读屏用户完全依赖它。
 */
const props = withDefaults(
  defineProps<{
    /** 无障碍标签，必填 */
    label: string;
    disabled?: boolean;
    /** 禁用原因会渲染在按钮旁边（图标按钮的禁用同样必须可解释） */
    disabledReason?: string;
    badge?: number;
    /** nav：导航栏内使用，与微信胶囊视觉等高 */
    variant?: 'default' | 'nav';
  }>(),
  { disabled: false, disabledReason: '', badge: 0, variant: 'default' },
);

const emit = defineEmits<{ (e: 'click'): void }>();

const isDisabled = computed(() => props.disabled);
const { pressed, onTouchstart, onTouchend, onTouchcancel } = usePressable(() => isDisabled.value);

function onClick() {
  if (isDisabled.value) return;
  emit('click');
}

const badgeText = computed(() => (props.badge > 99 ? '99+' : String(props.badge)));
</script>

<template>
  <view class="sn-iconbtn__hot">
    <view
      class="sn-iconbtn"
      :class="[`sn-iconbtn--${variant}`, { 'is-press': pressed, 'is-disabled': isDisabled }]"
      :aria-label="label"
      :aria-disabled="isDisabled ? 'true' : undefined"
      @touchstart="onTouchstart"
      @touchend="onTouchend"
      @touchcancel="onTouchcancel"
      @click="onClick"
    >
      <slot />
      <view v-if="badge" class="sn-iconbtn__badge num"><text>{{ badgeText }}</text></view>
    </view>
    <text v-if="isDisabled && disabledReason" class="sn-iconbtn__reason">{{ disabledReason }}</text>
  </view>
</template>

<style>
/* 热区 ≥44×44：视觉可以小，热区不能小 */
.sn-iconbtn__hot {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.sn-iconbtn {
  position: relative;
  width: 34px;
  height: 34px;
  margin: 5px; /* 视觉 34 + 两侧 5 = 热区 44 */
  border-radius: var(--r-full);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ink-700);
  background: transparent;
  transition: background-color var(--d-color) var(--e-std);
}
.sn-iconbtn--nav {
  color: var(--ink-900);
}
/* 图标按钮不做缩放，避免在列表中造成行抖动 —— 只改底色 */
.sn-iconbtn.is-press {
  background: var(--line-200);
}
.sn-iconbtn:active {
  background: var(--line-100);
}
.sn-iconbtn.is-disabled {
  color: var(--ink-300);
}

.sn-iconbtn__badge {
  position: absolute;
  top: 0;
  right: 0;
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

.sn-iconbtn__reason {
  font-size: var(--fs-tag);
  color: var(--ink-500);
  max-width: 96px;
  text-align: center;
}
</style>
