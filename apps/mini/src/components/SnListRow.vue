<script setup lang="ts">
/**
 * A-10 列表行 ListRow（原子）
 * 通用行骨架：左（缩略图/标题/副标题）+ 右（值/动作）。移动端与网页端共用。
 * 可点击才加 chevron —— 不带 chevron 的行不响应点击（避免用户误以为能点）。
 */
const props = withDefaults(
  defineProps<{
    clickable?: boolean;
    last?: boolean;
    /** 关掉左侧内边距（用于表格式紧凑行） */
    flush?: boolean;
  }>(),
  { clickable: false, last: false, flush: false },
);

const emit = defineEmits<{ (e: 'click'): void }>();

function onClick() {
  if (!props.clickable) return;
  emit('click');
}
</script>

<template>
  <view
    class="sn-row"
    :class="{ 'is-clickable': clickable, 'is-last': last, 'is-flush': flush }"
    @click="onClick"
  >
    <view v-if="$slots.lead" class="sn-row__lead"><slot name="lead" /></view>
    <view class="sn-row__main">
      <slot />
    </view>
    <view class="sn-row__tail">
      <slot name="tail" />
      <view v-if="clickable" class="sn-row__chevron"><text>›</text></view>
    </view>
  </view>
</template>

<style>
.sn-row {
  display: flex;
  align-items: center;
  min-height: 48px;
  padding: 10px 0;
  border-bottom: var(--bw) solid var(--line-100);
}
.sn-row.is-last {
  border-bottom: none;
}
.sn-row.is-flush {
  padding-left: 0;
}
.sn-row__lead {
  flex: none;
  margin-right: var(--sp-3);
  display: flex;
  align-items: center;
}
.sn-row__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.sn-row__tail {
  flex: none;
  display: flex;
  align-items: center;
  margin-left: var(--sp-2);
}
.sn-row__chevron {
  margin-left: var(--sp-1);
  color: var(--ink-300);
  font-size: 15px;
  line-height: 15px;
}
</style>
