<script setup lang="ts">
/**
 * P-09 对账报表。
 *
 * 两条口径写死在这一页上，因为它们决定了"差额"该怎么读：
 *   · **未扣必须标红** —— 付了钱但没扣服务费，是断链，不是"误差"
 *   · **0.01 元属分位取整的正常误差** —— 标「待核」而不是错误。
 *     把取整误差当错误报警，结果是真正的断链淹没在噪声里
 *
 * 订单数 / GMV 口径：按**支付成功**归账期（不是下单时间、不是完成时间）。
 * 这个口径与服务端 buildStatement 一致，界面上写明，否则两个地方各算一遍必然分叉。
 */
import { computed, ref } from 'vue';
import PageHeader from '@/components/PageHeader.vue';
import Panel from '@/components/Panel.vue';
import EmptyState from '@/components/EmptyState.vue';
import ToneTag from '@/components/ToneTag.vue';
import Money from '@/components/Money.vue';
import JobsPanel from '@/platform/JobsPanel.vue';
import { papi } from '@/api/platform';
import { useLoad, messageOf } from '@/composables/useLoad';
import { toast } from '@/utils/feedback';
import { downloadCsv, toCsv } from '@/utils/csv';
import { d10 } from '@/utils/fmt';

interface Statement {
  tenantCode: string;
  period: string;
  orderCount: number;
  gmvCents: number;
  feeDueCents: number;
  feeDeductedCents: number;
  diffCents: number;
  status: 'open' | 'ok' | 'diff';
  createdAt: string;
}

interface Reconcile {
  tenantCode: string;
  balanceCents: number;
  txnSumCents: number;
  diffCents: number;
  txnCount: number;
  pendingFeeCents: number;
  pendingOrderCount: number;
  settledFeeCents: number;
  settledOrderCount: number;
  ok: boolean;
}

const thisMonth = new Date().toISOString().slice(0, 7);
const period = ref(thisMonth);
const code = ref('');

const { data: overview } = useLoad(() => papi.ledgerOverview());
const tenants = computed(() => overview.value?.items ?? []);

const rows = ref<Statement[]>([]);
/** 本期一条订单都没有 → 不是出错了，是还没有可扣的钱（空态 ⑫） */
const noCharge = computed(() => rows.value.length === 1 && rows.value[0].orderCount === 0);
const loading = ref(false);
const error = ref('');
const detail = ref<{ code: string; statement: Statement; recon: Reconcile } | null>(null);

async function load(): Promise<void> {
  if (!code.value.trim()) {
    toast('先选一个租户', 'warn');
    return;
  }
  loading.value = true;
  error.value = '';
  rows.value = [];
  detail.value = null;
  try {
    const r = (await papi.statements(code.value, period.value)) as { statement: Statement };
    rows.value = [r.statement];
    const recon = (await papi.reconcile(code.value)) as Reconcile;
    detail.value = { code: code.value, statement: r.statement, recon };
  } catch (e) {
    error.value = messageOf(e);
  } finally {
    loading.value = false;
  }
}

async function runSettle(): Promise<void> {
  if (!code.value.trim()) return;
  try {
    await papi.runSettle(code.value);
    toast('已跑一次结算（幂等：同一天重复跑不会重复扣）', 'ok');
    await load();
  } catch (e) {
    toast(messageOf(e), 'danger');
  }
}

/** 切到上个月：本期为空时最自然的下一步是看看上个月有没有正常出账 */
function gotoPrevPeriod(): void {
  // 从**当前正在看的账期**往前推一个月，而不是从"今天"推 ——
  // 从今天推的话，连按两次得到的还是同一个月，用户会以为按钮坏了。
  const d = new Date(`${period.value}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  period.value = d.toISOString().slice(0, 7);
  void load();
}

function scrollToJobs(): void {
  const el = document.getElementById('jobs-panel');
  el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function statusOf(s: Statement): { text: string; tone: 'ok' | 'warn' | 'danger' } {
  if (s.status === 'open') return { text: '未结算', tone: 'warn' };
  if (Math.abs(s.diffCents) === 0) return { text: '已对平', tone: 'ok' };
  // 1 分以内算取整误差 —— 不是错误，但也得让人看到
  if (Math.abs(s.diffCents) <= 1) return { text: '待核（取整误差）', tone: 'warn' };
  return { text: '有差额', tone: 'danger' };
}

function exportCsv(): void {
  if (!rows.value.length) return;
  const content = toCsv(
    ['租户号', '账期', '订单数', 'GMV(元)', '应收(元)', '已扣(元)', '差额(元)', '状态'],
    rows.value.map((s) => [
      s.tenantCode,
      s.period,
      s.orderCount,
      (s.gmvCents / 100).toFixed(2),
      (s.feeDueCents / 100).toFixed(2),
      (s.feeDeductedCents / 100).toFixed(2),
      (s.diffCents / 100).toFixed(2),
      statusOf(s).text,
    ]),
  );
  downloadCsv(`对账-${code.value}-${period.value}.csv`, content);
}
</script>

<template>
  <div>
    <PageHeader title="对账报表" code="P-09" desc="口径：按支付成功时间归账期">
      <template #actions>
        <button class="btn" type="button" :disabled="!rows.length" @click="exportCsv()">导出 CSV</button>
      </template>
    </PageHeader>

    <Panel title="选择范围" class="gap">
      <div class="row row--wrap">
        <select v-model="code" class="select" style="max-width: 280px">
          <option value="">选择租户…</option>
          <option v-for="t in tenants" :key="t.tenantCode" :value="t.tenantCode">
            {{ t.shopName }}（{{ t.tenantCode }}）
          </option>
        </select>
        <input v-model="period" class="input" style="max-width: 140px" placeholder="2026-09" />
        <button class="btn pbtn--primary" type="button" :disabled="loading" @click="load()">
          {{ loading ? '生成中…' : '生成对账单' }}
        </button>
        <button class="btn" type="button" :disabled="loading || !code" @click="runSettle()">
          跑一次结算
        </button>
      </div>
      <p class="sub muted hint">
        对账单是「应付 vs 实扣」的比对：应付 = 该账期成交订单的理论服务费；
        实扣 = 该账期真正落账的扣费流水。差额不为 0 就是断链（付了没扣 / 扣了没付）。
      </p>
    </Panel>

    <EmptyState
      v-if="error"
      class="gap"
      text="对账单没生成出来"
      :hint="error"
    >
      <button class="btn btn--sm" type="button" @click="load()">重试</button>
    </EmptyState>

    <Panel v-if="rows.length" title="对账单" flush class="gap">
      <!-- 空态（12 类之⑫）：本期真的没有扣费时，一张全是 0 的表读起来像故障。
           必须解释**为什么空 + 什么时候会更新**，并给出两条出路。 -->
      <!-- 空态（12 类之⑫）：本期真的没有扣费时，一张全是 0 的表读起来像故障。
           必须解释**为什么空 + 什么时候会更新**，并给出两条出路。 -->
      <EmptyState
        v-if="noCharge"
        :text="`${period} 还没有产生扣费`"
        hint="该租户本期没有支付成功的订单，所以没有服务费可扣。账单由每日扣费任务更新，出了单会自动补上。"
      >
        <button class="btn btn--sm" type="button" @click="gotoPrevPeriod()">查看上月账单</button>
        <button class="btn btn--sm" type="button" @click="scrollToJobs()">查看扣费任务</button>
      </EmptyState>

      <div v-else class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>账期</th>
              <th class="num">订单数</th>
              <th class="num">GMV</th>
              <th class="num">应收（2%）</th>
              <th class="num">已扣</th>
              <th class="num">差额</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in rows" :key="s.period">
              <td class="num">{{ s.period }}</td>
              <td class="num">{{ s.orderCount }}</td>
              <td><Money :cents="s.gmvCents" /></td>
              <td><Money :cents="s.feeDueCents" /></td>
              <td><Money :cents="s.feeDeductedCents" /></td>
              <td>
                <b :class="{ bad: statusOf(s).tone === 'danger' }">
                  <Money :cents="s.diffCents" />
                </b>
              </td>
              <td><ToneTag :tone="statusOf(s).tone" :text="statusOf(s).text" /></td>
            </tr>
          </tbody>
        </table>
      </div>
    </Panel>

    <template v-if="detail">
      <div class="p-cards gap">
        <div class="p-card">
          <p class="p-card__k">账本自洽</p>
          <p class="p-card__v">{{ detail.recon.ok ? '对平' : '有差' }}</p>
          <p class="p-card__d">余额 vs 全部流水求和</p>
        </div>
        <div class="p-card">
          <p class="p-card__k">余额</p>
          <p class="p-card__v"><Money :cents="detail.recon.balanceCents" /></p>
          <p class="p-card__d">{{ detail.recon.txnCount }} 条流水</p>
        </div>
        <div class="p-card">
          <p class="p-card__k">待扣队列</p>
          <p class="p-card__v">{{ detail.recon.pendingOrderCount }}</p>
          <p class="p-card__d"><Money :cents="detail.recon.pendingFeeCents" /> 未扣</p>
        </div>
        <div class="p-card">
          <p class="p-card__k">已结算</p>
          <p class="p-card__v">{{ detail.recon.settledOrderCount }}</p>
          <p class="p-card__d"><Money :cents="detail.recon.settledFeeCents" /> 已扣</p>
        </div>
      </div>

      <div v-if="!detail.recon.ok" class="p-note p-note--danger gap">
        账本自洽核对**没对上**（余额 {{ (detail.recon.balanceCents / 100).toFixed(2) }} ≠
        流水求和 {{ (detail.recon.txnSumCents / 100).toFixed(2) }}）。
        这不是取整误差，是有流水或余额被绕过账本原语直接改过 —— 先查谁动过，再动账。
      </div>
      <div v-else class="p-note p-note--ok gap">
        账本自洽：余额 == 全部流水求和。这是「分毫不差」的可执行定义。
      </div>

      <Panel title="差异明细" desc="待扣队列与最近结算批次" flush class="gap">
        <EmptyState
          v-if="!detail.recon.pendingOrderCount"
          text="没有待扣订单"
          hint="所有已支付订单都已进入结算批次"
        />
        <div v-else class="pad3">
          <p class="sub">
            有 {{ detail.recon.pendingOrderCount }} 笔已支付但尚未扣费，合计
            <Money :cents="detail.recon.pendingFeeCents" />。
            这些单通常会由每日扣减任务在次日凌晨汇总扣掉；若长期不动，说明定时任务没跑。
          </p>
        </div>
      </Panel>

      <p class="sub muted gap">
        账单生成时间 {{ d10(detail.statement.createdAt) }} ·
        账期 {{ detail.statement.period }} · 租户 <span class="num">{{ detail.code }}</span>
      </p>
    </template>

    <!-- 定时任务看板：本期为空时"查看扣费任务"就滚到这里（空态 ⑫ 的出路之一） -->
    <div id="jobs-panel">
      <JobsPanel />
    </div>
  </div>
</template>

<style scoped>
.gap {
  margin-top: var(--sp-4);
}
.hint {
  margin: var(--sp-3) 0 0;
  line-height: 1.7;
}
.pad3 {
  padding: var(--sp-4);
}
.bad {
  color: var(--danger);
}
</style>
