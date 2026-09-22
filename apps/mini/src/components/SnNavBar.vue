<script setup lang="ts">
import { computed } from 'vue';
import { useNavMetrics } from '../composables/useNavMetrics';

/**
 * A-14 顶部导航 NavBar（原子 · 移动端框架零件）
 * 状态栏 + 导航栏两段。导航栏高度**与胶囊同高且垂直居中**（由 useNavMetrics 实测），
 * 而不是写死 44px —— 写死的话在状态栏高度不同的机型上，标题与胶囊会错行。
 *
 * 微信胶囊在右上角，右侧必须留空：这里用实测宽度物理占位，
 * 而不是写在注释里靠人记得。
 *
 * ⚠️ 状态栏内边距走**行内样式**，不走 class —— 见 useNavMetrics 顶部注释：
 *    小程序端 `env(safe-area-inset-top)` 恒为 0，且页面样式表会覆盖 app.wxss 的同优先级规则。
 */
const props = withDefaults(
  defineProps<{
    title: string;
    showBack?: boolean;
    /** 右侧是否留出胶囊安全区（小程序恒为 true；H5 桌面可关） */
    reserveCapsule?: boolean;
  }>(),
  { showBack: true, reserveCapsule: true },
);

const emit = defineEmits<{ (e: 'back'): void }>();

const nav = useNavMetrics();
const statusBarHeight = computed(() => nav.statusBarHeight);
const navBarHeight = computed(() => nav.navBarHeight);
const rightReserve = computed(() => (props.reserveCapsule ? nav.rightReserve : 0));

function onBack() {
  emit('back');
  // 默认行为：返回上一页；无上一页时回首页（由页面覆盖 onBack 时自行处理）
  const pages = getCurrentPages();
  if (pages.length > 1) uni.navigateBack();
}
</script>

<template>
  <view class="sn-nav" :style="`padding-top:${statusBarHeight}px`">
    <view class="sn-nav__bar" :style="`height:${navBarHeight}px`">
      <view v-if="showBack" class="sn-nav__left">
        <view class="sn-nav__back" aria-label="返回" @click="onBack">
          <text class="sn-nav__backicon">‹</text>
        </view>
      </view>
      <view v-else class="sn-nav__left" />

      <view class="sn-nav__title">
        <text class="sn-nav__titletext">{{ title }}</text>
      </view>

      <!-- 胶囊安全区：物理占位，宽度 = 实测「屏幕右沿 → 胶囊左沿」+ 呼吸位 -->
      <view v-if="reserveCapsule" class="sn-nav__capsule" :style="`width:${rightReserve}px`" />
      <view v-else class="sn-nav__right"><slot name="right" /></view>
    </view>
  </view>
</template>

<style>
.sn-nav {
  background: var(--paper);
  flex: none;
}
.sn-nav__bar {
  /* 高度由行内样式给（= 实测胶囊几何），这里只兜底一个不小于触摸目标的值 */
  min-height: 40px;
  display: flex;
  align-items: center;
  padding: 0 var(--sp-2);
}
.sn-nav__left {
  width: 44px;
  display: flex;
  align-items: center;
}
.sn-nav__back {
  width: 34px;
  height: 34px;
  border-radius: var(--r-full);
  display: flex;
  align-items: center;
  justify-content: center;
}
.sn-nav__back:active {
  background: var(--line-100);
}
.sn-nav__backicon {
  font-size: 24px;
  line-height: 24px;
  color: var(--ink-900);
}
.sn-nav__title {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
}
.sn-nav__titletext {
  font-size: var(--fs-section);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
/* 右侧不可点区：宽度由行内样式给（实测胶囊位置），与微信胶囊共存 */
.sn-nav__capsule {
  flex: none;
}
.sn-nav__right {
  width: 100px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: flex-end;
}
</style>
