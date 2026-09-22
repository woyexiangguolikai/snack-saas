<script setup lang="ts">
import SnSheet from './SnSheet.vue';
import SnTag from './SnTag.vue';
import { formatAmount } from '../utils/amount';
import type { ResolvedBuilding } from '../stores/session';

/**
 * S-05 楼栋选择抽屉。
 *
 * 两条规则不要改：
 *  ① **停送楼栋不隐藏**（§4.11）。如果某栋今天不送，把它藏起来会让该栋学生
 *     以为"本店不覆盖我们楼"——但明天就送了，他不会再来看第二次。
 *     灰显 + 「今日停送」标签是正确的表达：楼在，今天不行。
 *  ② **已选中的那栋即使停送也要能看到是选中态**。否则学生打开抽屉发现
 *     "一个都没选"，会以为系统把他的选择弄丢了。
 */
const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    buildings: ResolvedBuilding[];
    currentId: number | null;
    /** 单楼栋自动降级模式下不允许切换（§4.9） */
    locked?: boolean;
    /**
     * 是否允许选中「今日停送」的楼栋。
     *
     * 两种调用场景的正确答案是**相反**的：
     *   · 下单场景 → false。停送楼栋不能下单，选了也白选，这里拦住并说明原因。
     *   · 地址场景 → true。**学生就是住在那栋**。今天不送不代表他不该存这个地址，
     *     拦住他等于"你家今天没人送外卖，所以你不能填你家地址"，很荒谬。
     * 所以由调用方声明场景，而不是让组件猜。
     */
    allowPaused?: boolean;
  }>(),
  { locked: false, allowPaused: false },
);

const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void; (e: 'pick', id: number): void }>();

function pick(b: ResolvedBuilding) {
  if (b.deliveryEnabled === false && !props.allowPaused) {
    // 停送楼栋不给选，但要说清为什么 —— 只置灰不说话是最招人烦的交互
    uni.showToast({ title: `${b.buildingName}今日暂不配送，可先看看其他楼栋`, icon: 'none' });
    return;
  }
  emit('pick', b.buildingId);
  emit('update:modelValue', false);
}

function contactShop() {
  emit('update:modelValue', false);
  uni.showToast({ title: '请联系店家确认配送范围', icon: 'none' });
}
</script>

<template>
  <SnSheet
    :model-value="modelValue"
    title="选择你的宿舍楼"
    :subtitle="locked ? '本店只配送一栋楼，默认已选好' : '商品与库存按楼栋区分，选错会看到别的楼的东西'"
    height="half"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <view class="bs">
      <view
        v-for="b in buildings"
        :key="b.buildingId"
        class="bs__item"
        :class="{ 'is-on': b.buildingId === currentId, 'is-off': b.deliveryEnabled === false }"
        @click="pick(b)"
      >
        <view class="bs__main">
          <view class="bs__row">
            <text class="bs__name">{{ b.buildingName }}</text>
            <SnTag v-if="b.isDefault" tone="off" variant="outline" label="默认" />
            <SnTag v-if="b.deliveryEnabled === false" tone="warn" label="今日停送" />
          </view>
          <text class="bs__meta">
            起送 {{ formatAmount(b.minAmountCents) }}
            <text v-if="b.deliveryFeeCents > 0"> · 配送费 {{ formatAmount(b.deliveryFeeCents) }}</text>
            · 可下单至 {{ b.cutoffTime }}
          </text>
        </view>
        <view v-if="b.buildingId === currentId" class="bs__check"><text>✓</text></view>
      </view>
    </view>

    <template #footer>
      <view class="bs__foot">
        <text class="bs__foottext">没有找到你的楼栋？</text>
        <text class="bs__footlink" @click="contactShop">联系店家确认配送范围</text>
      </view>
    </template>
  </SnSheet>
</template>

<style>
.bs__item {
  display: flex;
  align-items: center;
  padding: var(--sp-3) var(--page-x);
  border-bottom: var(--bd);
}
.bs__item.is-on {
  background: var(--brand-50);
}
/* 停送 ≠ 危险（AC-02）：用 off 灰，不用红 */
.bs__item.is-off .bs__name {
  color: var(--ink-400);
}
.bs__main {
  flex: 1;
  min-width: 0;
}
.bs__row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.bs__name {
  font-size: var(--fs-card);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}
.bs__meta {
  display: block;
  margin-top: 2px;
  font-size: var(--fs-sub);
  color: var(--ink-500);
  line-height: var(--lh-sub);
}
.bs__check {
  width: 22px;
  height: 22px;
  border-radius: var(--r-full);
  background: var(--brand-500);
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
.bs__check text {
  color: var(--on-brand);
  font-size: 13px;
  font-weight: var(--fw-semibold);
}
.bs__foot {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-1);
}
.bs__foottext {
  font-size: var(--fs-sub);
  color: var(--ink-500);
}
.bs__footlink {
  font-size: var(--fs-sub);
  font-weight: var(--fw-medium);
  color: var(--brand-700);
}
</style>
