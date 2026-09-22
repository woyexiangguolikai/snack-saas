<script setup lang="ts">
import { computed } from 'vue';
import SnAmount from './SnAmount.vue';
import SnTag from './SnTag.vue';
import { useCountdown, relativeTime } from '../composables/useCountdown';
import type { StudentOrder } from '../utils/api';

/**
 * 订单卡（S-13 列表用；详情页头部复用的是同一套"状态 + 编号 + 金额"规则）。
 *
 * 三条约束：
 *  ① **状态的颜色与文案全部来自服务端**（tone / statusText / hint）。
 *     前端不写 `status === 'delivered' ? 'ok' : 'warn'` —— 那是把状态机抄第二遍。
 *  ② **按钮由服务端 actions 决定**。前端不判断"能不能取消"，只渲染服务端说能做的。
 *  ③ 待支付倒计时**只做展示**。到点的处理是"去问服务端"，不是本地把单判成已关闭
 *     —— 本地时钟不可信（AC-14），而且"关单"是一个有副作用的动作，必须服务端做。
 */
const props = defineProps<{
  order: StudentOrder;
  /** 该单是否需要高亮（从支付结果页跳来时） */
  highlight?: boolean;
}>();

const emit = defineEmits<{
  (e: 'pay', orderNo: string): void;
  (e: 'cancel', orderNo: string): void;
  (e: 'open', orderNo: string): void;
  (e: 'expired', orderNo: string): void;
}>();

const showTimer = computed(() => props.order.status === 'pending_pay' && props.order.payExpiresInSeconds !== null);

const { text: countdownText } = useCountdown(
  computed(() => (showTimer.value ? props.order.payExpiresInSeconds : null)),
  () => {
    // 到点：交给父级去重新拉服务端状态（本地不判定订单已关闭）
    emit('expired', props.order.orderNo);
  },
);

const canPay = computed(() => props.order.actions.includes('pay'));
const canCancel = computed(() => props.order.actions.includes('cancel'));

/** 商品摘要：最多 3 个，其余折成「等 N 件」—— 卡片不是订单详情，不需要列全 */
const summary = computed(() => {
  const items = props.order.items ?? [];
  const head = items.slice(0, 3).map((i) => `${i.name}×${i.qty}`);
  const rest = items.length - head.length;
  return rest > 0 ? `${head.join('、')} 等 ${items.length} 件` : head.join('、');
});
</script>

<template>
  <view class="oc" :class="{ 'is-hl': highlight }" @click="emit('open', order.orderNo)">
    <view class="oc__head">
      <view class="oc__left">
        <text class="oc__building">{{ order.buildingName }}</text>
        <text class="oc__time">{{ relativeTime(order.createdAt) }}</text>
      </view>
      <SnTag :tone="order.tone" :label="order.statusText" />
    </view>

    <text class="oc__summary">{{ summary }}</text>

    <view class="oc__foot">
      <view class="oc__amount">
        <SnAmount :fen="order.totalCents" size="md" />
        <text class="oc__count">共 {{ order.itemCount }} 件</text>
      </view>

      <view class="oc__acts">
        <!-- 待支付：倒计时 + 去支付（倒计时是"还剩多久"，不是"何时关闭"） -->
        <view v-if="showTimer" class="oc__timer">
          <text class="oc__timertext num">{{ countdownText }}</text>
          <text class="oc__timerlabel">后关闭</text>
        </view>
        <view v-if="canCancel" class="oc__btn is-ghost" @click.stop="emit('cancel', order.orderNo)">
          <text>取消订单</text>
        </view>
        <view v-if="canPay" class="oc__btn" @click.stop="emit('pay', order.orderNo)">
          <text>去支付</text>
        </view>
      </view>
    </view>

    <!-- 状态说明用中性文案，服务端已按 D5 禁用词表写过一遍 -->
    <text class="oc__hint">{{ order.hint }}</text>
  </view>
</template>

<style>
.oc {
  background: var(--surface);
  border: var(--bd);
  border-radius: var(--r-md);
  padding: var(--sp-4);
}
/* 从支付结果页跳来时高亮一下：让学生一眼找到"刚才那一单" */
.oc.is-hl {
  border-color: var(--brand-500);
}
.oc__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-2);
}
.oc__left {
  flex: 1;
  min-width: 0;
}
.oc__building {
  display: block;
  font-size: var(--fs-card);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}
.oc__time {
  display: block;
  margin-top: 2px;
  font-size: var(--fs-tag);
  color: var(--ink-400);
}
.oc__summary {
  display: block;
  margin-top: var(--sp-3);
  font-size: var(--fs-sub);
  color: var(--ink-700);
  line-height: var(--lh-sub);
}
.oc__foot {
  margin-top: var(--sp-3);
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--sp-2);
}
.oc__amount {
  display: flex;
  flex-direction: column;
}
.oc__count {
  font-size: var(--fs-tag);
  color: var(--ink-500);
}
.oc__acts {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
  justify-content: flex-end;
}
.oc__timer {
  display: flex;
  align-items: baseline;
  gap: 2px;
}
.oc__timertext {
  font-size: var(--fs-sub);
  font-weight: var(--fw-semibold);
  color: var(--warn);
}
.oc__timerlabel {
  font-size: var(--fs-tag);
  color: var(--warn);
}
.oc__btn {
  height: 34px;
  padding: 0 var(--sp-4);
  border-radius: var(--r-md);
  background: var(--brand-500);
  display: flex;
  align-items: center;
  justify-content: center;
}
.oc__btn text {
  font-size: var(--fs-sub);
  font-weight: var(--fw-semibold);
  color: var(--on-brand);
}
.oc__btn.is-ghost {
  background: var(--surface);
  border: var(--bw) solid var(--line-200);
}
.oc__btn.is-ghost text {
  color: var(--ink-700);
  font-weight: var(--fw-normal);
}
.oc__hint {
  display: block;
  margin-top: var(--sp-2);
  font-size: var(--fs-tag);
  color: var(--ink-400);
  line-height: var(--lh-tag);
}
</style>
