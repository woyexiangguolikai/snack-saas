<script setup lang="ts">
import { useThemeStore } from '../stores/theme';
import SnNavBar from './SnNavBar.vue';

/**
 * A-14 页面外壳 Page（原子 · 所有移动端页面的外壳）
 * 它承担两件容易被漏掉的事：
 *   ① 把租户主题色的 CSS 变量挂在页面根节点上（小程序没有动态换肤 API，
 *      只能靠内联 style 覆盖变量并向下继承；
 *   ② surface="platform" 时锁死中性色 —— 平台后台永不接受租户主题色（AC-12），
 *      这条规则写在组件里，页面想违反也违反不了。
 */
const props = withDefaults(
  defineProps<{
    /** 页面标题；不传则不渲染自定义导航（由页面自绘） */
    navTitle?: string;
    showBack?: boolean;
    /** 页面容器：student / merchant / admin / platform */
    surface?: 'student' | 'merchant' | 'admin' | 'platform';
    /** 平台后台强制中性色 */
  }>(),
  { navTitle: '', showBack: true, surface: 'student' },
);

const emit = defineEmits<{ (e: 'back'): void }>();

const theme = useThemeStore();
if (props.surface === 'platform') theme.lockNeutral();

function onBack() {
  emit('back');
  const pages = getCurrentPages();
  if (pages.length > 1) uni.navigateBack();
}
</script>

<template>
  <view class="sn-page-root" :class="`is-${surface}`" :style="theme.themeStyle">
    <SnNavBar v-if="navTitle" :title="navTitle" :show-back="showBack" @back="onBack" />

    <scroll-view scroll-y class="sn-scroll">
      <view class="sn-body">
        <slot />
      </view>
    </scroll-view>

    <!-- 吸底区：与 TabBar 互斥由页面决定是否传入 -->
    <view v-if="$slots.absorb" class="sn-page-root__absorb">
      <slot name="absorb" />
    </view>
  </view>
</template>

<style>
.sn-page-root {
  display: flex;
  flex-direction: column;
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  background: var(--paper);
}
.sn-page-root__absorb {
  flex: none;
}
</style>
