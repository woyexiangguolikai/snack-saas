<script setup lang="ts">
import { computed } from 'vue';

/**
 * A-13 进度条 Progress（原子）
 * 高 5、圆角 3。颜色必须随语义变化 —— 固定品牌色会让「已透支」看起来像「进行中」。
 */
const props = withDefaults(
  defineProps<{
    value: number;
    max: number;
    /** 不传则按占比自动判定（超额 danger / ≥80% warn / 其余 brand） */
    tone?: 'brand' | 'ok' | 'warn' | 'danger';
    label?: string;
    /** 右侧数值文案；余额透支场景传负数说明（如「−¥8.40」） */
    trailing?: string;
    /** 超额时右侧文案用 danger */
    trailingTone?: 'ink' | 'danger';
  }>(),
  { tone: undefined, label: '', trailing: '', trailingTone: 'ink' },
);

const percent = computed(() => {
  if (!props.max) return 0;
  return Math.max(0, Math.min(100, Math.round((props.value / props.max) * 100)));
});

const autoTone = computed(() => {
  if (props.tone) return props.tone;
  if (props.value > props.max) return 'danger';
  if (percent.value >= 80) return 'warn';
  return 'brand';
});
</script>

<template>
  <view class="sn-progress">
    <view v-if="label || trailing" class="sn-progress__head">
      <text v-if="label" class="sn-progress__label">{{ label }}</text>
      <text v-if="trailing" class="sn-progress__trailing num" :class="`is-${trailingTone}`">
        {{ trailing }}
      </text>
    </view>
    <view class="sn-progress__track">
      <view class="sn-progress__bar" :class="`is-${autoTone}`" :style="`width:${percent}%`" />
    </view>
  </view>
</template>

<style>
.sn-progress {
  display: flex;
  flex-direction: column;
}
.sn-progress__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: var(--sp-1);
}
.sn-progress__label {
  font-size: var(--fs-sub);
  color: var(--ink-500);
}
.sn-progress__trailing {
  font-size: var(--fs-sub);
  color: var(--ink-900);
}
.sn-progress__trailing.is-danger {
  color: var(--danger);
}

.sn-progress__track {
  height: 5px;
  border-radius: 3px;
  background: var(--line-100);
  overflow: hidden;
}
.sn-progress__bar {
  height: 5px;
  border-radius: 3px;
  transition: width var(--d-fade) var(--e-out);
}
.sn-progress__bar.is-brand {
  background: var(--brand-500);
}
.sn-progress__bar.is-ok {
  background: var(--ok);
}
.sn-progress__bar.is-warn {
  background: var(--warn);
}
.sn-progress__bar.is-danger {
  background: var(--danger);
}
</style>
