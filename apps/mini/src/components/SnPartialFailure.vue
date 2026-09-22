<script setup lang="ts">
/**
 * 局部失败提示 —— 设计文档把它标为"最重要的一个"（§5.1 ②）。
 *
 * 规则只有一句：**部分接口失败时，不能把整页判为失败。**
 * 已经拿到的内容继续可用，失败的区块单独提示、单独重试。
 *
 * 为什么这条最重要：
 *   学生端一个页面往往并发两三个请求（商品列表 + 分类 + 楼栋）。其中一个挂了，
 *   整页换成错误页是"实现上最省事"的做法，但它把用户已经拿到的、完全可用的
 *   数据一起作废了 —— 而用户看到的是一句"加载失败"，于是他离开。
 *
 * 所以这个组件有**两个必填**：
 *   · `title` 说清是哪一块没出来（"分类"而不是"页面"）；
 *   · `safe`  说清**已经显示的那部分仍然可以照常使用**。
 *     `safe` 故意做成必填：它不是客套，它决定用户留不留下。
 *     写不出来就说明这块不该局部化，那就不要用这个组件。
 *
 * 与整页错误态（SnStateBlock tone=danger）的分工：
 *   整页错误 = 主数据没拿到，页面确实没东西可看；
 *   局部失败 = 次要数据没拿到，页面**能用**，只是少了一块。
 */
withDefaults(
  defineProps<{
    /** 哪一块没出来，如"分类" */
    title: string;
    /** **已经显示的内容可以怎么用** —— 必须写具体动作，不写"请稍后再试" */
    safe: string;
    /** 重试按钮文案 */
    retryLabel?: string;
  }>(),
  { retryLabel: '只重试这部分' },
);

const emit = defineEmits<{ (e: 'retry'): void }>();
</script>

<template>
  <view class="pf">
    <view class="pf__body">
      <text class="pf__title">{{ title }}</text>
      <text class="pf__safe">{{ safe }}</text>
    </view>
    <view class="pf__btn" @click="emit('retry')">
      <text class="pf__btntext">{{ retryLabel }}</text>
    </view>
  </view>
</template>

<style>
/* 用琥珀不用红：这是"一块没拿到"，不是"系统坏了"。
   红色会让人把整页都当成不可信 —— 而它恰恰想说的相反。 */
.pf {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: var(--sp-3);
  margin: var(--sp-2) var(--page-x);
  padding: var(--sp-3);
  border-radius: var(--r-md);
  background: var(--warn-bg);
}
.pf__body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pf__title {
  font-size: var(--fs-body);
  line-height: var(--lh-body);
  color: var(--warn);
}
.pf__safe {
  font-size: var(--fs-sub);
  line-height: var(--lh-sub);
  color: var(--warn);
  opacity: 0.85;
}
.pf__btn {
  flex: none;
  padding: var(--sp-1) var(--sp-3);
  border-radius: var(--r-sm);
  background: var(--paper);
}
.pf__btntext {
  font-size: var(--fs-tag);
  line-height: var(--lh-tag);
  color: var(--warn);
}
</style>
