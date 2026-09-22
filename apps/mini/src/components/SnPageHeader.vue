<script setup lang="ts">
/**
 * A-10 页头 PageHeader（原子 · 网页端面包屑）
 * 商户网页与平台后台共用：库存管理 › 库存矩阵 › 1 号宿舍楼
 */
defineProps<{
  title: string;
  /** 面包屑，不含末级（末级必须是 title） */
  crumbs?: string[];
}>();
</script>

<template>
  <view class="sn-pagehead">
    <view v-if="crumbs && crumbs.length" class="sn-pagehead__crumbs">
      <text v-for="(c, i) in crumbs" :key="i" class="sn-pagehead__crumb">
        {{ c }}<text class="sn-pagehead__sep"> › </text>
      </text>
    </view>
    <text class="sn-pagehead__title">{{ title }}</text>
  </view>
</template>

<style>
.sn-pagehead {
  display: flex;
  flex-direction: column;
  padding: var(--sp-4) 0;
}
.sn-pagehead__crumbs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
}
.sn-pagehead__crumb {
  font-size: var(--fs-sub);
  color: var(--ink-500);
}
.sn-pagehead__sep {
  color: var(--ink-300);
}
.sn-pagehead__title {
  margin-top: var(--sp-1);
  font-size: var(--fs-title);
  font-weight: var(--fw-semibold);
  line-height: var(--lh-title);
}
</style>
