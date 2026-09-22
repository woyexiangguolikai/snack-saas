<script setup lang="ts">
/**
 * P-05 返工队列。
 *
 * 一条贯穿全页的立场：**驳回是正常流程，不是异常**。
 * 微信审核驳回太常见了 —— 所以这一页用琥珀不用红，
 * 而且不叫"失败列表"（那会让人以为出事了），叫"返工"（要做的事）。
 *
 * 唯一的排序依据是**等待天数降序**：队列存在的意义就是让最久没人管的排在最上面。
 */
import { computed, ref } from 'vue';
import PageHeader from '@/components/PageHeader.vue';
import Panel from '@/components/Panel.vue';
import EmptyState from '@/components/EmptyState.vue';
import PageSkeleton from '@/components/PageSkeleton.vue';
import ErrorBanner from '@/components/ErrorBanner.vue';
import { papi } from '@/api/platform';
import { useLoad, messageOf } from '@/composables/useLoad';
import { toast } from '@/utils/feedback';
import { dt } from '@/utils/fmt';

const { data, loading, error, run } = useLoad(() => papi.rework());

const picked = ref<string[]>([]);
const items = computed(() => data.value?.items ?? []);

function toggle(key: string): void {
  const i = picked.value.indexOf(key);
  if (i >= 0) picked.value.splice(i, 1);
  else picked.value.push(key);
}

async function resubmitAll(): Promise<void> {
  const keys = [...picked.value];
  if (!keys.length) return;
  let ok = 0;
  for (const key of keys) {
    const [tenantCode, stageNo] = key.split('#');
    try {
      await papi.resubmitStage(tenantCode, Number(stageNo));
      ok += 1;
    } catch (e) {
      toast(`${tenantCode}：${messageOf(e)}`, 'danger');
    }
  }
  if (ok) toast(`已登记 ${ok} 家重提，返工闭环`, 'ok');
  picked.value = [];
  await run();
}

const OWNER: Record<string, string> = {
  renter: '商户',
  partner: '合伙人',
  platform: '我方',
  system: '系统',
};
</script>

<template>
  <div>
    <PageHeader title="返工队列" code="P-05" desc="驳回未重提的单 —— 按等待天数降序">
      <template #actions>
        <button class="btn" type="button" @click="run()">刷新</button>
      </template>
    </PageHeader>

    <ErrorBanner :text="error" @retry="run()" :kept="'已勾选的待重提单还在。'" />

    <div v-if="loading" class="pad"><PageSkeleton preset="table" /></div>

    <template v-else-if="data">
      <div class="p-note p-note--warn lead">
        驳回不等于出问题 —— 备案主体不一致、类目资质不全、商户号资料有误会经常发生。
        这一页只回答一个问题：这一单驳回了，<b>催了没有、卡了多久</b>。
      </div>

      <div v-if="data.byStage.length" class="p-cards gap">
        <div v-for="s in data.byStage" :key="s.stageNo" class="p-card">
          <p class="p-card__k">第 {{ s.stageNo }} 阶段 · {{ s.stageName.split('（')[0] }}</p>
          <p class="p-card__v">{{ s.count }}</p>
          <p class="p-card__d">家待返工</p>
        </div>
      </div>

      <div v-if="picked.length" class="bar">
        <span>已选 {{ picked.length }} 家</span>
        <div class="spacer" />
        <button class="btn btn--sm pbtn--primary" type="button" @click="resubmitAll()">
          批量登记重提
        </button>
        <button class="btn btn--sm" type="button" @click="picked = []">取消</button>
      </div>

      <Panel title="待返工单" :desc="`共 ${items.length} 家`" flush class="gap">
        <EmptyState
          v-if="!items.length"
          text="返工队列是空的"
          hint="当前没有驳回未重提的单 —— 这是好事，不用做什么"
        />
        <div v-else class="tbl-wrap">
          <table class="tbl">
            <thead>
              <tr>
                <th style="width: 36px" />
                <th class="num">等待</th>
                <th>租户</th>
                <th>阶段</th>
                <th>责任方</th>
                <th>驳回原因</th>
                <th>驳回时间</th>
                <th>重提时间</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="it in items" :key="`${it.tenantCode}#${it.stageNo}`">
                <td>
                  <input
                    type="checkbox"
                    :checked="picked.includes(`${it.tenantCode}#${it.stageNo}`)"
                    @change="toggle(`${it.tenantCode}#${it.stageNo}`)"
                  />
                </td>
                <td class="num">
                  <b :class="{ urgent: it.waitingDays >= 7 }">{{ it.waitingDays }} 天</b>
                </td>
                <td>
                  <RouterLink :to="{ name: 'P-02', params: { tenantCode: it.tenantCode } }">
                    {{ it.shopName }}
                  </RouterLink>
                  <span class="num sub muted block">{{ it.tenantCode }}</span>
                </td>
                <td>
                  {{ it.stageNo }}. {{ it.stageName.split('（')[0] }}
                </td>
                <td>{{ OWNER[it.owner] ?? it.owner }}</td>
                <td class="reason">{{ it.rejectReason ?? '未填写' }}</td>
                <td class="sub">{{ dt(it.rejectedAt) }}</td>
                <td class="sub">{{ it.resubmittedAt ? dt(it.resubmittedAt) : '还没重提' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Panel>
    </template>
  </div>
</template>

<style scoped>
.lead {
  margin-bottom: var(--sp-3);
}
.gap {
  margin-top: var(--sp-4);
}
.pad {
  padding: var(--sp-6);
  color: var(--ink-500);
}
.bar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-top: var(--sp-4);
  padding: var(--sp-2) var(--sp-4);
  border: var(--bd);
  border-radius: var(--r-md);
  background: var(--surface);
  font-size: var(--fs-sub);
}
.reason {
  max-width: 320px;
  line-height: 1.5;
}
.urgent {
  color: var(--danger);
}
.block {
  display: block;
}
</style>
