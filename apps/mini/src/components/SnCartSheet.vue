<script setup lang="ts">
import { ref } from 'vue';
import SnSheet from './SnSheet.vue';
import SnAmount from './SnAmount.vue';
import SnStepper from './SnStepper.vue';
import SnDivider from './SnDivider.vue';
import { useCartStore, type CartLine } from '../stores/cart';

/**
 * S-09 购物车面板。
 *
 * 四条规则，都是踩过才知道的：
 *
 * ① **楼栋不可切换**。购物车属于某一栋，在车里换栋等于把车清空 ——
 *    把切换入口放在购物车里，学生一点就会丢东西。要换栋请去首页。
 *    所以这里只显示楼栋牌（不可点），并在下方写明"一个购物车只能属于一栋楼"。
 *
 * ② **缺货行不静默移除**（CS-07）。商户下架一件商品，学生打开购物车发现
 *    "少了一样东西"，第一反应是"我是不是没加进去"，反复找。标出来 + 让他自己移出，
 *    信息是完整的。
 *
 * ③ **移出给撤销**。学生在车里减数量，很容易减过头。撤回窗口只有几秒，
 *    但能消掉这类"手滑"的全部客诉。
 *
 * ④ **金额只做展示**。这里的小计是明细求和，用于让学生看清"大概多少钱"；
 *    真正扣多少以服务端下单后返回的金额为准（价格可能被商户改过，syncLimits 会同步）。
 */
const props = defineProps<{ modelValue: boolean; buildingName: string }>();

const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void; (e: 'checkout'): void }>();

const cart = useCartStore();

/** 撤销条：只存一行，因为减数量的操作永远只影响一行 */
const undoLine = ref<CartLine | null>(null);
let undoTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleUndo(line: CartLine) {
  undoLine.value = { ...line };
  if (undoTimer) clearTimeout(undoTimer);
  undoTimer = setTimeout(() => {
    undoLine.value = null;
    undoTimer = null;
  }, 5_000);
}

function doUndo() {
  if (undoLine.value) cart.restoreLine(undoLine.value);
  undoLine.value = null;
  if (undoTimer) {
    clearTimeout(undoTimer);
    undoTimer = null;
  }
}

function onQtyChange(line: CartLine, v: number) {
  if (v <= 0) {
    scheduleUndo(line);
    cart.remove(line.productId);
    return;
  }
  cart.setQty(line.productId, v);
}

function onRemove(line: CartLine) {
  scheduleUndo(line);
  cart.remove(line.productId);
}

function onOverflow() {
  uni.showToast({ title: '本栋库存不足了', icon: 'none' });
}

function goCheckout() {
  if (cart.isEmpty || cart.hasInvalid) return;
  emit('update:modelValue', false);
  emit('checkout');
}
</script>

<template>
  <SnSheet
    :model-value="modelValue"
    title="购物车"
    :subtitle="`一个购物车只能属于一栋楼 —— 当前：${buildingName || '未选择'}（如需更换请回首页切换楼栋）`"
    height="full"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <!-- 楼栋牌：只展示不可切换 -->
    <view class="ct__building">
      <view class="ct__bchip">
        <text class="ct__bchiptext">{{ buildingName || '未选择楼栋' }}</text>
      </view>
      <text class="ct__bnote">换楼栋会清空购物车，所以要换就趁早</text>
    </view>

    <view v-if="cart.isEmpty" class="ct__empty">
      <text class="ct__emptytitle">购物车是空的</text>
      <text class="ct__emptydesc">挑几件加到车里，结算时会按你选的楼栋核库存</text>
    </view>

    <view v-else class="ct__list">
      <view v-for="l in cart.lines" :key="l.productId" class="ct__row" :class="{ 'is-bad': l.invalid }">
        <view class="ct__thumb">
          <image v-if="l.cover" class="ct__img" :src="l.cover" mode="aspectFill" />
          <view v-else class="ct__img ct__img--empty" />
        </view>

        <view class="ct__main">
          <text class="ct__name">{{ l.name }}</text>
          <text v-if="l.spec" class="ct__spec">{{ l.spec }}</text>
          <text v-if="l.invalid" class="ct__bad">本栋已售完，请移出后结算</text>
        </view>

        <view class="ct__right">
          <SnAmount :fen="l.priceCents" size="sm" />
          <view v-if="l.invalid" class="ct__remove" @click="onRemove(l)">
            <text>移出</text>
          </view>
          <SnStepper
            v-else
            :model-value="l.qty"
            :max="l.limit"
            @update:model-value="(v: number) => onQtyChange(l, v)"
            @remove="onRemove(l)"
            @overflow="onOverflow"
          />
        </view>
      </view>

      <SnDivider />
      <view class="ct__sum">
        <text class="ct__sumlabel">共 {{ cart.count }} 件，合计</text>
        <SnAmount :fen="cart.totalCents" size="md" />
      </view>
      <text class="ct__sumnote">最终金额以下单时服务端计算为准</text>
    </view>

    <!-- 撤销条：盖在抽屉内容之上，5 秒后自动消失 -->
    <view v-if="undoLine" class="ct__undo">
      <text class="ct__undotext">已移出「{{ undoLine.name }}」</text>
      <text class="ct__undobtn" @click="doUndo">撤销</text>
    </view>

    <template #footer>
      <view class="ct__foot">
        <view class="ct__footsum">
          <text class="ct__footlabel">合计</text>
          <SnAmount :fen="cart.totalCents" size="md" />
        </view>
        <view class="ct__footbtn">
          <view
            class="ct__go"
            :class="{ 'is-disabled': cart.isEmpty || cart.hasInvalid }"
            @click="goCheckout"
          >
            <text>去结算</text>
          </view>
        </view>
      </view>
      <!-- 禁用原因必须写出来：只把按钮变灰，学生会反复点 -->
      <text v-if="cart.hasInvalid" class="ct__block">
        「{{ cart.invalidNames.join('、') }}」在本栋已售完，请先移出再结算
      </text>
    </template>
  </SnSheet>
</template>

<style>
.ct__building {
  padding: 0 var(--page-x) var(--sp-3);
}
.ct__bchip {
  height: var(--building-chip-h);
  border-radius: var(--building-chip-r);
  background: var(--building-chip-bg);
  display: flex;
  align-items: center;
  justify-content: center;
}
.ct__bchiptext {
  font-size: var(--fs-card);
  font-weight: var(--fw-semibold);
  color: var(--building-chip-fg);
}
.ct__bnote {
  display: block;
  margin-top: var(--sp-2);
  font-size: var(--fs-tag);
  color: var(--ink-500);
}
.ct__empty {
  padding: var(--sp-8) var(--page-x);
  display: flex;
  flex-direction: column;
  align-items: center;
}
.ct__emptytitle {
  font-size: var(--fs-section);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}
.ct__emptydesc {
  margin-top: var(--sp-2);
  font-size: var(--fs-sub);
  color: var(--ink-500);
  text-align: center;
}
.ct__list {
  padding: 0 var(--page-x);
}
.ct__row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3) 0;
  border-bottom: var(--bd);
}
.ct__thumb {
  width: 56px;
  height: 56px;
  border-radius: var(--r-md);
  overflow: hidden;
  background: var(--line-100);
  flex: none;
}
.ct__img {
  width: 100%;
  height: 100%;
}
.ct__img--empty {
  background: var(--line-100);
}
.ct__main {
  flex: 1;
  min-width: 0;
}
.ct__name {
  display: block;
  font-size: var(--fs-card);
  color: var(--ink-900);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.ct__spec {
  display: block;
  font-size: var(--fs-tag);
  color: var(--ink-500);
}
/* 缺货是需要学生动手的状态，用 danger 是正确的（AC-02 的判据是"是否需要立刻动手"） */
.ct__bad {
  display: block;
  margin-top: 2px;
  font-size: var(--fs-tag);
  color: var(--danger);
}
.ct__right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--sp-1);
  flex: none;
}
.ct__remove {
  height: 28px;
  padding: 0 var(--sp-3);
  border-radius: var(--r-sm);
  border: var(--bw) solid var(--danger);
  display: flex;
  align-items: center;
}
.ct__remove text {
  font-size: var(--fs-tag);
  font-weight: var(--fw-medium);
  color: var(--danger);
}
.ct__sum {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.ct__sumlabel {
  font-size: var(--fs-body);
  color: var(--ink-700);
}
.ct__sumnote {
  display: block;
  margin: var(--sp-1) 0 var(--sp-6);
  font-size: var(--fs-tag);
  color: var(--ink-400);
}
.ct__undo {
  position: sticky;
  bottom: var(--sp-2);
  margin: 0 var(--page-x) var(--sp-2);
  height: 44px;
  border-radius: var(--r-md);
  background: var(--dark-surface);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--sp-4);
}
.ct__undotext {
  font-size: var(--fs-sub);
  color: var(--on-brand);
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.ct__undobtn {
  font-size: var(--fs-card);
  font-weight: var(--fw-semibold);
  color: var(--brand-300);
  padding-left: var(--sp-3);
}
.ct__foot {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
.ct__footsum {
  flex: 1;
  display: flex;
  flex-direction: column;
}
.ct__footlabel {
  font-size: var(--fs-tag);
  color: var(--ink-500);
}
.ct__footbtn {
  flex: none;
}
.ct__go {
  height: 44px;
  padding: 0 var(--sp-8);
  border-radius: var(--r-lg);
  background: var(--brand-500);
  display: flex;
  align-items: center;
  justify-content: center;
}
.ct__go text {
  font-size: var(--fs-card);
  font-weight: var(--fw-semibold);
  color: var(--on-brand);
}
.ct__go.is-disabled {
  background: var(--brand-300);
}
.ct__block {
  display: block;
  margin-top: var(--sp-2);
  font-size: var(--fs-tag);
  color: var(--danger);
  line-height: var(--lh-tag);
}
</style>
