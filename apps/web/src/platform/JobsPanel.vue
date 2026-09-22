<script setup lang="ts">
/**
 * P-08b 扣费与巡检任务看板。
 *
 * 这一屏要回答一个问题，而且只回答这一个：
 *   **"定时任务到底有没有在跑？"**
 *
 * 为什么不能只看"手动跑一次全绿"：
 *   手工触发走的是同一条 `run()`，所以它绿**不能**说明调度器活着 ——
 *   进程启动后 `tick` 抛错、`JOBS_ENABLED=false`、时区算错导致当天没到点，
 *   这三种情况下手动跑都是绿的，而线上一次都没扣过钱。
 *   所以调度状态（ticking / 上次扣减日 / 上次巡检时刻）必须与运行记录分列，
 *   并且用**不同的措辞**：调度器没在跑时，页面上第一眼看到的必须是这件事。
 *
 * 任务清单来自服务端（`/ledger/jobs/kinds`），不写死在页面里 ——
 * 写死的话服务端多一个任务，前端就少一个按钮，而这种缺失不会报错。
 */
import { computed, ref } from 'vue';
import Panel from '@/components/Panel.vue';
import ToneTag from '@/components/ToneTag.vue';
import PageSkeleton from '@/components/PageSkeleton.vue';
import ErrorBanner from '@/components/ErrorBanner.vue';
import EmptyState from '@/components/EmptyState.vue';
import { papi } from '@/api/platform';
import { useLoad, messageOf } from '@/composables/useLoad';
import { toast } from '@/utils/feedback';
import { dt } from '@/utils/fmt';

const board = useLoad(() => papi.ledgerJobStatus(20));
const kinds = useLoad(() => papi.ledgerJobKinds());

const running = ref('');

const runs = computed(() => board.data.value?.runs ?? []);
const state = computed(() => board.data.value?.scheduleState);
/** 调度器没在跑 —— 这是这一页最高优先级的事实，必须先说 */
const stalled = computed(() => board.data.value !== null && !board.data.value.scheduleState.ticking);

async function runOne(kind: string): Promise<void> {
  running.value = kind;
  try {
    await papi.runLedgerJob(kind);
    toast('已跑一次。注意：手工跑绿不等于定时任务正常，请看上方的调度状态。', 'ok');
    await board.run();
  } catch (e) {
    toast(messageOf(e), 'danger');
  } finally {
    running.value = '';
  }
}
</script>

<template>
  <Panel title="扣费与巡检任务" desc="调度状态与运行记录分列 —— 手工跑绿不等于定时任务正常" class="gap">
    <template #actions>
      <button class="btn btn--sm" type="button" :disabled="board.loading.value" @click="board.run()">
        刷新
      </button>
    </template>

    <ErrorBanner
      :text="board.error.value"
      kept="上一次的调度状态与运行记录还在页面上。"
      @retry="board.run()"
    />

    <PageSkeleton v-if="board.loading.value && !board.data.value" preset="table" :rows="4" />

    <template v-else-if="board.data.value">
      <!-- ① 调度器状态。停摆时用 danger 而不是 warn：任务不跑等于钱不收，不是"提醒一下" -->
      <div v-if="stalled" class="banner banner--danger">
        <b>定时任务没有在跑</b>
        <span>扣减、关单、送达兜底都不会自动发生。下面的绿色记录只说明"手工跑过"。</span>
      </div>
      <div v-else class="banner banner--ok">
        <b>调度器运行中</b>
        <span>每日扣减在第 {{ board.data.value.settlementHour }} 点（北京时间），巡检每 {{ board.data.value.patrolIntervalMinutes }} 分钟一次。</span>
      </div>

      <dl class="kv">
        <div>
          <dt>上次汇总扣减</dt>
          <dd class="num">{{ state?.lastSettlementDate || '从未跑过' }}</dd>
        </div>
        <div>
          <dt>上次账单生成账期</dt>
          <dd class="num">{{ state?.lastStatementPeriod || '从未跑过' }}</dd>
        </div>
        <div>
          <dt>上次对账巡检</dt>
          <dd class="num">{{ state?.lastPatrolAt ? dt(state.lastPatrolAt) : '从未跑过' }}</dd>
        </div>
        <div>
          <dt>近 100 次失败</dt>
          <dd class="num">{{ board.data.value.counts.failed }} / {{ board.data.value.counts.total }}</dd>
        </div>
      </dl>

      <!-- ② 手动触发。按钮按服务端给的任务清单渲染 -->
      <div class="row row--wrap jp__acts">
        <span class="sub muted">手动跑一次：</span>
        <button
          v-for="k in kinds.data.value?.items ?? []"
          :key="k.kind"
          class="btn btn--sm"
          type="button"
          :disabled="running !== ''"
          @click="runOne(k.kind)"
        >
          {{ running === k.kind ? '运行中…' : k.label }}
        </button>
      </div>

      <!-- ③ 运行记录 -->
      <EmptyState
        v-if="!runs.length"
        text="还没有运行记录"
        hint="调度器到点后会自动留下记录。也可以点上面的按钮手动跑一次，用来确认任务本身是好的。"
      />
      <div v-else class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>时间</th>
              <th>任务</th>
              <th>触发方式</th>
              <th>结果</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in runs" :key="r.id">
              <td class="num sub">{{ dt(r.startedAt) }}</td>
              <td>{{ r.kind }}</td>
              <!-- 触发方式必须显示：一条"手工"记录不能当作调度正常的证据 -->
              <td>
                <ToneTag :tone="r.trigger === 'schedule' ? 'ok' : 'off'" :text="r.trigger === 'schedule' ? '定时' : '手工'" />
              </td>
              <td>
                <ToneTag :tone="r.ok ? 'ok' : 'danger'" :text="r.ok ? '成功' : '失败'" />
                <span v-if="!r.ok && r.error" class="sub muted jp__err">{{ r.error }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </Panel>
</template>

<style scoped>
.jp__acts {
  margin: var(--sp-4) 0;
}
.jp__err {
  margin-left: var(--sp-2);
}
.kv {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--sp-3);
  margin: var(--sp-4) 0 0;
}
.kv dt {
  font-size: var(--fs-sub);
  color: var(--ink-500);
}
.kv dd {
  margin: 2px 0 0;
  font-size: var(--fs-body);
  color: var(--ink-900);
}
</style>
