<script setup lang="ts">
import { useNetStatus } from '../composables/useNetStatus';

/**
 * A-17 网络横幅（全局，导航栏正下方，高 26px）。
 *
 * 三态由 `useNetStatus` 决定，本组件只负责画 —— 颜色取自语义色 Token，
 * 不在这里判断"断网该用什么颜色"。
 *
 * 两个容易做错的地方：
 *   ① 高度固定在 26px 且**不遮挡任何操作**：它是一条状态，不是遮罩。
 *   ② online 时不渲染（`visible === false`）—— 一直挂着一条"网络正常"的条
 *      会让用户以为出了什么事，也白白占掉 26px。
 */
const net = useNetStatus();
</script>

<template>
  <view v-if="net.visible.value" class="netbanner" :class="`is-${net.tone.value}`">
    <text class="netbanner__dot">•</text>
    <text class="netbanner__text">{{ net.text.value }}</text>
  </view>
</template>

<style>
.netbanner {
  height: 26px;
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 0 var(--page-x);
  /* z-80：任何情况下可见，但不覆盖导航与操作 */
  z-index: var(--z-net);
}
.netbanner.is-off {
  background: var(--off-bg);
}
.netbanner.is-warn {
  background: var(--warn-bg);
}
.netbanner.is-ok {
  background: var(--ok-bg);
}
.netbanner__dot {
  font-size: var(--fs-tag);
  line-height: 1;
}
.netbanner.is-off .netbanner__dot,
.netbanner.is-off .netbanner__text {
  color: var(--off);
}
.netbanner.is-warn .netbanner__dot,
.netbanner.is-warn .netbanner__text {
  color: var(--warn);
}
.netbanner.is-ok .netbanner__dot,
.netbanner.is-ok .netbanner__text {
  color: var(--ok);
}
.netbanner__text {
  font-size: var(--fs-tag);
  line-height: var(--lh-tag);
}
</style>
