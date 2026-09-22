<script setup lang="ts">
import { computed } from 'vue';
import SnAmount from './SnAmount.vue';
import SnStepper from './SnStepper.vue';
import type { StorefrontItem } from '../utils/api';

/**
 * 商品条目（首页「行式」与分类页「网格」共用）。
 *
 * 为什么合成一个组件而不是各写一份：
 *   两处显示的是**同一份数据**（storefront 的同一批字段），但商品名、价格、
 *   可售数量的排版规则必须一致。分成两份后，改一处忘一处就会出现
 *   "首页显示本栋剩 3 件、分类页显示可售 3 件"这种不一致，排查很费时间。
 *   用 layout 切换形态，规则只写一遍。
 *
 * 一条纪律：**售罄商品不隐藏，只是不能加购**。
 *   隐藏会让"我明明看到有的"变成客诉；置灰 + 明确标"售完"才是可解释的。
 */
const props = withDefaults(
  defineProps<{
    item: StorefrontItem;
    qty: number;
    layout?: 'row' | 'grid';
    /** 当前楼栋能否下单 —— 不能时步进器要说明原因 */
    orderable?: boolean;
  }>(),
  { layout: 'row', orderable: true },
);

const emit = defineEmits<{
  (e: 'add'): void;
  (e: 'setQty', qty: number): void;
  (e: 'open'): void;
}>();

const soldOut = computed(() => props.item.visibility === 'sold_out' || props.item.availableQty <= 0);

const limitHint = computed(() => {
  if (soldOut.value) return '';
  if (props.qty >= props.item.availableQty) return `仅剩 ${props.item.availableQty} 件`;
  return '';
});

function onQty(v: number) {
  emit('setQty', v);
}

function onOverflow() {
  uni.showToast({ title: '本栋库存不足了', icon: 'none' });
}

function onOpen() {
  emit('open');
}
</script>

<template>
  <view class="pi" :class="[`pi--${layout}`, { 'is-off': soldOut }]" @click="onOpen">
    <view class="pi__thumb">
      <image v-if="item.cover" class="pi__img" :src="item.cover" mode="aspectFill" />
      <view v-else class="pi__img pi__img--empty"><text>暂无图</text></view>
      <view v-if="soldOut" class="pi__outmask"><text class="pi__outtext">售完</text></view>
    </view>

    <view class="pi__main">
      <text class="pi__name">{{ item.name }}</text>
      <text v-if="item.spec" class="pi__spec">{{ item.spec }}</text>

      <view class="pi__foot">
        <SnAmount :fen="item.priceCents" :size="layout === 'grid' ? 'md' : 'md'" />
        <!-- 步进器在售罄时不显示：显示一个永远点不动的控件比不显示更让人困惑 -->
        <view v-if="!soldOut" class="pi__step" @click.stop>
          <SnStepper
            :model-value="qty"
            :max="item.availableQty"
            :limit-hint="limitHint"
            :disabled="!orderable"
            @update:model-value="onQty"
            @overflow="onOverflow"
          />
        </view>
        <text v-else class="pi__outtag">本栋售完</text>
      </view>

      <text v-if="!soldOut && !orderable" class="pi__gatehint">当前不可下单</text>
    </view>
  </view>
</template>

<style>
.pi {
  display: flex;
  background: var(--surface);
  border-radius: var(--r-md);
  border: var(--bd);
  overflow: hidden;
}
.pi--row {
  padding: var(--sp-3);
  gap: var(--sp-3);
  align-items: stretch;
}
.pi--grid {
  flex-direction: column;
  padding: var(--sp-2);
  gap: var(--sp-2);
}
.pi__thumb {
  position: relative;
  border-radius: var(--r-sm);
  overflow: hidden;
  background: var(--line-100);
  flex: none;
}
.pi--row .pi__thumb {
  width: 72px;
  height: 72px;
}
.pi--grid .pi__thumb {
  width: 100%;
  padding-top: 100%;
}
.pi--grid .pi__thumb .pi__img {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
}
.pi__img {
  width: 100%;
  height: 100%;
}
.pi__img--empty {
  display: flex;
  align-items: center;
  justify-content: center;
}
.pi__img--empty text {
  font-size: var(--fs-tag);
  color: var(--ink-400);
}
.pi__outmask {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  background: var(--mask);
  display: flex;
  align-items: center;
  justify-content: center;
}
.pi__outtext {
  font-size: var(--fs-tag);
  font-weight: var(--fw-semibold);
  color: var(--on-brand);
}
.pi__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.pi__name {
  font-size: var(--fs-card);
  font-weight: var(--fw-semibold);
  line-height: var(--lh-card);
  color: var(--ink-900);
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.pi--row .pi__name {
  -webkit-line-clamp: 1;
}
.pi__spec {
  font-size: var(--fs-tag);
  color: var(--ink-500);
}
.pi__foot {
  margin-top: auto;
  padding-top: var(--sp-2);
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.pi__step {
  flex: none;
}
.pi__outtag {
  font-size: var(--fs-tag);
  color: var(--off);
}
/* 售罄不等于出错：整行压暗，不用红色（AC-02） */
.pi.is-off .pi__name {
  color: var(--ink-400);
}
.pi__gatehint {
  margin-top: 2px;
  font-size: var(--fs-tag);
  color: var(--off);
}
</style>
