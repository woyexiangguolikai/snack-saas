<script setup lang="ts">
/**
 * A-13 骨架块 Skeleton（原子 · 加载体系的基元）
 * 形状与尺寸必须与真实内容一致，否则加载完成瞬间会明显跳动（AC-06）。
 * 高度与字号档一一对应：标题 18 / 正文 14 / 辅助 11。
 */
const props = withDefaults(
  defineProps<{
    variant?: 'title' | 'text' | 'sub' | 'thumb' | 'amount';
    /** 文本行宽度，如 '60%' */
    width?: string;
    /** thumb 尺寸；与真实缩略图一致 */
    size?: 72 | 56 | 34 | 24;
    /** 循环条数（文本段落） */
    rows?: number;
  }>(),
  { variant: 'text', width: '100%', size: 72, rows: 1 },
);

const height = () => {
  switch (props.variant) {
    case 'title':
      return '18px';
    case 'sub':
      return '11px';
    case 'amount':
      return '22px';
    case 'thumb':
      return `${props.size}px`;
    default:
      return '14px';
  }
};
const radius = () => (props.variant === 'thumb' ? (props.size >= 56 ? '10px' : '6px') : '6px');
</script>

<template>
  <view class="sn-skel-group">
    <view
      v-for="i in Math.max(1, variant === 'thumb' ? 1 : rows)"
      :key="i"
      class="sn-skel"
      :style="`height:${height()};width:${variant === 'thumb' ? size + 'px' : width};border-radius:${radius()}`"
    />
  </view>
</template>

<style>
.sn-skel-group {
  display: flex;
  flex-direction: column;
}
.sn-skel {
  background: linear-gradient(90deg, var(--line-100) 0%, var(--line-150) 50%, var(--line-100) 100%);
  background-size: 200% 100%;
  animation: sn-shimmer 1400ms linear infinite;
}
.sn-skel + .sn-skel {
  margin-top: var(--sp-2);
}

/* 扫光对前庭敏感用户不友好 —— 减弱动效时改为静态 */
@media (prefers-reduced-motion: reduce) {
  .sn-skel {
    animation: none;
    background: var(--line-100);
  }
}
</style>
