<script setup lang="ts">
/**
 * W-10 账单与明细。
 *
 * 措辞纪律（与服务端的 ledger/copy.ts 同一条规则）：
 *   服务费 / 服务期 / 余额 / 充值 —— 四组词够表达所有情况，
 *   绝不使用带压力的措辞。这不是文案偏好，是产品判断：
 *   把"该交服务费"写成"你欠了平台的钱"，商户的感受就变了。
 *
 * 界面上所有与余额、服务期相关的**标题和正文都直接显示服务端给的字符串**，
 * 前端不自己拼句子 —— 拼了就等于把那张禁用词表抄漏一份在这里。
 */
import { computed, ref } from 'vue';
import { api } from '@/api';
import { useLoad, messageOf } from '@/composables/useLoad';
import { toast } from '@/utils/feedback';
import Money from '@/components/Money.vue';
import Panel from '@/components/Panel.vue';
import PageHeader from '@/components/PageHeader.vue';
import EmptyState from '@/components/EmptyState.vue';
import PageSkeleton from '@/components/PageSkeleton.vue';
import ErrorBanner from '@/components/ErrorBanner.vue';
import PartialFailure from '@/components/PartialFailure.vue';

const billing = useLoad(() => api.billing(100));

const wallet = computed(() => billing.data.value?.wallet ?? null);
const sub = computed(() => billing.data.value?.subscription ?? null);
const txns = computed(() => billing.data.value?.txns ?? []);
const pending = computed(() => billing.data.value?.pending ?? null);
const runs = computed(() => billing.data.value?.runs ?? []);

const BG: Record<string, string> = {
  ok: 'var(--ok-bg)',
  warn: 'var(--warn-bg)',
  danger: 'var(--danger-bg)',
  off: 'var(--off-bg)',
};
const FG: Record<string, string> = {
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  danger: 'var(--danger)',
  off: 'var(--off)',
};

/** 流水类型 → 人话。服务端给枚举，界面说"发生了什么" */
const TXN_TEXT: Record<string, string> = {
  topup: '充值',
  fee: '服务费扣减',
  refund: '退款返还',
  adjust: '人工调整',
};

const runDetail = ref<{ runId: number; orders: Array<{ orderNo: string; totalCents: number; feeCents: number }> } | null>(null);
const statements = ref<Array<{ period: string; orderCount: number; grossCents: number; feeCents: number; netCents: number }> | null>(null);
/**
 * 账期账单是**第二个请求**，不跟主请求一起回来。
 * 不给它单独的三态，页面就会在加载中显示「还没有账期账单」——
 * 那是一句**错误的事实陈述**：不是没有账单，是还没拿到。
 */
const statementsLoading = ref(true);
const statementsError = ref('');

async function openRun(id: number): Promise<void> {
  try {
    const r = await api.billingRunDetail(id);
    runDetail.value = { runId: id, orders: r.orders };
  } catch (e) {
    toast(messageOf(e), 'danger');
  }
}

async function loadStatements(): Promise<void> {
  statementsLoading.value = true;
  statementsError.value = '';
  try {
    const r = await api.statements();
    statements.value = r.items;
  } catch (e) {
    // 失败不清空已有列表：刷新失败时留着上一次的账单比留一片空白有用（AC-20）
    statementsError.value = messageOf(e);
  } finally {
    statementsLoading.value = false;
  }
}
void loadStatements();
</script>

<template>
  <div>
    <PageHeader code="W-10" title="账单与明细" desc="服务费余额、服务期、待结算与流水。措辞保持中性，只看事实和下一步。" />

    <ErrorBanner :text="billing.error.value" @retry="billing.run()" :kept="'已显示的结算批次与流水还在页面上。'" />


    <div v-if="wallet" class="cards">
      <div class="card">
        <span class="card__label">{{ wallet.walletName }}</span>
        <span class="card__value"><Money :cents="wallet.balanceCents" /></span>
        <span class="card__hint sub muted">预警线 <Money :cents="wallet.warnLineCents" muted /></span>
      </div>
      <div class="card">
        <span class="card__label">{{ sub?.subscriptionName ?? '服务期' }}</span>
        <span class="card__value num">{{ sub?.daysLeft === null || sub?.daysLeft === undefined ? '—' : `${sub.daysLeft} 天` }}</span>
        <span class="card__hint sub muted">{{ sub?.periodEnd ? `至 ${sub.periodEnd.slice(0, 10)}` : '—' }}</span>
      </div>
      <div class="card">
        <span class="card__label">待结算服务费</span>
        <span class="card__value"><Money :cents="pending?.totalCents ?? 0" /></span>
        <span class="card__hint sub muted">{{ pending?.items.length ?? 0 }} 单尚未结算</span>
      </div>
    </div>

    <div v-if="wallet && wallet.tone !== 'ok'" class="banner" :style="{ background: BG[wallet.tone], color: FG[wallet.tone] }">
      <b>{{ wallet.noticeTitle }}</b> · {{ wallet.noticeBody }}
    </div>
    <div v-if="sub?.notice" class="banner banner--warn"><b v-if="sub.noticeTitle">{{ sub.noticeTitle }}</b>{{ sub.noticeTitle ? ' · ' : '' }}{{ sub.notice }}</div>

    <Panel title="结算批次" desc="每批扣的是哪些单，可以展开核对">
      <PageSkeleton v-if="billing.loading.value && !runs.length" preset="table" :rows="4" />
      <EmptyState v-else-if="!runs.length && !billing.error.value" text="还没有结算批次" hint="服务费在每个结算日按批次扣减，扣完会出现在这里" />
      <div v-else class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr><th class="num">批次</th><th>账期</th><th class="num">订单数</th><th class="num">服务费</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="r in runs" :key="r.id">
              <td class="num sub muted">{{ r.id }}</td>
              <td class="sub">{{ r.periodStart.slice(0, 10) }} – {{ r.periodEnd.slice(0, 10) }}</td>
              <td class="num">{{ r.orderCount }}</td>
              <td class="num"><Money :cents="r.feeCents" /></td>
              <td class="ops"><button class="btn btn--sm btn--ghost" type="button" @click="openRun(r.id)">展开</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </Panel>

    <Panel title="账期账单">
      <PageSkeleton v-if="statementsLoading" preset="table" :rows="3" />
      <!-- 账期账单是**第二个请求**：它失败时不能把整页判为失败（§5.1 ②）——
           结算批次与流水这两块该照常能用 -->
      <PartialFailure
        v-else-if="statementsError && !statements?.length"
        title="账期账单没加载出来"
        safe="上面的结算批次与流水可以直接核对，不受影响。"
        @retry="loadStatements()"
        retry-label="只重试账期账单"
      />
      <EmptyState v-else-if="!statements?.length" text="还没有账期账单" hint="账期账单按月生成，出账后会出现在这里" />
      <div v-else class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>账期</th><th class="num">订单数</th><th class="num">流水额</th>
              <th class="num">服务费</th><th class="num">结算金额</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in statements" :key="s.period">
              <td class="num">{{ s.period }}</td>
              <td class="num">{{ s.orderCount }}</td>
              <td class="num"><Money :cents="s.grossCents" muted /></td>
              <td class="num"><Money :cents="s.feeCents" muted /></td>
              <td class="num"><Money :cents="s.netCents" /></td>
            </tr>
          </tbody>
        </table>
      </div>
    </Panel>

    <Panel title="余额流水" desc="每笔都有落账后的余额快照，可逐条验证与余额自洽">
      <PageSkeleton v-if="billing.loading.value && !txns.length" preset="table" :rows="6" />
      <EmptyState v-else-if="!txns.length && !billing.error.value" text="还没有流水" hint="充值、服务费扣减、退款都会在这里留一条，每笔都带落账后余额" />
      <div v-else class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>时间</th><th>类型</th><th class="num">金额</th>
              <th class="num">落账后余额</th><th>关联单号</th><th>备注</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in txns" :key="t.id">
              <td class="sub muted">{{ new Date(t.createdAt).toLocaleString('zh-CN') }}</td>
              <td>{{ TXN_TEXT[t.type] ?? t.type }}</td>
              <td class="num" :class="t.amountCents > 0 ? 'plus' : 'minus'">
                {{ t.amountCents > 0 ? '+' : '' }}<Money :cents="t.amountCents" />
              </td>
              <td class="num"><Money :cents="t.balanceAfter" muted /></td>
              <td class="num sub muted">{{ t.refOrderNo ?? '—' }}</td>
              <td class="sub muted">{{ t.remark ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Panel>

    <Panel v-if="runDetail" :title="`批次 ${runDetail.runId} 的订单`">
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr><th>单号</th><th class="num">金额</th><th class="num">服务费</th></tr></thead>
          <tbody>
            <tr v-for="o in runDetail.orders" :key="o.orderNo">
              <td class="num">{{ o.orderNo }}</td>
              <td class="num"><Money :cents="o.totalCents" muted /></td>
              <td class="num"><Money :cents="o.feeCents" /></td>
            </tr>
          </tbody>
        </table>
      </div>
    </Panel>
  </div>
</template>

<style scoped>
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--sp-3);
  margin-bottom: var(--sp-4);
}
.card {
  background: var(--surface);
  border: var(--bd);
  border-radius: var(--r-lg);
  box-shadow: var(--s1);
  padding: var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.card__label {
  font-size: var(--fs-sub);
  color: var(--ink-500);
}
.card__value {
  font-size: var(--fs-title);
  line-height: var(--lh-title);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}
.plus {
  color: var(--ok);
}
.minus {
  color: var(--warn);
}
.ops {
  text-align: right;
}
</style>
