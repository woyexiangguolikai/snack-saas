<script setup lang="ts">
/**
 * 商户端底部导航（M-01 / M-03 / M-05 三个一级页）。
 *
 * 为什么不用小程序原生 TabBar：
 *   原生 TabBar **一个包只有一套**，已经被学生端（点单 / 订单 / 我的）占用了。
 *   而商户与学生是同一个 AppID、同一个包里的两套界面 ——
 *   给商户再配一套原生 TabBar 只能靠 `uni.setTabBarItem` 在运行时改文案与跳转，
 *   那会让"当前是哪个角色"变成全局可变状态，一次跳转漏改就串台。
 *
 *   改成自定义底部导航后，角色是**页面级的**：进到哪个页面就渲染哪个导航，
 *   不存在"上一个页面改了全局 TabBar 没改回来"这种事。
 *
 * 顺序按需求（AC-03）：**配送清单是第一个** —— 商户打开小程序是要去送货的，
 * 不是来看数据的。把"我的"放第一个等于让他每天多点一次。
 */
const props = defineProps<{
  current: 'delivery' | 'stock' | 'mine';
}>();

const TABS = [
  { key: 'delivery', label: '配送', path: '/pages-merchant/delivery/index' },
  { key: 'stock', label: '库存', path: '/pages-merchant/stock/quick' },
  { key: 'mine', label: '我的', path: '/pages-merchant/mine/index' },
] as const;

function go(key: (typeof TABS)[number]['key']): void {
  if (key === props.current) return;
  // redirectTo 而不是 navigateTo：商户在这三个页之间来回点是很频繁的，
  // 用 navigateTo 会把页面栈堆到十几层，安卓返回键要按十几次才退出去
  uni.redirectTo({ url: TABS.find((t) => t.key === key)!.path });
}
</script>

<template>
  <view class="smt">
    <view
      v-for="t in TABS"
      :key="t.key"
      class="smt__item"
      :class="{ 'is-on': t.key === current }"
      role="tab"
      :aria-selected="t.key === current ? 'true' : 'false'"
      @click="go(t.key)"
    >
      <text class="smt__label">{{ t.label }}</text>
    </view>
  </view>
</template>

<style>
.smt {
  flex: none;
  display: flex;
  padding-bottom: env(safe-area-inset-bottom);
  background: var(--surface);
  border-top: 1rpx solid var(--line-200);
}
.smt__item {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 96rpx;
}
.smt__label {
  font-size: var(--fs-sub);
  color: var(--ink-400);
}
.smt__item.is-on .smt__label {
  color: var(--brand-600);
  font-weight: var(--fw-semibold);
}
</style>
