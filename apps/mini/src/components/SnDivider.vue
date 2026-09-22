<script setup lang="ts">
/**
 * 分隔线 / 进度条 / 骨架块（A-13 同组零件，此行文件只含分隔线，其余各自成文件）
 * 实线 line-200 用于区块之间；虚线用于金额汇总区，呼应「小票」母题。
 */
withDefaults(
  defineProps<{
    /** dashed：小票式虚线 */
    dashed?: boolean;
    /** 上方留白档位 */
    space?: 'none' | 'sm' | 'md';
  }>(),
  { dashed: false, space: 'md' },
);
</script>

<template>
  <view class="sn-divider" :class="[`sn-divider--${space}`, { 'is-dashed': dashed }]" />
</template>

<style>
.sn-divider {
  height: 0;
  border-top: var(--bw) solid var(--line-200);
}
.sn-divider.is-dashed {
  border-top-style: dashed;
}
.sn-divider--none {
  margin: 0;
}
.sn-divider--sm {
  margin: var(--sp-3) 0;
}
.sn-divider--md {
  margin: var(--sp-5) 0;
}
</style>
