<script setup lang="ts">
import { computed, ref, watch } from 'vue';

/**
 * A-12 缩略图 Thumb（原子）
 * 三种状态都必须设计：加载中（骨架占位，尺寸与真实图完全一致）/ 成功 / 失败（line-100 底 + 「暂无图」）。
 * 加载失败不能留空白 —— 空白会让学生以为商品下架了。
 */
const props = withDefaults(
  defineProps<{
    src?: string;
    alt?: string;
    /** 设计系统固定四档，不做任意尺寸 */
    size?: 72 | 56 | 34 | 24;
  }>(),
  { src: '', alt: '', size: 72 },
);

const status = ref<'loading' | 'ok' | 'error'>(props.src ? 'loading' : 'error');

watch(
  () => props.src,
  (v) => {
    status.value = v ? 'loading' : 'error';
  },
);

const radius = computed(() => (props.size >= 56 ? 10 : 6));
const style = computed(() => `width:${props.size}px;height:${props.size}px;border-radius:${radius.value}px`);
</script>

<template>
  <view class="sn-thumb" :style="style">
    <view v-if="status === 'loading'" class="sn-thumb__skel" />
    <view v-else-if="status === 'error'" class="sn-thumb__empty">
      <view class="sn-thumb__icon" />
      <text v-if="size >= 56" class="sn-thumb__txt">暂无图</text>
    </view>
    <image
      v-else
      class="sn-thumb__img"
      :src="src"
      :alt="alt"
      mode="aspectFill"
      @error="status = 'error'"
    />
  </view>
</template>

<style>
.sn-thumb {
  position: relative;
  overflow: hidden;
  background: var(--line-100);
  flex: none;
}
.sn-thumb__img {
  width: 100%;
  height: 100%;
}
.sn-thumb__skel {
  width: 100%;
  height: 100%;
  background: linear-gradient(90deg, var(--line-100) 0%, var(--line-150) 50%, var(--line-100) 100%);
  background-size: 200% 100%;
  animation: sn-shimmer 1400ms linear infinite;
}
.sn-thumb__empty {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.sn-thumb__icon {
  width: 40%;
  height: 40%;
  border: 1.2px solid var(--ink-300);
  border-radius: 3px;
}
.sn-thumb__txt {
  margin-top: 2px;
  font-size: 10px;
  color: var(--ink-400);
}

@media (prefers-reduced-motion: reduce) {
  .sn-thumb__skel {
    animation: none;
    background: var(--line-100);
  }
}
</style>
