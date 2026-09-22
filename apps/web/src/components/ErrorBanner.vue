<script setup lang="ts">
/**
 * 取数失败时的顶部横幅 —— 全后台唯一的"错误网络态"形态（§5.1 ①）。
 *
 * 设计文档要求这类提示必须同时说出**三件事**，缺一条就还得找客服：
 *   ① 哪部分失败（"商品"而不是"页面"）—— 由 `text` 承担；
 *   ② 可能的客观原因（网络）—— 由 `text` 承担；
 *   ③ **哪些状态被保留了** —— 由 `kept` 承担。
 *
 * 第 ③ 条最容易被漏，也最要紧：用户最怕的不是失败，而是"重来一次要重新选楼栋"。
 * 把"你选好的「1 号宿舍楼」已经记住了"写在横幅里，
 * 这句话的作用不是安慰 —— 它直接决定用户是留下来重试，还是关掉页面。
 *
 * 另外两条纪律：
 *   · **不清空页面**：横幅挂在内容上方，已拿到的数据继续留在页面上（AC-20）。
 *     多数失败只是"这一次刷新"失败，上一次的数据仍然是当时正确的事实。
 *   · **必须带下一步**：只报错不给动作，用户唯一的出路是刷新浏览器。
 *
 * `text` 为空时不渲染任何东西 —— 调用方不用自己写 v-if。
 */
defineProps<{
  /** 失败话术：哪件事 + 可能原因（已由 useLoad 收敛为"原因 + 下一步"） */
  text: string;
  /** 被保留的状态（第 ③ 条）。不填则整行不出现 —— 不编一句"数据已保留"充数 */
  kept?: string;
  /** 重试按钮文案 */
  retryLabel?: string;
}>();

const emit = defineEmits<{ retry: [] }>();
</script>

<template>
  <div v-if="text" class="banner banner--danger" role="alert">
    <div class="eb__body">
      <span class="eb__text">{{ text }}</span>
      <span v-if="kept" class="eb__kept">{{ kept }}</span>
    </div>
    <button class="btn btn--sm" type="button" @click="emit('retry')">
      {{ retryLabel ?? '重新加载' }}
    </button>
  </div>
</template>

<style scoped>
/* 文案可换行、按钮不被压缩 —— 长话术在窄屏上是常态，不是异常 */
.eb__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.eb__text {
  font-size: var(--fs-body);
  line-height: var(--lh-body);
}
/* 「保留了哪些状态」用略弱一档的字重：它是补充事实，不是第二句错误 */
.eb__kept {
  font-size: var(--fs-sub);
  line-height: var(--lh-sub);
  opacity: 0.85;
}
</style>
