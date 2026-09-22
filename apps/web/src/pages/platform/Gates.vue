<script setup lang="ts">
/**
 * P-08 两道闸门管理。
 *
 * 双 Tab 的理由：这两个闸门是**两个独立的账本**，谁先到期、谁先没钱，
 * 该做的事不一样（一个是续期、一个是上账）。合成一个列表会让人
 * 对着一个"有问题的租户"却不知道该点哪个按钮。
 *
 * 一列「距停单」把两个口径统一起来：订阅剩余天数与余额距离应急额度的空间，
 * 都能回答同一个问题 —— 还有多久会被停单。
 */
import { computed, ref } from 'vue';
import PageHeader from '@/components/PageHeader.vue';
import Panel from '@/components/Panel.vue';
import EmptyState from '@/components/EmptyState.vue';
import PageSkeleton from '@/components/PageSkeleton.vue';
import ErrorBanner from '@/components/ErrorBanner.vue';
import ToneTag from '@/components/ToneTag.vue';
import Money from '@/components/Money.vue';
import Modal from '@/components/Modal.vue';
import { papi } from '@/api/platform';
import type { PlatformTenantRow } from '@/api/platform-types';
import { useLoad, messageOf } from '@/composables/useLoad';
import { toast } from '@/utils/feedback';
import { d10, daysText } from '@/utils/fmt';

const tab = ref<'subscription' | 'balance'>('subscription');
const { data, loading, error, run } = useLoad(() => papi.ledgerOverview());

const items = computed<PlatformTenantRow[]>(() => data.value?.items ?? []);

/** 订阅 Tab：剩余天数升序（已过期 / 从没开通排最前） */
const subRows = computed(() =>
  [...items.value].sort((a, b) => {
    const av = a.gates.subscriptionDaysLeft ?? -9999;
    const bv = b.gates.subscriptionDaysLeft ?? -9999;
    return av - bv;
  }),
);

/** 余额 Tab：余额升序 —— 最靠前的最该上账 */
const balRows = computed(() => [...items.value].sort((a, b) => a.gates.balanceCents - b.gates.balanceCents));

const rows = computed(() => (tab.value === 'subscription' ? subRows.value : balRows.value));

/* ---------------------------------------------------------- 上账 */

const dialog = ref<PlatformTenantRow | null>(null);
const amount = ref('');
const remark = ref('');
const busy = ref(false);

function openTopup(row: PlatformTenantRow): void {
  dialog.value = row;
  amount.value = '';
  remark.value = '';
}

async function submitTopup(): Promise<void> {
  const row = dialog.value;
  if (!row) return;
  const cents = Math.round(Number(amount.value || 0) * 100);
  if (!Number.isFinite(cents) || cents <= 0) {
    toast('请填写正确的金额', 'warn');
    return;
  }
  busy.value = true;
  try {
    const r = (await papi.topup(row.tenantCode, cents, remark.value.trim() || undefined)) as { unfrozen?: boolean };
    toast(r?.unfrozen ? '已上账，余额回到正常区间，锁单已解除' : '已上账', 'ok');
    dialog.value = null;
    await run();
  } catch (e) {
    toast(messageOf(e), 'danger');
  } finally {
    busy.value = false;
  }
}

async function renew(row: PlatformTenantRow): Promise<void> {
  try {
    await papi.renewSubscription(row.tenantCode);
    toast(`${row.shopName} 已按本学期续期`, 'ok');
    await run();
  } catch (e) {
    toast(messageOf(e), 'danger');
  }
}

/** 解冻记录：从流水里读比较重，这里只提示"上账会自动解冻"这一事实，不伪造记录 */
const unfrozenHint = '余额回到正常区间后，锁单会自动解除 —— 不需要额外操作。';
</script>

<template>
  <div>
    <PageHeader title="两道闸门" code="P-08" desc="订阅与余额是两个独立账本，要分开看、分开处理">
      <template #actions>
        <button class="btn" type="button" @click="run()">刷新</button>
      </template>
    </PageHeader>

    <ErrorBanner :text="error" @retry="run()" />

    <div v-if="loading" class="pad"><PageSkeleton preset="table" /></div>

    <template v-else-if="data">
      <div class="p-cards">
        <div class="p-card">
          <p class="p-card__k">租户总数</p>
          <p class="p-card__v">{{ data.summary.total }}</p>
        </div>
        <div class="p-card">
          <p class="p-card__k">余额待处理</p>
          <p class="p-card__v">{{ data.summary.balanceBlocked }}</p>
          <p class="p-card__d">余额已到应急额度</p>
        </div>
        <div class="p-card">
          <p class="p-card__k">订阅即将到期</p>
          <p class="p-card__v">{{ data.summary.subscriptionExpiring }}</p>
          <p class="p-card__d">剩余 ≤7 天</p>
        </div>
      </div>

      <div class="row row--wrap tabs">
        <button class="p-chip" :class="{ 'p-chip--on': tab === 'subscription' }" type="button" @click="tab = 'subscription'">
          订阅到期列表（剩余天数升序）
        </button>
        <button class="p-chip" :class="{ 'p-chip--on': tab === 'balance' }" type="button" @click="tab = 'balance'">
          余额预警列表（余额升序）
        </button>
      </div>

      <Panel
        :title="tab === 'subscription' ? '订阅' : '余额'"
        :desc="tab === 'subscription' ? '到期前 15 / 7 / 3 天各提醒一次' : '预警线 50 元 · 应急额度 -20 元'"
        flush
        class="gap"
      >
        <EmptyState v-if="!rows.length" text="还没有租户" hint="先去「创建租户」开一户" />
        <div v-else class="tbl-wrap">
          <table class="tbl">
            <thead>
              <tr>
                <th>租户</th>
                <th class="num">楼栋</th>
                <th v-if="tab === 'subscription'">服务期</th>
                <th v-if="tab === 'subscription'">剩余</th>
                <th>余额</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in rows" :key="r.tenantCode">
                <td>
                  <RouterLink :to="{ name: 'P-02', params: { tenantCode: r.tenantCode } }">
                    {{ r.shopName }}
                  </RouterLink>
                  <span class="num sub muted block">{{ r.tenantCode }}</span>
                </td>
                <td class="num">{{ r.buildingCount }}</td>
                <template v-if="tab === 'subscription'">
                  <td class="sub">{{ d10(r.gates.subscriptionEndsAt) }}</td>
                  <td>
                    <ToneTag :tone="r.gates.subscriptionTone" :text="daysText(r.gates.subscriptionDaysLeft)" />
                  </td>
                  <td><Money :cents="r.gates.balanceCents" /></td>
                  <td><ToneTag :tone="r.gates.balanceTone" :text="r.gates.balanceTone === 'ok' ? '正常' : '待处理'" /></td>
                  <td>
                    <button class="btn btn--sm" type="button" @click="renew(r)">续期</button>
                  </td>
                </template>
                <template v-else>
                  <td><Money :cents="r.gates.balanceCents" /></td>
                  <td>
                    <ToneTag :tone="r.gates.balanceTone" :text="r.gates.balanceCents <= 0 ? '已透支' : '正常'" />
                  </td>
                  <td>
                    <button class="btn btn--sm pbtn--primary" type="button" @click="openTopup(r)">上账</button>
                  </td>
                </template>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="pad2 sub muted">{{ unfrozenHint }}</div>
      </Panel>
    </template>

    <Modal :open="!!dialog" :title="dialog ? `上账 · ${dialog.shopName}` : '上账'" :width="460" @close="dialog = null">
      <p class="sub muted cur">
        当前余额 <Money :cents="dialog?.gates.balanceCents ?? 0" /> ·
        预警线 <Money :cents="dialog?.gates.warnLineCents ?? 0" muted />
      </p>
      <label class="field">
        <span class="field__label">金额（元）*</span>
        <input v-model="amount" class="input" placeholder="如 300" />
        <span class="field__hint">服务费按订单金额 2% 汇总扣减；充值后余额回到预警线以上即自动解锁</span>
      </label>
      <label class="field mt">
        <span class="field__label">依据 / 备注</span>
        <input v-model="remark" class="input" placeholder="如：微信转账 300 元，2026-09-22 收到" />
        <span class="field__hint">会写入该租户的余额流水备注 —— 对账时靠它回溯源</span>
      </label>
      <template #footer>
        <button class="btn" type="button" @click="dialog = null">取消</button>
        <button class="btn pbtn--primary" type="button" :disabled="busy" @click="submitTopup()">
          {{ busy ? '提交中…' : '确认上账' }}
        </button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.gap {
  margin-top: var(--sp-4);
}
.tabs {
  margin-top: var(--sp-4);
}
.pad {
  padding: var(--sp-6);
  color: var(--ink-500);
}
.pad2 {
  padding: var(--sp-3) var(--sp-4);
  border-top: var(--bd);
}
.cur {
  margin: 0 0 var(--sp-4);
}
.mt {
  margin-top: var(--sp-3);
}
.block {
  display: block;
}
</style>
