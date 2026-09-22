<script setup lang="ts">
import { computed } from 'vue';
import SnSheet from './SnSheet.vue';
import SnAmount from './SnAmount.vue';
import SnStepper from './SnStepper.vue';
import type { StorefrontItem } from '../utils/api';

/**
 * S-08 商品详情抽屉。
 *
 * 用抽屉而不是新页面：学生是在"翻列表"的过程中被某件商品吸引的，
 * 看完要能立刻回到原来的滚动位置继续翻。跳新页面再返回，列表滚回顶部 ——
 * 这个细节在小程序里非常明显，学生只会觉得"这 App 很难用"。
 */
const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    /** null = 还没选商品（抽屉不该在此时可见） */
    item: StorefrontItem | null;
    /** 购物车中该商品已有数量 */
    qty: number;
    /** 该栋目前是否可下单 —— 不可下单时加购按钮要说明原因，不能只是灰着 */
    orderable?: boolean;
    gateMessage?: string;
    buildingName?: string;
  }>(),
  { orderable: true, gateMessage: '', buildingName: '' },
);

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'add'): void;
  (e: 'setQty', qty: number): void;
}>();

const soldOut = computed(() => props.item?.visibility === 'sold_out' || (props.item?.availableQty ?? 0) <= 0);

/** 步进器上限：可售量。这里把"还能加几个"直接告诉学生，而不是让他点到被拒 */
const limitHint = computed(() => {
  if (!props.item) return '';
  if (soldOut.value) return '本栋已售完';
  if (props.qty >= props.item.availableQty) return `本栋仅剩 ${props.item.availableQty} 件，已全部加购`;
  if (props.item.availableQty <= 5) return `本栋仅剩 ${props.item.availableQty} 件`;
  return '';
});

const disabledReason = computed(() => {
  if (soldOut.value) return '本栋已售完，可看看其他商品';
  if (!props.orderable) return props.gateMessage || '当前不可下单';
  return '';
});

function onQty(v: number) {
  emit('setQty', v);
}

/* uni 是运行时全局对象，**不能写进模板表达式** ——
 * Vue 的模板作用域只解析 setup 暴露的绑定与组件自身属性，拿不到全局 uni。
 * 这类错误 vue-tsc 也不报，只在真机上表现为"点了没反应"，所以统一收敛成方法。 */
function onOverflow(): void {
  uni.showToast({ title: '本栋库存不足了', icon: 'none' });
}

function onAlreadyInCart(): void {
  uni.showToast({ title: '已在购物车里，可去购物车调整', icon: 'none' });
}
</script>

<template>
  <SnSheet
    :model-value="modelValue"
    title="商品详情"
    height="full"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <view v-if="item" class="pd">
      <!-- 4:3 大图。用 SnThumb 的占位逻辑不合适（尺寸固定四档），这里单独写：
           比例图必须跟随宽度自适应，固定像素在宽屏 H5 上会很难看 -->
      <view class="pd__hero">
        <image v-if="item.cover" class="pd__img" :src="item.cover" mode="aspectFill" />
        <view v-else class="pd__img pd__img--empty">
          <text class="pd__emptytext">暂无图</text>
        </view>
      </view>

      <view class="pd__info">
        <text class="pd__name">{{ item.name }}</text>
        <text v-if="item.spec" class="pd__spec">{{ item.spec }}</text>

        <view class="pd__meta">
          <text v-if="buildingName" class="pd__metaItem">{{ buildingName }}</text>
          <text v-if="!soldOut" class="pd__metaItem">本栋可售 {{ item.availableQty }} 件</text>
          <text v-else class="pd__metaItem is-off">本栋已售完</text>
        </view>

        <view class="pd__price">
          <SnAmount :fen="item.priceCents" size="lg" />
        </view>

        <view class="pd__buy">
          <text class="pd__buylabel">购买数量</text>
          <SnStepper
            :model-value="qty"
            :max="item.availableQty"
            :limit-hint="limitHint"
            :disabled="soldOut || !orderable"
            @update:model-value="onQty"
            @overflow="onOverflow"
          />
        </view>

        <view v-if="disabledReason" class="pd__block">
          <text class="pd__blocktext">{{ disabledReason }}</text>
        </view>
      </view>
    </view>

    <template #footer>
      <view class="pd__foot">
        <view class="pd__footprice">
          <text class="pd__footlabel">合计</text>
          <SnAmount :fen="(item?.priceCents ?? 0) * qty" size="md" />
        </view>
        <!-- 加购本身不产生订单，所以"本栋已售完"时禁用；不可下单时也禁用，
             否则学生能加进车却结不了账，是更差的体验 -->
        <view class="pd__footbtn">
          <view v-if="qty > 0" class="pd__addbtn is-sec" @click="onAlreadyInCart">
            <text>已加购</text>
          </view>
          <view
            class="pd__addbtn"
            :class="{ 'is-disabled': soldOut || !orderable }"
            @click="!soldOut && orderable && emit('add')"
          >
            <text>{{ soldOut ? '已售完' : orderable ? '加入购物车' : '暂不可下单' }}</text>
          </view>
        </view>
      </view>
    </template>
  </SnSheet>
</template>

<style>
.pd__hero {
  width: 100%;
  padding-top: 75%;
  position: relative;
  background: var(--line-100);
  border-radius: var(--r-md);
  overflow: hidden;
}
.pd__img {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  width: 100%;
  height: 100%;
}
.pd__img--empty {
  display: flex;
  align-items: center;
  justify-content: center;
}
.pd__emptytext {
  font-size: var(--fs-sub);
  color: var(--ink-400);
}
.pd__info {
  padding: var(--sp-4) 0 var(--sp-6);
}
.pd__name {
  display: block;
  font-size: var(--fs-title);
  font-weight: var(--fw-semibold);
  line-height: var(--lh-title);
  color: var(--ink-900);
}
.pd__spec {
  display: block;
  margin-top: var(--sp-1);
  font-size: var(--fs-sub);
  color: var(--ink-500);
}
.pd__meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-3);
  margin-top: var(--sp-3);
}
.pd__metaItem {
  font-size: var(--fs-sub);
  color: var(--ink-500);
}
.pd__metaItem.is-off {
  color: var(--off);
}
.pd__price {
  margin-top: var(--sp-4);
}
.pd__buy {
  margin-top: var(--sp-5);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: var(--sp-4);
  border-top: var(--bd);
}
.pd__buylabel {
  font-size: var(--fs-body);
  color: var(--ink-700);
}
.pd__block {
  margin-top: var(--sp-4);
  padding: var(--sp-3);
  border-radius: var(--r-md);
  background: var(--off-bg);
}
.pd__blocktext {
  font-size: var(--fs-sub);
  color: var(--off);
  line-height: var(--lh-sub);
}
.pd__foot {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
.pd__footprice {
  flex: 1;
  display: flex;
  flex-direction: column;
}
.pd__footlabel {
  font-size: var(--fs-tag);
  color: var(--ink-500);
}
.pd__footbtn {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.pd__addbtn {
  height: 44px;
  padding: 0 var(--sp-6);
  border-radius: var(--r-lg);
  background: var(--brand-500);
  display: flex;
  align-items: center;
  justify-content: center;
}
.pd__addbtn text {
  font-size: var(--fs-card);
  font-weight: var(--fw-semibold);
  color: var(--on-brand);
}
.pd__addbtn.is-sec {
  background: var(--brand-100);
}
.pd__addbtn.is-sec text {
  color: var(--brand-700);
}
/* 禁用主色：只表示"不可用"，不表示"危险"（--brand-300 的设计意图） */
.pd__addbtn.is-disabled {
  background: var(--brand-300);
}
</style>
