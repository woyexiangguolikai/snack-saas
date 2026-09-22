<script setup lang="ts">
/**
 * P-04 上线流水线看板 —— 平台后台**最重要的看板**。
 *
 * 它要回答的三个问题（§5 的三大非代码瓶颈）：
 *   ① 这家卡在哪一步？
 *   ② 卡了几天？（服务端按**工作日**算，不能按自然日 —— 见 pipeline.service）
 *   ③ 催过没有？（推动权在商户手上，催办是平台唯一能做的事）
 *
 * 责任方一栏不是装饰：备案例 1–20 个工作日，是商户的事，
 * 看板上标成"我方"就会有人去催错的人 —— 然后真正该推的那一步永远没人推。
 */
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import PageHeader from '@/components/PageHeader.vue';
import Panel from '@/components/Panel.vue';
import EmptyState from '@/components/EmptyState.vue';
import PageSkeleton from '@/components/PageSkeleton.vue';
import ErrorBanner from '@/components/ErrorBanner.vue';
import ToneTag from '@/components/ToneTag.vue';
import PipelineSteps from '@/platform/PipelineSteps.vue';
import { papi } from '@/api/platform';
import { useLoad, messageOf } from '@/composables/useLoad';
import { toast } from '@/utils/feedback';
import { dt, stuckText } from '@/utils/fmt';

const router = useRouter();
const { data, loading, error, run } = useLoad(() => papi.pipelineBoard());

const picked = ref<string>('');
const view = computed(() => {
  const items = data.value?.items ?? [];
  if (!items.length) return null;
  return items.find((i) => i.tenantCode === picked.value) ?? items[0];
});

const running = computed(() => (data.value?.items ?? []).filter((i) => i.status !== 'active'));

const OWNER: Record<string, string> = {
  renter: '商户',
  partner: '合伙人',
  platform: '我方',
  system: '系统',
};

async function act(kind: 'complete' | 'touch' | 'reject'): Promise<void> {
  const v = view.value;
  if (!v) return;
  try {
    if (kind === 'complete') {
      await papi.completeStage(v.tenantCode, v.currentStageNo);
      toast(`第 ${v.currentStageNo} 阶段已完成，下一阶段已自动置为进行中`, 'ok');
    } else if (kind === 'touch') {
      const note = window.prompt('记录这次触达的内容（可留空）：')?.trim() ?? '';
      await papi.touchStage(v.tenantCode, v.currentStageNo, note);
      toast('已记录触达时间', 'ok');
    } else {
      const reason = window.prompt('驳回原因（返工的人只能看到这句话，必填）：')?.trim() ?? '';
      if (!reason) return;
      await papi.rejectStage(v.tenantCode, v.currentStageNo, reason);
      toast('已驳回，该租户进入返工队列', 'warn');
    }
    await run();
  } catch (e) {
    toast(messageOf(e), 'danger');
  }
}
</script>

<template>
  <div>
    <PageHeader title="上线流水线" code="P-04" desc="12 阶段 · 卡点天数 · 上次触达">
      <template #actions>
        <button class="btn" type="button" @click="run()">刷新</button>
        <button class="btn" type="button" @click="router.push({ name: 'P-05' })">返工队列</button>
      </template>
    </PageHeader>

    <ErrorBanner :text="error" @retry="run()" :kept="'当前选中的租户还在。'" />

    <div v-if="loading" class="pad"><PageSkeleton preset="table" /></div>

    <template v-else-if="data">
      <div class="p-cards">
        <div class="p-card">
          <p class="p-card__k">租户总数</p>
          <p class="p-card__v">{{ data.summary.total }}</p>
        </div>
        <div class="p-card">
          <p class="p-card__k">上线中</p>
          <p class="p-card__v">{{ data.summary.total - data.summary.activated }}</p>
          <p class="p-card__d">已营业 {{ data.summary.activated }} 家</p>
        </div>
        <div class="p-card">
          <p class="p-card__k">超期卡点</p>
          <p class="p-card__v">{{ data.summary.overdue }}</p>
          <p class="p-card__d">按工作日起算，不含周末</p>
        </div>
        <div class="p-card">
          <p class="p-card__k">待返工</p>
          <p class="p-card__v">{{ data.summary.rework }}</p>
          <p class="p-card__d">驳回未重提</p>
        </div>
        <div class="p-card">
          <p class="p-card__k">平均卡点</p>
          <p class="p-card__v">{{ data.summary.avgStuckDays }}</p>
          <p class="p-card__d">个工作日</p>
        </div>
      </div>

      <Panel title="卡点汇总" desc="按卡点天数降序 —— 这一列就是每天的待办" flush class="gap">
        <EmptyState
          v-if="!running.length"
          text="没有上线中的租户"
          hint="所有租户都已走到第 12 阶段并营业"
        />
        <div v-else class="tbl-wrap">
          <table class="tbl">
            <thead>
              <tr>
                <th>租户</th>
                <th>当前阶段</th>
                <th>责任方</th>
                <th class="num">卡点</th>
                <th>上次触达</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="t in running"
                :key="t.tenantCode"
                class="rowlink"
                @click="picked = t.tenantCode"
              >
                <td>
                  <span class="num">{{ t.tenantCode }}</span>
                  <span class="sub muted block">{{ t.shopName }}</span>
                </td>
                <td>
                  <span>{{ t.currentStageNo }}. {{ t.currentStageName.split('（')[0] }}</span>
                  <span v-if="t.external" class="sub muted block">不可控（外部环节）</span>
                </td>
                <td>{{ OWNER[t.currentOwner] ?? t.currentOwner }}</td>
                <td class="num">
                  {{ stuckText(t.stuckDays) }}
                  <ToneTag v-if="t.overdue" tone="warn" text="超期" />
                </td>
                <td>{{ t.lastContactedAt ? dt(t.lastContactedAt) : '还没催过' }}</td>
                <td>
                  <ToneTag v-if="t.hasRejected" tone="warn" text="已驳回" />
                  <ToneTag v-else tone="info" :text="'进行中'" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel v-if="view" :title="`阶段推进 · ${view.shopName}`" class="gap">
        <template #actions>
          <button class="btn btn--sm" type="button" @click="act('touch')">记录触达</button>
          <button class="btn btn--sm btn--danger" type="button" @click="act('reject')">驳回</button>
          <button class="btn btn--sm pbtn--primary" type="button" @click="act('complete')">
            完成第 {{ view.currentStageNo }} 阶段
          </button>
        </template>

        <p class="sub muted pick">
          当前推进：<span class="num">{{ view.tenantCode }}</span>
          <button
            v-for="t in running"
            :key="t.tenantCode"
            class="p-chip"
            :class="{ 'p-chip--on': t.tenantCode === view.tenantCode }"
            type="button"
            @click="picked = t.tenantCode"
          >
            {{ t.shopName }}
          </button>
        </p>

        <PipelineSteps :stages="view.stages" show-stuck />

        <div class="note">
          <p v-if="view.external" class="p-note p-note--info">
            第 {{ view.currentStageNo }} 阶段是不可控的外部环节（责任方：{{ OWNER[view.currentOwner] }}）。
            平台侧能做的是「记录触达并催办」，不是"推进它" —— 把它标成我方超期会让人去催错的人。
          </p>
          <p v-else-if="view.overdue" class="p-note p-note--warn">
            已超出期望耗时。超期不是错误，但「没人知道它超期了」才是问题 —— 记一次触达，让下一个人接手时看得到。
          </p>
        </div>
      </Panel>
    </template>
  </div>
</template>

<style scoped>
.gap {
  margin-top: var(--sp-4);
}
.pad {
  padding: var(--sp-6);
  color: var(--ink-500);
}
.rowlink {
  cursor: pointer;
}
.pick {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-2);
  margin: 0 0 var(--sp-3);
}
.note {
  margin-top: var(--sp-3);
}
.block {
  display: block;
}
</style>
