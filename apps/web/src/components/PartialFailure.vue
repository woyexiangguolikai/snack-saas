<script setup lang="ts">
/**
 * 局部失败提示 —— 设计文档把它标为"最重要的一个"（§5.1 ②）。
 *
 * 规则只有一句：**部分接口失败时，不能把整页判为失败。**
 * 已经拿到的内容继续可用，失败的区块单独提示、单独重试。
 *
 * 为什么这条最重要：
 *   一个学生端页面往往并发两三个请求（商品列表 + 分类 + 楼栋时间窗）。
 *   其中一个挂了，整页换成错误页是"实现上最省事"的做法，
 *   但它把用户已经拿到的、完全可用的数据一起作废了 ——
 *   而用户看到的是一句"加载失败"，于是他离开。
 *
 * 所以这个组件有**两个必填**：
 *   · `title`  说清是哪一块没出来（"这些商品"而不是"页面"）；
 *   · `safe`   说清**已经显示的那部分仍然可以照常使用**。
 *     `safe` 故意做成必填：这句话不是客套，它决定用户留不留下。
 *     写不出来就说明这块其实不该局部化，那就不要用这个组件。
 *
 * 与 `<ErrorBanner>` 的分工：
 *   ErrorBanner  = 页顶、整页取数失败、带重试；
 *   PartialFailure = 区块内、部分取数失败、只重试这一块，其余内容不动。
 */
withDefaults(
  defineProps<{
    /** 哪一块没出来，如"这些商品" */
    title: string;
    /** **已经显示的内容可以怎么用** —— 必须写具体动作，不写"请稍后再试" */
    safe: string;
    /** 缺失的数量，如 6（给了才会出现"缺失的 6 个…可以单独重试"） */
    missing?: number;
    /** 缺失项的量词，默认"个" */
    unit?: string;
    /** 重试按钮文案 */
    retryLabel?: string;
  }>(),
  { unit: '个', retryLabel: '只重试这部分' },
);

const emit = defineEmits<{ retry: [] }>();
</script>

<template>
  <div class="pf" role="alert">
    <div class="pf__body">
      <span class="pf__title">{{ title }}</span>
      <span class="pf__safe">{{ safe }}</span>
      <span v-if="missing !== undefined" class="pf__detail">
        缺失的 {{ missing }} {{ unit }}可以单独重试，不影响已经显示的部分。
      </span>
    </div>
    <button class="btn btn--sm" type="button" @click="emit('retry')">{{ retryLabel }}</button>
  </div>
</template>

<style scoped>
/* 用琥珀不用红：这是"一块没拿到"，不是"系统坏了"。
   红色会让人把整页都当成不可信 —— 而它恰恰想说的相反。 */
.pf {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--r-md);
  background: var(--warn-bg);
  color: var(--warn);
  margin-bottom: var(--sp-3);
}
.pf__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pf__title {
  font-size: var(--fs-body);
  line-height: var(--lh-body);
}
.pf__safe {
  font-size: var(--fs-sub);
  line-height: var(--lh-sub);
}
.pf__detail {
  font-size: var(--fs-sub);
  line-height: var(--lh-sub);
  opacity: 0.85;
}
</style>
