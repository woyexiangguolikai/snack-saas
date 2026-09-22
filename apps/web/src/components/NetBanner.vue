<script setup lang="ts">
import { useNetStatus } from '@/composables/useNetStatus';

/**
 * 网络横幅（全局，内容区最上方，高 26px）—— 对应 A-17 的网页版本。
 *
 * 两条容易做错的地方：
 *   ① 高度固定 26px 且**不遮挡任何操作**：它是一条状态，不是遮罩；
 *   ② online 时不渲染 —— 一直挂着"网络正常"既误导又白占 26px。
 *
 * 颜色只取自语义色 Token，本组件不判断"断网该用什么颜色"。
 */
const net = useNetStatus();
</script>

<template>
  <div v-if="net.visible.value" class="netbanner" :class="`is-${net.tone.value}`" role="status">
    <span class="netbanner__dot" aria-hidden="true">•</span>
    <span class="netbanner__text">{{ net.text.value }}</span>
  </div>
</template>

<style scoped>
.netbanner {
  height: 26px;
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 0 var(--sp-3);
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
.netbanner__dot {
  font-size: var(--fs-tag);
  line-height: 1;
}
.netbanner__text {
  font-size: var(--fs-tag);
  line-height: var(--lh-tag);
}
</style>
