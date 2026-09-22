<script setup lang="ts">
import { computed, watch } from 'vue';

/**
 * A-15 底部抽屉 Sheet（原子 · 移动端弹层容器）
 *
 * 为什么学生端的楼栋选择 / 商品详情 / 购物车都用抽屉而不是新页面：
 *   这三件事都是"在浏览过程中临时插入的一个决定"，用新页面会把浏览位置丢掉 ——
 *   学生看完商品详情返回，列表滚回顶部，得重新找刚才那件商品。
 *   抽屉能原地开合，上下文不丢。
 *
 * 三条实现要点：
 *  ① 遮罩用 `--mask`（Token），不是写死 rgba —— 否则 AC-04 失效
 *  ② 最大高度 88vh：留出上方一条"透出背景"，让人知道这是浮层而不是新页面
 *  ③ 只做进入动画，不做离场动画 —— 小程序 wxml 没有 <transition> 组件，
 *     用 display:none + 定时器"假装"离场会引入一个必须清理的定时器，
 *     而收益只是关闭时那 280ms。这里选择**关闭即卸载**：干脆、无状态残留。
 */
const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    title?: string;
    /** auto：跟内容高度；half：半屏；full：88vh */
    height?: 'auto' | 'half' | 'full';
    /** 点遮罩是否关闭 —— 购物车面板建议关掉（避免误触丢失已选内容） */
    closeOnMask?: boolean;
    /** 展示标题下方的说明 */
    subtitle?: string;
  }>(),
  { title: '', height: 'auto', closeOnMask: true, subtitle: '' },
);

const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void; (e: 'close'): void }>();

function close() {
  emit('update:modelValue', false);
  emit('close');
}

function onMask() {
  if (props.closeOnMask) close();
}

// 打开时锁住背景滚动：抽屉上的滑动手势很容易"透"到底层页面，
// 表现为手指在抽屉里滑动、底层列表跟着动，非常廉价
watch(
  () => props.modelValue,
  (open) => {
    try {
      if (open) uni.hideKeyboard();
    } catch {
      /* H5 无此 API */
    }
  },
);

const maxHeight = computed(() => (props.height === 'full' ? '88vh' : props.height === 'half' ? '56vh' : '80vh'));
</script>

<template>
  <view v-if="modelValue" class="sn-sheet">
    <view class="sn-sheet__mask" @click="onMask" />
    <view class="sn-sheet__panel" :style="`max-height:${maxHeight}`">
      <view class="sn-sheet__grip" />
      <view v-if="title" class="sn-sheet__head">
        <text class="sn-sheet__title">{{ title }}</text>
        <text v-if="subtitle" class="sn-sheet__sub">{{ subtitle }}</text>
      </view>
      <scroll-view scroll-y class="sn-sheet__body">
        <slot />
      </scroll-view>
      <view v-if="$slots.footer" class="sn-sheet__footer sn-safe-bottom">
        <slot name="footer" />
      </view>
    </view>
  </view>
</template>

<style>
.sn-sheet {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: var(--z-sheet);
}
.sn-sheet__mask {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  background: var(--mask);
  animation: sn-fade-in var(--d-fade) var(--e-out);
}
.sn-sheet__panel {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-radius: var(--r-xl) var(--r-xl) 0 0;
  box-shadow: var(--s2);
  animation: sn-sheet-up var(--d-sheet) var(--e-sheet);
}
.sn-sheet__grip {
  width: 36px;
  height: 4px;
  border-radius: var(--r-full);
  background: var(--line-200);
  margin: var(--sp-2) auto var(--sp-1);
  flex: none;
}
.sn-sheet__head {
  padding: var(--sp-2) var(--page-x) var(--sp-3);
  flex: none;
}
.sn-sheet__title {
  display: block;
  font-size: var(--fs-section);
  font-weight: var(--fw-semibold);
  line-height: var(--lh-section);
  color: var(--ink-900);
}
.sn-sheet__sub {
  display: block;
  margin-top: var(--sp-1);
  font-size: var(--fs-sub);
  color: var(--ink-500);
  line-height: var(--lh-sub);
}
.sn-sheet__body {
  flex: 1;
  min-height: 0;
}
.sn-sheet__footer {
  flex: none;
  padding: var(--sp-3) var(--page-x);
  border-top: var(--bd);
  background: var(--surface);
}
@keyframes sn-sheet-up {
  from {
    transform: translateY(100%);
  }
  to {
    transform: translateY(0);
  }
}
</style>
