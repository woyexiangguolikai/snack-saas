<script setup lang="ts">
/**
 * W-01 工作台。
 *
 * 设计取舍：这一页**只放"需要我今天就动手的事"**，不做数据大屏。
 * 店主打开后台是为了问"有没有单要送、货够不够、余额还够不够"，
 * 摆十个图表只会把这三件事埋掉。真要看趋势，那是导出页（W-11）的事。
 */
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '@/api';
import { useLoad } from '@/composables/useLoad';
import Money from '@/components/Money.vue';
import Panel from '@/components/Panel.vue';
import PageHeader from '@/components/PageHeader.vue';
import EmptyState from '@/components/EmptyState.vue';
import PageSkeleton from '@/components/PageSkeleton.vue';
import ErrorBanner from '@/components/ErrorBanner.vue';
import PartialFailure from '@/components/PartialFailure.vue';
import { session } from '@/stores/session';

const router = useRouter();
const limit = ref(20);

const orders = useLoad(() => api.orders({ limit: 20, offset: 0 }));
const billing = useLoad(() => api.billing(20));
const config = useLoad(() => api.config());

const counts = computed(() => orders.data.value?.counts ?? {});
const pendingAccept = computed(() => counts.value.pending_accept ?? 0);
const delivering = computed(() => counts.value.delivering ?? 0);
const refunding = computed(() => counts.value.refunding ?? 0);

const balance = computed(() => billing.data.value?.wallet ?? null);
const subscription = computed(() => billing.data.value?.subscription ?? null);

/** 余额低于预警线 —— 只陈述事实 + 给下一步，不带压力词（AC-05 / 中性文案） */
const balanceLow = computed(() => {
  const w = balance.value;
  if (!w) return false;
  return w.balanceCents <= w.warnLineCents;
});

const daysLeft = computed(() => subscription.value?.daysLeft ?? null);

const recent = computed(() => (orders.data.value?.items ?? []).slice(0, limit.value));

function goOrders(status: string): void {
  void router.push({ path: '/orders', query: { status } });
}
</script>

<template>
  <div>
    <PageHeader code="W-01" title="工作台" desc="先看有没有要马上处理的：待接单、配送中、待退款，以及余额与服务期。" />

    <ErrorBanner :text="orders.error.value" @retry="orders.run()" :kept="'店铺状态、余额与服务期这些信息还在页面上，不受影响。'" />
    <PartialFailure
      v-if="(billing.error.value || config.error.value) && orders.data.value"
      title="店铺状态与账务卡没加载出来"
      safe="已显示的订单可以直接接单、配送，不受影响。"
      @retry="billing.run(); config.run()"
      retry-label="只重试这部分"
    />


    <div class="stats">
      <button class="stat" type="button" @click="goOrders('pending_accept')">
        <span class="stat__label">待接单</span>
        <span class="stat__value num">{{ pendingAccept }}</span>
      </button>
      <button class="stat" type="button" @click="goOrders('delivering')">
        <span class="stat__label">配送中</span>
        <span class="stat__value num">{{ delivering }}</span>
      </button>
      <button class="stat" type="button" @click="goOrders('refunding')">
        <span class="stat__label">待退款</span>
        <span class="stat__value num">{{ refunding }}</span>
      </button>
      <div class="stat">
        <span class="stat__label">服务费余额</span>
        <span class="stat__value"><Money v-if="balance" :cents="balance.balanceCents" /></span>
      </div>
      <div class="stat">
        <span class="stat__label">服务期剩余</span>
        <span class="stat__value num">{{ daysLeft === null ? '—' : `${daysLeft} 天` }}</span>
      </div>
    </div>

    <div v-if="balanceLow" class="banner banner--warn">
      服务费余额已低于预警线，建议提前充值以免影响接单。
      <button class="btn btn--sm" type="button" @click="router.push('/billing')">去充值</button>
    </div>
    <div v-if="daysLeft !== null && daysLeft <= 15" class="banner banner--warn">
      本店服务期还有 {{ daysLeft }} 天。续期后服务不中断，历史订单与数据全部保留。
    </div>
    <div v-if="config.data.value && !config.data.value.shop.shopOpen" class="banner banner--off">
      店铺当前处于打烊状态，学生可以看到商品但不能下单。
      <button class="btn btn--sm" type="button" @click="router.push('/settings')">去开店</button>
    </div>

    <Panel title="最近的订单" desc="按时间倒序。要看按楼栋分组的配送动线，用订单管理页。">
      <template #actions>
        <button class="btn btn--sm" type="button" @click="router.push('/orders')">全部订单</button>
      </template>

      <PageSkeleton v-if="orders.loading.value && !recent.length" preset="table" :rows="4" />
      <EmptyState v-else-if="!recent.length && !orders.error.value" text="还没有订单" hint="学生下单后会立刻出现在这里" />

      <div v-else class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>单号</th>
              <th>楼栋</th>
              <th>房间</th>
              <th>状态</th>
              <th class="num">金额</th>
              <th>下单时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="o in recent" :key="o.orderNo">
              <td class="num">{{ o.orderNo }}</td>
              <td>{{ o.buildingName }}</td>
              <td class="num">{{ o.room }}</td>
              <td>{{ o.statusText }}</td>
              <td class="num"><Money :cents="o.totalCents" /></td>
              <td class="sub muted">{{ new Date(o.createdAt).toLocaleString('zh-CN') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Panel>

    <p class="foot sub muted">
      当前操作人：{{ session.operator }} · 店铺编号 {{ session.tenantCode }}
    </p>
  </div>
</template>

<style scoped>
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: var(--sp-3);
  margin-bottom: var(--sp-4);
}
.stat {
  background: var(--surface);
  border: var(--bd);
  border-radius: var(--r-lg);
  padding: var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  text-align: left;
  box-shadow: var(--s1);
}
.stat:hover {
  border-color: var(--brand-200);
}
.stat__label {
  font-size: var(--fs-sub);
  line-height: var(--lh-sub);
  color: var(--ink-500);
}
.stat__value {
  font-size: var(--fs-title);
  line-height: var(--lh-title);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}

.foot {
  margin: var(--sp-4) 0 0;
}
</style>
