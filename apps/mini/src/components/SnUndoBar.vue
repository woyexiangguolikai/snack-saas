<script setup lang="ts">
import { useUndoBar } from '../composables/useUndoBar';

/**
 * A-15 撤销条（全局浮层 · 单例）。
 *
 * 放在**吸底条上方**而不是贴屏幕底部：贴底会盖住「去结算」，
 * 而用户此刻最可能想做的事恰恰是继续结算。
 *
 * 不用 SnSheet / 弹窗：这两个都会打断操作。撤销条必须是"看得见但不挡路"的 ——
 * 它提供的是一条后悔路，不是一次必须回应的询问。
 */
const { offer, undo } = useUndoBar();
</script>

<template>
  <view v-if="offer" class="undo">
    <text class="undo__msg">{{ offer.message }}</text>
    <view class="undo__btn" @click="undo()">
      <text class="undo__btntext">撤销</text>
    </view>
  </view>
</template>

<style>
.undo {
  position: fixed;
  left: var(--page-x);
  right: var(--page-x);
  /* 吸底条（含安全区）之上，避免遮挡「去结算」 */
  bottom: calc(74px + env(safe-area-inset-bottom));
  z-index: 90;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--r-md);
  background: var(--dark-surface);
  box-shadow: var(--sup);
}
.undo__msg {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-sub);
  line-height: var(--lh-sub);
  color: var(--on-brand);
}
.undo__btn {
  flex: none;
  height: 32px;
  padding: 0 var(--sp-3);
  border-radius: var(--r-sm);
  display: flex;
  align-items: center;
  /* 实心主色：撤销是这一条里唯一可点的东西，不能长得像提示文字 */
  background: var(--brand-500);
}
.undo__btntext {
  font-size: var(--fs-sub);
  font-weight: var(--fw-semibold);
  color: var(--on-brand);
}
</style>
