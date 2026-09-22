<script setup lang="ts">
/**
 * A-14 吸底栏 StickyBar（原子 · 移动端框架零件）
 * 两种形态，用途不同、不可混用：
 *   rounded=false（通栏）  操作栏 —— 结算页底部、商户端批量操作
 *   rounded=true （胶囊）  学生端购物车条 —— 必须「浮」在商品列表之上，
 *                          所以不通栏、离底留 16px，不遮挡最后一行价格
 * 硬约束：距屏幕底 ≥16px，只向上投影（--sup）；与 TabBar 互斥 ——
 * 二者同屏会导致底部出现两层操作区，用户不知道该点哪个。
 */
withDefaults(defineProps<{ rounded?: boolean }>(), { rounded: false });
</script>

<template>
  <view class="sn-sticky" :class="{ 'is-rounded': rounded }">
    <slot />
  </view>
</template>

<style>
.sn-sticky {
  display: flex;
  align-items: center;
  padding: var(--sp-3) var(--page-x);
  padding-bottom: calc(var(--sp-3) + env(safe-area-inset-bottom));
  background: var(--surface);
  box-shadow: var(--sup);
  flex: none;
}

/* 胶囊形：必须脱离文档流「浮」在列表之上（占位会把最后一行价格顶上去），
   离底 16px、左右各 16px、圆角全圆、向上投影。 */
.sn-sticky.is-rounded {
  position: fixed;
  right: var(--page-x);
  bottom: calc(var(--sp-4) + env(safe-area-inset-bottom));
  left: var(--page-x);
  z-index: var(--z-absorb);
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-full);
  box-shadow: var(--s2);
}
</style>
