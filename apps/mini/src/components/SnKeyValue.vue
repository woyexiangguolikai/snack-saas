<script setup lang="ts">
import SnAmount from './SnAmount.vue';
import SnTag from './SnTag.vue';

/**
 * A-10 键值行 KeyValue（原子）
 * 「键在左、值在右」——行高 padding 13/最小高 48，键 13.5/400/ink-500（键永不加重）。
 *
 * 空值渲染是这个组件存在的另一半理由：绝不允许留空或显示 null / -。
 * 三种空值语义（由 emptyReason 传文案）：
 *   可选未填 → 「未填写（按房间号排序）」
 *   不适用   → 「未留（送到房间）」
 *   确实没有 → 「无」
 */
const props = withDefaults(
  defineProps<{
    label: string;
    value?: string;
    /** 值的渲染方式：mono 用于金额/库存/房号/单号（AC-07 等宽） */
    valueType?: 'text' | 'mono' | 'building';
    /** 金额：传分，走 A-09 中档排版 */
    fen?: number;
    fenMuted?: boolean;
    /** 空值说明（必填语义：不留白、不显示 null） */
    emptyReason?: string;
    /** 可点击行右侧才加 chevron；不加 chevron 的行不得响应点击 */
    clickable?: boolean;
    /** 最后一行不画分隔线 */
    last?: boolean;
  }>(),
  {
    value: '',
    valueType: 'text',
    fen: undefined,
    fenMuted: false,
    emptyReason: '无',
    clickable: false,
    last: false,
  },
);

const emit = defineEmits<{ (e: 'click'): void }>();

function onClick() {
  if (!props.clickable) return;
  emit('click');
}
</script>

<template>
  <view class="sn-kv" :class="{ 'is-last': last, 'is-clickable': clickable }" @click="onClick">
    <text class="sn-kv__key">{{ label }}</text>
    <view class="sn-kv__val">
      <SnAmount v-if="typeof fen === 'number'" :fen="fen" size="md" :muted="fenMuted" />
      <SnTag v-else-if="valueType === 'building' && value" tone="brand" :label="value" />
      <text v-else-if="value" class="sn-kv__text" :class="`is-${valueType}`">{{ value }}</text>
      <text v-else class="sn-kv__empty">{{ emptyReason }}</text>
      <view v-if="clickable" class="sn-kv__chevron"><text>›</text></view>
    </view>
  </view>
</template>

<style>
.sn-kv {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 48px;
  padding: 13px 0;
  border-bottom: var(--bw) solid var(--line-100);
}
.sn-kv.is-last {
  border-bottom: none;
}
.sn-kv__key {
  flex: none;
  max-width: 40%;
  font-size: 13.5px;
  color: var(--ink-500);
}
.sn-kv__val {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: flex-end;
}
.sn-kv__text {
  font-size: var(--fs-body);
  font-weight: var(--fw-medium);
  color: var(--ink-900);
  text-align: right;
}
.sn-kv__text.is-mono {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}
.sn-kv__empty {
  font-size: var(--fs-body);
  color: var(--ink-400);
  text-align: right;
}
.sn-kv__chevron {
  margin-left: var(--sp-1);
  color: var(--ink-300);
  font-size: 15px;
  line-height: 15px;
}
</style>
