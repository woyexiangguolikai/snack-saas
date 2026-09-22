<script setup lang="ts">
/**
 * A-12 头像 / 品牌标识 Avatar（原子）
 * 商户未上传 Logo 时用店铺名首字 + brand-100 底 —— 不用默认占位图。
 */
const props = withDefaults(
  defineProps<{
    /** 取首字显示 */
    name?: string;
    src?: string;
    size?: number;
    /** square 用于店铺 Logo（圆角 10），circle 用于用户头像 */
    shape?: 'square' | 'circle';
  }>(),
  { name: '', src: '', size: 30, shape: 'square' },
);

const initial = props.name ? props.name.trim().slice(0, 1) : '店';
</script>

<template>
  <view
    class="sn-avatar"
    :class="`sn-avatar--${shape}`"
    :style="`width:${size}px;height:${size}px;border-radius:${shape === 'circle' ? '999px' : '10px'}`"
  >
    <image v-if="src" class="sn-avatar__img" :src="src" mode="aspectFill" />
    <text v-else class="sn-avatar__text" :style="`font-size:${Math.round(size * 0.44)}px`">
      {{ initial }}
    </text>
  </view>
</template>

<style>
.sn-avatar {
  flex: none;
  overflow: hidden;
  background: var(--brand-100);
  display: flex;
  align-items: center;
  justify-content: center;
}
.sn-avatar__img {
  width: 100%;
  height: 100%;
}
.sn-avatar__text {
  color: var(--brand-700);
  font-weight: var(--fw-semibold);
  line-height: 1;
}
</style>
