<script setup lang="ts">
/**
 * A-08 标签 Tag（原子）
 * 状态的最小表达单元。每种颜色只对应一种业务含义，与语义色表严格一致。
 * AC-04：所有语义色「永不换肤」—— 切租户主题色时这里一个像素都不许变。
 * 唯一的非状态用法是 brand（身份标识：楼栋名、当前租户名）。
 */
const props = withDefaults(
  defineProps<{
    tone: 'ok' | 'warn' | 'danger' | 'info' | 'off' | 'brand';
    /** solid：浅底实心（默认）；outline：描边（浅底不成立的场合，如白底上的营业中） */
    variant?: 'solid' | 'outline';
    label: string;
  }>(),
  { variant: 'solid' },
);

const TONE_CLASS: Record<string, string> = {
  ok: 'ok',
  warn: 'warn',
  danger: 'danger',
  info: 'info',
  off: 'off',
  brand: 'brand',
};
const cls = TONE_CLASS[props.tone];
</script>

<template>
  <view class="sn-tag" :class="[`sn-tag--${tone}`, `sn-tag--${variant}`]">
    <text class="sn-tag__text">{{ label }}</text>
  </view>
</template>

<style>
.sn-tag {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 2px 8px;
  border-radius: 5px;
  align-self: flex-start;
}
.sn-tag__text {
  font-size: var(--fs-tag);
  font-weight: var(--fw-semibold);
  line-height: var(--lh-tag);
}

.sn-tag--solid.sn-tag--ok {
  background: var(--ok-bg);
}
.sn-tag--solid.sn-tag--ok .sn-tag__text {
  color: var(--ok);
}
.sn-tag--solid.sn-tag--warn {
  background: var(--warn-bg);
}
.sn-tag--solid.sn-tag--warn .sn-tag__text {
  color: var(--warn);
}
.sn-tag--solid.sn-tag--danger {
  background: var(--danger-bg);
}
.sn-tag--solid.sn-tag--danger .sn-tag__text {
  color: var(--danger);
}
.sn-tag--solid.sn-tag--info {
  background: var(--info-bg);
}
.sn-tag--solid.sn-tag--info .sn-tag__text {
  color: var(--info);
}
.sn-tag--solid.sn-tag--off {
  background: var(--off-bg);
}
.sn-tag--solid.sn-tag--off .sn-tag__text {
  color: var(--off);
}
.sn-tag--solid.sn-tag--brand {
  background: var(--brand-500);
}
.sn-tag--solid.sn-tag--brand .sn-tag__text {
  color: var(--on-brand);
}

/* 描边：用于浅底不成立的场合 */
.sn-tag--outline {
  background: var(--surface);
}
.sn-tag--outline.sn-tag--ok {
  border: var(--bw) solid var(--ok);
}
.sn-tag--outline.sn-tag--ok .sn-tag__text {
  color: var(--ok);
}
.sn-tag--outline.sn-tag--warn {
  border: var(--bw) solid var(--warn);
}
.sn-tag--outline.sn-tag--warn .sn-tag__text {
  color: var(--warn);
}
.sn-tag--outline.sn-tag--danger {
  border: var(--bw) solid var(--danger);
}
.sn-tag--outline.sn-tag--danger .sn-tag__text {
  color: var(--danger);
}
.sn-tag--outline.sn-tag--info {
  border: var(--bw) solid var(--info);
}
.sn-tag--outline.sn-tag--info .sn-tag__text {
  color: var(--info);
}
.sn-tag--outline.sn-tag--off {
  border: var(--bw) solid var(--ink-300);
}
.sn-tag--outline.sn-tag--off .sn-tag__text {
  color: var(--off);
}
.sn-tag--outline.sn-tag--brand {
  border: var(--bw) solid var(--brand-500);
}
.sn-tag--outline.sn-tag--brand .sn-tag__text {
  color: var(--brand-700);
}
</style>
