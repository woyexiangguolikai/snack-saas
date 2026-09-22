<script setup lang="ts">
/**
 * A-07 分类锚点 Anchor（原子）
 * 长列表的章节定位，字号 13、下划线 2.5px。
 * 双向联动是硬要求：点击锚点 → 列表滚到分类；手动滚列表 → 锚点自动高亮并横向滚到可视区。
 * 组件负责「渲染 + 高亮 + 点击回调」，滚动监听与 scroll-into-view 由页面持有（页面才知道列表）。
 */
withDefaults(
  defineProps<{
    items: Array<{ key: string; label: string }>;
    activeKey: string;
  }>(),
  {},
);

const emit = defineEmits<{ (e: 'change', key: string): void }>();
</script>

<template>
  <scroll-view scroll-x class="sn-anchor" :show-scrollbar="false">
    <view class="sn-anchor__inner">
      <view
        v-for="it in items"
        :key="it.key"
        class="sn-anchor__item"
        :class="{ 'is-on': it.key === activeKey }"
        :aria-selected="it.key === activeKey ? 'true' : 'false'"
        role="tab"
        @click="emit('change', it.key)"
      >
        <text class="sn-anchor__label">{{ it.label }}</text>
        <view class="sn-anchor__bar" />
      </view>
    </view>
  </scroll-view>
</template>

<style>
.sn-anchor {
  width: 100%;
  white-space: nowrap;
}
.sn-anchor__inner {
  display: inline-flex;
  align-items: flex-end;
  padding: 0 var(--page-x);
}
.sn-anchor__item {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-right: var(--sp-5);
}
.sn-anchor__label {
  font-size: 13px;
  color: var(--ink-500);
  padding-bottom: 6px;
}
.sn-anchor__item.is-on .sn-anchor__label {
  color: var(--ink-900);
  font-weight: var(--fw-semibold);
}
.sn-anchor__bar {
  width: 100%;
  height: 2.5px;
  border-radius: 2px;
  background: transparent;
}
.sn-anchor__item.is-on .sn-anchor__bar {
  background: var(--brand-500);
}
</style>
