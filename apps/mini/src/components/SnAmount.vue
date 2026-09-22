<script setup lang="ts">
import { computed } from 'vue';
import { amountTone, parseAmount } from '../utils/amount';

/**
 * A-09 金额 Amount（原子 · 价签母题）
 * 全站任何一个位置出现金额，形态必须完全一致。
 *   lg 22px/700 价格红（唯一允许 danger 表达非危险含义的场景，且只用于「标价」）
 *   md 15px/700 ink-900，次要金额用 ink-500
 *   sm 12.5px/700 入账 ok / 出账 danger / 持平 off
 * ¥ 符号缩小到 .62em 与基线对齐，不加空格；数字等宽（AC-05/AC-07）。
 */
const props = withDefaults(
  defineProps<{
    /** 整数分 —— 服务端一律返回分，前端只展示不运算 */
    fen: number;
    size?: 'lg' | 'md' | 'sm';
    /** 账本/对账场景：正数显式显示 + */
    signed?: boolean;
    /** md 档的次要金额（如配送费）用 ink-500 */
    muted?: boolean;
  }>(),
  { size: 'md', signed: false, muted: false },
);

const parts = computed(() => parseAmount(props.fen, { signed: props.signed }));

const tone = computed(() => {
  if (props.size === 'sm') return amountTone(props.fen);
  if (props.size === 'lg') return 'price';
  return props.muted ? 'muted' : 'strong';
});
</script>

<template>
  <view class="sn-amount" :class="[`sn-amount--${size}`, `is-${tone}`]">
    <text class="sn-amount__sym">{{ parts.symbol }}</text>
    <text v-if="parts.sign" class="sn-amount__sign">{{ parts.sign }}</text>
    <text class="sn-amount__int num">{{ parts.int }}</text>
    <text v-if="parts.dec" class="sn-amount__dec num">{{ parts.dec }}</text>
  </view>
</template>

<style>
.sn-amount {
  display: inline-flex;
  align-items: baseline;
}
.sn-amount__sym {
  font-size: 0.62em;
}
.sn-amount__sign {
  margin-right: 1px;
}
.sn-amount__int,
.sn-amount__dec {
  letter-spacing: 0;
}

/* 大档：商品详情 / 结算合计 */
.sn-amount--lg {
  font-size: var(--fs-title);
  font-weight: 700;
  letter-spacing: -0.02em;
}
.sn-amount--md {
  font-size: var(--fs-card);
  font-weight: 700;
}
.sn-amount--sm {
  font-size: var(--fs-sub);
  font-weight: 700;
}

/* 价格红仅用于标价（零售业惯例，与「危险」无关） */
.sn-amount--lg.is-price {
  color: var(--danger);
}
.sn-amount--md.is-strong {
  color: var(--ink-900);
}
.sn-amount--md.is-muted {
  color: var(--ink-500);
}
.sn-amount--sm.is-ok {
  color: var(--ok);
}
.sn-amount--sm.is-danger {
  color: var(--danger);
}
.sn-amount--sm.is-off {
  color: var(--ink-400);
}
</style>
