<script setup lang="ts">
/**
 * 12 阶段横向步骤条（B-15）。
 *
 * 一条纪律：**驳回用琥珀不用红**（§5 状态宪法）。
 * 审核驳回太常见了，用红色会让整个看板一直处于"报警"状态 ——
 * 一个永远在报警的看板，第一次看会紧张，第三次看就没人看了。
 */
import type { PipelineStageView } from '@/api/platform-types';

const props = defineProps<{
  stages: PipelineStageView[];
  /** 是否显示卡点天数（详情页显示，总览页不显示 —— 总览要的是"谁卡住了"） */
  showStuck?: boolean;
}>();

function cls(s: PipelineStageView): string {
  const out: string[] = ['p-step'];
  if (s.overdue && s.status !== 'done') out.push('p-step--overdue');
  else if (s.status === 'done') out.push('p-step--done');
  else if (s.status === 'doing') out.push('p-step--doing');
  else if (s.status === 'rejected') out.push('p-step--rejected');
  return out.join(' ');
}

const OWNER: Record<string, string> = {
  renter: '商户',
  partner: '合伙人',
  platform: '我方',
  system: '系统',
};

function title(s: PipelineStageView): string {
  const parts = [`第 ${s.stageNo} 阶段：${s.stageName}`, `责任方：${OWNER[s.owner] ?? s.owner}`];
  if (s.status === 'rejected' && s.rejectReason) parts.push(`驳回原因：${s.rejectReason}`);
  if (s.status !== 'done') parts.push(`期望 ${s.slaDays} 个工作日`);
  if (s.external) parts.push('不可控（外部环节）');
  if (props.showStuck) parts.push(`已卡 ${s.stuckDays} 个工作日`);
  return parts.join('\n');
}
</script>

<template>
  <div class="p-steps">
    <div v-for="s in stages" :key="s.stageNo" :class="cls(s)" :title="title(s)">
      <span class="p-step__no">{{ String(s.stageNo).padStart(2, '0') }}</span>
      <span class="p-step__name">{{ s.stageName.split('（')[0] }}</span>
      <span v-if="s.status === 'rejected'" class="p-step__mark">已驳回</span>
      <span v-else-if="showStuck && s.status !== 'done' && s.stuckDays > 0" class="p-step__mark">
        卡 {{ s.stuckDays }} 天
      </span>
    </div>
  </div>
</template>

<style scoped>
.p-step__name {
  display: block;
  margin-top: 2px;
  line-height: 1.4;
}
.p-step__mark {
  display: block;
  margin-top: 2px;
  font-size: var(--fs-tag);
  color: var(--ink-500);
}
</style>
