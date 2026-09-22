<script setup lang="ts">
/**
 * 网页端页面骨架。
 *
 * 与小程序端 `SnPageSkeleton.vue` 是同一条纪律的浏览器版本：
 * **首屏数据未到时禁止"白屏 + 加载中…"**，必须给出与真实结构一致的骨架块，
 * 否则数据到达时布局会跳（AC-19）。
 *
 * 三个预设，覆盖后台全部列表页：
 *   stockMatrix  筛选栏 32 · 两张同步说明卡 · 表头 + 5 行（**列宽与真实矩阵一致**）
 *   tenantList   隐私护栏卡 · 筛选栏 32 · 表头 + 4 行
 *   table        筛选栏 32 · 表头 + N 行（其余后台列表页的通用形态）
 *
 * 为什么 stockMatrix 要单独一个预设：
 *   库存矩阵是唯一"列数随楼栋数变化"的表。列宽写错的话数据到达时整表横跳，
 *   而这张表正是商户每天要盯的那一张 —— 跳一次就要重新找列。
 */
withDefaults(
  defineProps<{
    preset: 'stockMatrix' | 'tenantList' | 'table';
    /** table 预设的行数（默认 5） */
    rows?: number;
    /** 楼栋列数（stockMatrix 专用）—— 由调用方按真实楼栋数给 */
    cols?: number;
  }>(),
  { rows: 5, cols: 3 },
);
</script>

<template>
  <!-- 库存矩阵：筛选栏 + 两张同步说明卡 + 表头 + 行 -->
  <div v-if="preset === 'stockMatrix'" class="sk">
    <div class="sk__bar">
      <span class="sk__block" style="width: 180px; height: 32px" />
      <span class="sk__block" style="width: 96px; height: 32px" />
    </div>
    <div class="sk__cards">
      <div class="sk__card">
        <span class="sk__block" style="width: 92px; height: 14px" />
        <span class="sk__block" style="width: 72%; height: 11px" />
        <span class="sk__block" style="width: 56px; height: 28px" />
      </div>
      <div class="sk__card">
        <span class="sk__block" style="width: 108px; height: 14px" />
        <span class="sk__block" style="width: 64%; height: 11px" />
        <span class="sk__block" style="width: 56px; height: 28px" />
      </div>
    </div>
    <div class="sk__table">
      <div class="sk__thead">
        <span class="sk__block" style="width: 150px; height: 13px" />
        <span class="sk__block" style="width: 56px; height: 13px" />
        <span v-for="c in cols" :key="c" class="sk__block" style="width: 76px; height: 13px" />
        <span class="sk__block" style="width: 40px; height: 13px" />
      </div>
      <div v-for="r in rows" :key="r" class="sk__trow">
        <span class="sk__block" style="width: 126px; height: 13px" />
        <span class="sk__block" style="width: 36px; height: 13px" />
        <span v-for="c in cols" :key="`${r}-${c}`" class="sk__block" style="width: 76px; height: 32px" />
        <span class="sk__block" style="width: 32px; height: 13px" />
      </div>
    </div>
  </div>

  <!-- 租户列表：隐私护栏卡 + 筛选栏 + 表头 + 行 -->
  <div v-else-if="preset === 'tenantList'" class="sk">
    <!-- 这块蓝色区域是房间号隐私护栏卡。它固定在列表上方，
         骨架里必须预留它的位置，否则数据到达时整列表上移。 -->
    <div class="sk__guard">
      <span class="sk__block" style="width: 128px; height: 14px" />
      <span class="sk__block" style="width: 62%; height: 11px" />
    </div>
    <div class="sk__bar">
      <span class="sk__block" style="width: 180px; height: 32px" />
      <span class="sk__block" style="width: 88px; height: 32px" />
    </div>
    <div class="sk__table">
      <div class="sk__thead">
        <span class="sk__block" style="width: 36px; height: 13px" />
        <span class="sk__block" style="width: 160px; height: 13px" />
        <span class="sk__block" style="width: 92px; height: 13px" />
        <span class="sk__block" style="width: 88px; height: 13px" />
        <span class="sk__block" style="width: 120px; height: 13px" />
      </div>
      <div v-for="r in rows" :key="r" class="sk__trow">
        <span class="sk__block" style="width: 16px; height: 16px" />
        <span class="sk__block" style="width: 132px; height: 13px" />
        <span class="sk__block" style="width: 72px; height: 20px" />
        <span class="sk__block" style="width: 64px; height: 13px" />
        <span class="sk__block" style="width: 96px; height: 13px" />
      </div>
    </div>
  </div>

  <!-- 通用列表：筛选栏 + 表头 + 行 -->
  <div v-else class="sk">
    <div class="sk__bar">
      <span class="sk__block" style="width: 160px; height: 32px" />
      <span class="sk__block" style="width: 88px; height: 32px" />
    </div>
    <div class="sk__table">
      <div class="sk__thead">
        <span class="sk__block" style="width: 132px; height: 13px" />
        <span class="sk__block" style="width: 108px; height: 13px" />
        <span class="sk__block" style="width: 88px; height: 13px" />
        <span class="sk__block" style="width: 72px; height: 13px" />
      </div>
      <div v-for="r in rows" :key="r" class="sk__trow">
        <span class="sk__block" style="width: 148px; height: 13px" />
        <span class="sk__block" style="width: 96px; height: 13px" />
        <span class="sk__block" style="width: 84px; height: 20px" />
        <span class="sk__block" style="width: 56px; height: 13px" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.sk {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.sk__bar,
.sk__cards {
  display: flex;
  gap: var(--sp-3);
  align-items: center;
}
.sk__cards {
  align-items: stretch;
}
.sk__card {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-4);
  border: var(--bw) solid var(--line-150);
  border-radius: var(--r-md);
}
.sk__guard {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-4);
  border-radius: var(--r-md);
  background: var(--brand-50);
}
.sk__table {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.sk__thead,
.sk__trow {
  display: flex;
  gap: var(--sp-3);
  align-items: center;
  padding: var(--sp-3) 0;
}
.sk__thead {
  border-bottom: var(--bw) solid var(--line-200);
}
.sk__trow {
  border-bottom: var(--bw) solid var(--line-100);
}
/* 块本体：底色与扫光只在这里定义一次 */
.sk__block {
  display: inline-block;
  border-radius: var(--r-sm);
  background: var(--line-100);
}
@media (prefers-reduced-motion: no-preference) {
  .sk__block {
    animation: sk-pulse 1400ms ease-in-out infinite;
  }
}
@keyframes sk-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}
</style>
