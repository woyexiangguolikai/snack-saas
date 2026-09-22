<script setup lang="ts">
import SnSkeleton from './SnSkeleton.vue';

/**
 * 页面级骨架（A-13 的页面装配层）。
 *
 * 存在理由只有一个：**骨架块的尺寸必须与真实内容一致**。
 * 不一致时数据到达会让整页位移 —— 那比没有骨架更难受，因为用户刚读完一行字它就跳走了。
 * 而"每个页面自己拼一遍"必然会不一致（时间条少占 62px、分类左栏宽度写错、
 * 配送清单漏掉 26px 勾选圈…）。把这 6 类结构收在一个文件里，不一致就变成一眼可见的代码差异。
 *
 * 六类结构（依据《加载过渡与状态全集 v3.0》§02 骨架屏表）：
 *   home        分类锚点 32 · 商品行 ×3      （楼栋牌/时间条由首页自己占位 —— 它们不参与滚动）
 *   category    楼栋牌 44 · 左栏 92px×5 行 44px · 右栏 2 列网格
 *   orderList   筛选 Chip 30 · 订单卡 ×3 · 底部 40（卡片内虚线分隔也要画）
 *   orderDetail 状态卡 · 小票明细（**含合计行**）· 键值卡 · 底部操作区
 *   delivery    楼栋牌 36 · 楼层头 19 · 配送行 ×3（**含 26px 勾选圈**）
 *   stockQuick  商品行 ×4（72px 缩略图 + 一排库存格，**格数按实际楼栋数**）
 *
 * 为什么 stockQuick 的格数必须外部传：写死 3 个的话，4 栋楼的商户
 * 看到骨架时布局是对的、数据到达却多出一格 —— 恰好违反了骨架的唯一价值。
 */
withDefaults(
  defineProps<{
    preset: 'home' | 'category' | 'orderList' | 'orderDetail' | 'delivery' | 'stockQuick';
    /** stockQuick 专用：库存格数量 = 该商户的楼栋数 */
    cells?: number;
    /** delivery / orderList 的行数（默认按设计文档的 3） */
    rows?: number;
  }>(),
  { cells: 3, rows: 3 },
);
</script>

<template>
  <!-- ① 首页：分类锚点 + 商品行 -->
  <view v-if="preset === 'home'" class="ps">
    <view class="ps__anchor">
      <view v-for="i in 4" :key="i" class="ps__anchorchip" />
    </view>
    <view v-for="i in rows" :key="`g${i}`" class="ps__group">
      <view class="ps__grouphead">
        <SnSkeleton variant="title" width="72px" />
        <SnSkeleton variant="sub" width="32px" />
      </view>
      <view class="ps__prow">
        <view class="ps__thumb72" />
        <view class="ps__ptext">
          <SnSkeleton variant="text" width="70%" />
          <SnSkeleton variant="sub" width="46%" />
          <SnSkeleton variant="amount" width="58px" />
        </view>
      </view>
    </view>
  </view>

  <!-- ② 分类页：楼栋牌 44 + 左栏 92 + 右栏两列网格 -->
  <view v-else-if="preset === 'category'" class="ps">
    <view class="ps__chip44" />
    <view class="ps__cat">
      <view class="ps__catleft">
        <view v-for="i in 5" :key="i" class="ps__catrow" />
      </view>
      <view class="ps__catright">
        <view v-for="i in 4" :key="i" class="ps__card">
          <view class="ps__thumb96" />
          <SnSkeleton variant="sub" width="80%" />
          <SnSkeleton variant="amount" width="52px" />
        </view>
      </view>
    </view>
  </view>

  <!-- ③ 订单列表：筛选 Chip 30 + 订单卡 + 底部 -->
  <view v-else-if="preset === 'orderList'" class="ps">
    <view class="ps__chips">
      <view v-for="i in 4" :key="i" class="ps__chip30" />
    </view>
    <view v-for="i in rows" :key="i" class="ps__ocard">
      <view class="ps__orow">
        <SnSkeleton variant="title" width="112px" />
        <SnSkeleton variant="sub" width="52px" />
      </view>
      <view class="ps__dash" />
      <view class="ps__orow">
        <SnSkeleton variant="text" width="60%" />
        <SnSkeleton variant="amount" width="60px" />
      </view>
    </view>
    <view class="ps__tail40" />
  </view>

  <!-- ④ 订单详情：状态卡 + 小票（含合计行）+ 键值卡 + 底部操作区 -->
  <view v-else-if="preset === 'orderDetail'" class="ps">
    <view class="ps__statuscard">
      <SnSkeleton variant="title" width="96px" />
      <SnSkeleton variant="sub" width="140px" />
    </view>
    <view class="ps__receipt">
      <view v-for="i in 3" :key="i" class="ps__orow">
        <SnSkeleton variant="text" width="64%" />
        <SnSkeleton variant="text" width="48px" />
      </view>
      <view class="ps__dash" />
      <!-- 合计行必须有：漏了它，数据到达时下面会多出一行 -->
      <view class="ps__orow">
        <SnSkeleton variant="text" width="40px" />
        <SnSkeleton variant="amount" width="72px" />
      </view>
    </view>
    <view class="ps__kvcard">
      <view v-for="i in 3" :key="i" class="ps__kvrow">
        <SnSkeleton variant="sub" width="56px" />
        <SnSkeleton variant="sub" width="120px" />
      </view>
    </view>
    <view class="ps__tail60" />
  </view>

  <!-- ⑤ 配送清单：楼栋牌 36 + 楼层头 19 + 配送行（含 26px 勾选圈） -->
  <view v-else-if="preset === 'delivery'" class="ps">
    <view class="ps__chip36" />
    <view v-for="g in 2" :key="`f${g}`" class="ps__floorblock">
      <view class="ps__floorhead" />
      <view v-for="i in rows" :key="i" class="ps__drow">
        <view class="ps__circle26" />
        <view class="ps__dtext">
          <SnSkeleton variant="text" width="46%" />
          <SnSkeleton variant="sub" width="68%" />
        </view>
        <view class="ps__qty32" />
      </view>
    </view>
  </view>

  <!-- ⑥ 库存快改：商品行（72px 缩略图 + 一排库存格） -->
  <view v-else class="ps">
    <view v-for="i in 4" :key="i" class="ps__srow">
      <view class="ps__thumb72" />
      <view class="ps__stext">
        <SnSkeleton variant="text" width="62%" />
        <SnSkeleton variant="sub" width="40%" />
      </view>
      <view class="ps__cells">
        <view v-for="c in cells" :key="c" class="ps__cell" />
      </view>
    </view>
  </view>
</template>

<style>
/* 骨架块的底色统一在这里给，页面不重复写 —— 颜色只有一处来源 */
.ps {
  padding: var(--sp-4) var(--page-x);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.ps__anchor {
  display: flex;
  gap: var(--sp-2);
}
/* 32px = 分类锚点真实高度 */
.ps__anchorchip {
  width: 56px;
  height: 32px;
  border-radius: var(--r-full);
  background: var(--line-100);
}
.ps__group {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.ps__grouphead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.ps__prow,
.ps__srow {
  display: flex;
  gap: var(--sp-3);
  align-items: center;
}
/* 72px = 真实商品缩略图边长 */
.ps__thumb72 {
  width: 72px;
  height: 72px;
  border-radius: var(--r-md);
  background: var(--line-100);
  flex: none;
}
.ps__ptext,
.ps__stext {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
/* 44px = 楼栋牌真实高度（AC-01） */
.ps__chip44 {
  height: 44px;
  border-radius: var(--building-chip-r);
  background: var(--line-100);
}
.ps__chip36 {
  height: 36px;
  border-radius: var(--building-chip-r);
  background: var(--line-100);
}
.ps__cat {
  display: flex;
  gap: var(--sp-3);
  align-items: flex-start;
}
/* 左栏宽度必须与真实一致（92px），否则右栏会横向位移 */
.ps__catleft {
  width: 92px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.ps__catrow {
  height: 44px;
  border-radius: var(--r-md);
  background: var(--line-100);
}
.ps__catright {
  flex: 1;
  min-width: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-3);
}
.ps__card {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.ps__thumb96 {
  width: 100%;
  height: 96px;
  border-radius: var(--r-md);
  background: var(--line-100);
}
.ps__chips {
  display: flex;
  gap: var(--sp-2);
}
/* 30px = 筛选 Chip 真实高度 */
.ps__chip30 {
  width: 64px;
  height: 30px;
  border-radius: var(--r-full);
  background: var(--line-100);
}
.ps__ocard,
.ps__receipt,
.ps__kvcard,
.ps__statuscard {
  padding: var(--sp-4);
  border-radius: var(--r-md);
  background: var(--surface);
  border: var(--bw) solid var(--line-150);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
/* 虚线分隔也要画 —— 漏掉它数据到达时会有一像素位移 */
.ps__dash {
  height: 0;
  border-top: var(--bw) dashed var(--line-200);
}
.ps__orow,
.ps__kvrow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
}
.ps__tail40 {
  height: 40px;
}
.ps__tail60 {
  height: 60px;
}
.ps__floorblock {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
/* 19px = 楼层头真实高度 */
.ps__floorhead {
  width: 88px;
  height: 19px;
  border-radius: var(--r-sm);
  background: var(--line-100);
}
.ps__drow {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3);
  border-radius: var(--r-md);
  background: var(--surface);
  border: var(--bw) solid var(--line-150);
}
/* 26px 勾选圈：漏掉它房间号列会横向位移 37px */
.ps__circle26 {
  width: 26px;
  height: 26px;
  border-radius: var(--r-full);
  background: var(--line-100);
  flex: none;
}
.ps__dtext {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.ps__qty32 {
  width: 32px;
  height: 32px;
  border-radius: var(--r-sm);
  background: var(--line-100);
  flex: none;
}
.ps__cells {
  display: flex;
  gap: var(--sp-2);
  flex: none;
}
/* 库存格：与真实格同尺寸，格数由外部按楼栋数给 */
.ps__cell {
  width: 40px;
  height: 40px;
  border-radius: var(--r-sm);
  background: var(--line-100);
}
</style>
