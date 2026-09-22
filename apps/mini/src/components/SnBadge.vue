<script setup lang="ts">
import { computed } from 'vue';

/**
 * A-08 计数徽标 Badge / 状态点 Dot（原子）
 * min-width 17、高 17、字号 10.5/600/mono，>99 显示 99+。
 * 数字必须等宽：9 → 10 撑宽会导致位置跳动（AC-07）。
 */
const props = withDefaults(
  defineProps<{
    /** 计数；不传则退化为状态点 */
    count?: number;
    /** 状态点语义色 */
    tone?: 'ok' | 'warn' | 'danger' | 'info' | 'off';
    /** 计数徽标的底色语义（默认 dan：需要人动手） */
    countTone?: 'danger' | 'warn' | 'ok' | 'brand';
    /** 文字标签（状态点旁，如「正常 / 预警」） */
    label?: string;
  }>(),
  { tone: 'ok', countTone: 'danger', label: '' },
);

const isDot = computed(() => typeof props.count !== 'number');
const text = computed(() => {
  const n = props.count ?? 0;
  return n > 99 ? '99+' : String(n);
});
</script>

<template>
  <view class="sn-badge-wrap">
    <view v-if="isDot" class="sn-dot" :class="`sn-dot--${tone}`" />
    <view v-else class="sn-badge" :class="`sn-badge--${countTone}`">
      <text class="num">{{ text }}</text>
    </view>
    <text v-if="label" class="sn-badge__label">{{ label }}</text>
  </view>
</template>

<style>
.sn-badge-wrap {
  display: inline-flex;
  align-items: center;
}

.sn-badge {
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  border-radius: var(--r-full);
  display: flex;
  align-items: center;
  justify-content: center;
}
.sn-badge text {
  color: var(--on-brand);
  font-size: 10.5px;
  font-weight: var(--fw-semibold);
  line-height: 17px;
}
.sn-badge--danger {
  background: var(--danger);
}
.sn-badge--warn {
  background: var(--warn);
}
.sn-badge--ok {
  background: var(--ok);
}
.sn-badge--brand {
  background: var(--brand-500);
}

/* 状态点：只用在「一行里同时有多个状态」的紧凑场景 */
.sn-dot {
  width: 7px;
  height: 7px;
  border-radius: var(--r-full);
  margin-right: var(--sp-1);
}
.sn-dot--ok {
  background: var(--ok);
}
.sn-dot--warn {
  background: var(--warn);
}
.sn-dot--danger {
  background: var(--danger);
}
.sn-dot--info {
  background: var(--info);
}
.sn-dot--off {
  background: var(--off);
}

.sn-badge__label {
  font-size: var(--fs-tag);
  color: var(--ink-500);
}
</style>
