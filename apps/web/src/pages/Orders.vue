<script setup lang="ts">
/**
 * W-07 订单管理。
 *
 * 与手机端配送清单（M-01）的分工：
 *   手机端按**空间序**（楼栋→楼层→房间号）给配送动线，只给"要动手的"；
 *   这一页按**时间倒序**给查账视图，全状态、可检索、真分页。
 *   两种排法各自服务于一个具体动作，混在一起两个都不好用。
 *
 * 按钮可用性**一律用服务端给的 `actions`**，前端不自己写 `status === 'x' ? 可点 : 不可点`
 * —— 那等于把状态机抄了第二遍，将来加一条边时界面不会报错，只会"少了按钮"。
 */
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '@/api';
import type { MerchantOrder } from '@/api/types';
import { useLoad, messageOf } from '@/composables/useLoad';
import { toast } from '@/utils/feedback';
import { session } from '@/stores/session';
import Money from '@/components/Money.vue';
import Modal from '@/components/Modal.vue';
import Panel from '@/components/Panel.vue';
import PageHeader from '@/components/PageHeader.vue';
import EmptyState from '@/components/EmptyState.vue';
import PageSkeleton from '@/components/PageSkeleton.vue';
import ErrorBanner from '@/components/ErrorBanner.vue';
import ToneTag from '@/components/ToneTag.vue';

const route = useRoute();
const router = useRouter();

const status = ref((route.query.status as string) ?? '');
const keyword = ref('');
const page = ref(0);
const PAGE_SIZE = 20;

const orders = useLoad(() =>
  api.orders({
    status: status.value || undefined,
    keyword: keyword.value.trim() || undefined,
    limit: PAGE_SIZE,
    offset: page.value * PAGE_SIZE,
  }),
);

// 从工作台带着 ?status=delivering 跳进来时要能直接落到对应筛选上
watch(
  () => route.query.status,
  (v) => {
    status.value = typeof v === 'string' ? v : '';
    page.value = 0;
    void orders.run();
  },
);

const items = computed(() => orders.data.value?.items ?? []);
const total = computed(() => orders.data.value?.total ?? 0);
const counts = computed(() => orders.data.value?.counts ?? {});
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));

/** 状态筛选条。数字来自服务端的全量 counts —— 不随筛选变小 */
const TABS: Array<{ key: string; label: string }> = [
  { key: '', label: '全部' },
  { key: 'pending_accept', label: '待接单' },
  { key: 'delivering', label: '配送中' },
  { key: 'delivered', label: '已送达' },
  { key: 'refunding', label: '待退款' },
  { key: 'refunded', label: '已退款' },
  { key: 'cancelled', label: '已取消' },
];

function pick(key: string): void {
  status.value = key;
  page.value = 0;
  void router.replace({ path: '/orders', query: key ? { status: key } : {} });
  void orders.run();
}

function search(): void {
  page.value = 0;
  void orders.run();
}

/* ------------------------------------------------------------------ 详情 */

const detail = ref<MerchantOrder | null>(null);
const detailLoading = ref(false);

async function open(o: MerchantOrder): Promise<void> {
  detail.value = o;
  detailLoading.value = true;
  try {
    const r = await api.orderDetail(o.orderNo);
    detail.value = r.order;
  } catch (e) {
    toast(messageOf(e), 'danger');
  } finally {
    detailLoading.value = false;
  }
}

const acting = ref('');

async function act(action: 'accept' | 'deliver' | 'refund/start' | 'refund/reject'): Promise<void> {
  const o = detail.value;
  if (!o) return;
  acting.value = action;
  try {
    await api.orderAction(o.orderNo, action);
    toast('已更新', 'ok');
    const r = await api.orderDetail(o.orderNo);
    detail.value = r.order;
    await orders.run();
  } catch (e) {
    toast(messageOf(e), 'danger');
  } finally {
    acting.value = '';
  }
}

const refundCents = ref('');

async function refundDone(): Promise<void> {
  const o = detail.value;
  if (!o) return;
  const cents = Math.round(Number(refundCents.value) * 100);
  if (!Number.isInteger(cents) || cents <= 0) {
    toast('退款金额必须大于 0', 'warn');
    return;
  }
  acting.value = 'refund/done';
  try {
    await api.refundDone(o.orderNo, cents);
    toast('退款已完成，服务费一并返还', 'ok');
    const r = await api.orderDetail(o.orderNo);
    detail.value = r.order;
    await orders.run();
  } catch (e) {
    toast(messageOf(e), 'danger');
  } finally {
    acting.value = '';
  }
}

const rejectReason = ref('');
const showReject = ref(false);

async function doReject(): Promise<void> {
  const o = detail.value;
  if (!o) return;
  acting.value = 'reject';
  try {
    await api.rejectOrder(o.orderNo, rejectReason.value.trim() || '商户拒单');
    toast('已拒单，款项将原路退回', 'ok');
    showReject.value = false;
    const r = await api.orderDetail(o.orderNo);
    detail.value = r.order;
    await orders.run();
  } catch (e) {
    toast(messageOf(e), 'danger');
  } finally {
    acting.value = '';
  }
}

const can = (o: MerchantOrder, a: string) => o.actions.includes(a as never);

function timeText(t: string | null): string {
  return t ? new Date(t).toLocaleString('zh-CN') : '—';
}
</script>

<template>
  <div>
    <PageHeader code="W-07" title="订单管理" desc="按时间倒序。可按单号或房间号检索 —— 接到电话说某间有问题时用得上。" />

    <ErrorBanner :text="orders.error.value" @retry="orders.run()" :kept="'你选的订单状态和搜索词都还在，重试后不用重新选。'" />

    <div class="tabs">
      <button
        v-for="t in TABS"
        :key="t.key"
        class="tab"
        :class="{ 'tab--on': status === t.key }"
        type="button"
        @click="pick(t.key)"
      >
        {{ t.label }}
        <span v-if="t.key && counts[t.key]" class="tab__n num">{{ counts[t.key] }}</span>
      </button>
      <div class="spacer" />
      <input
        v-model="keyword"
        class="input"
        style="width: 200px"
        placeholder="单号 / 房间号"
        @keyup.enter="search()"
      />
      <button class="btn" type="button" @click="search()">搜索</button>
    </div>

    <Panel flush>
      <PageSkeleton v-if="orders.loading.value && !items.length" preset="table" :rows="6" />
      <EmptyState v-else-if="!items.length && !orders.error.value" text="没有符合条件的订单" hint="换个状态或清空搜索" />

      <div v-else class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>单号</th>
              <th>楼栋 / 房间</th>
              <th>商品</th>
              <th>状态</th>
              <th class="num">金额</th>
              <th class="num">服务费</th>
              <th>下单时间</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="o in items" :key="o.orderNo">
              <td class="num">{{ o.orderNo }}</td>
              <td>
                <span>{{ o.buildingName }}</span>
                <span class="sub muted num">{{ o.room }}</span>
              </td>
              <td class="sub">
                {{ o.items.map((i) => `${i.name}×${i.qty}`).join('、') || '—' }}
                <span v-if="o.remark" class="remark">备注：{{ o.remark }}</span>
              </td>
              <td><ToneTag :tone="o.tone" :text="o.statusText" /></td>
              <td class="num"><Money :cents="o.totalCents" /></td>
              <td class="num"><Money :cents="o.feeCents" muted /></td>
              <td class="sub muted">{{ timeText(o.createdAt) }}</td>
              <td class="ops">
                <button class="btn btn--sm btn--ghost" type="button" @click="open(o)">详情</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="items.length" class="pager">
        <button class="btn btn--sm" type="button" :disabled="page <= 0" @click="page--; orders.run()">上一页</button>
        <span class="sub muted num">第 {{ page + 1 }} / {{ pageCount }} 页 · 共 {{ total }} 单</span>
        <button
          class="btn btn--sm"
          type="button"
          :disabled="page + 1 >= pageCount"
          @click="page++; orders.run()"
        >
          下一页
        </button>
      </div>
    </Panel>

    <!-- 详情 -->
    <Modal :open="!!detail" :title="`订单 ${detail?.orderNo ?? ''}`" :width="640" @close="detail = null">
      <div v-if="detail">
        <div class="kv">
          <span class="sub muted">状态</span>
          <span><ToneTag :tone="detail.tone" :text="detail.statusText" /></span>
        </div>
        <p class="sub hintline">{{ detail.hint }}</p>

        <div class="kv">
          <span class="sub muted">收货</span>
          <span>{{ detail.buildingName }} {{ detail.floor ?? '' }} {{ detail.room }} · {{ detail.contact ?? '—' }} {{ detail.phone ?? '' }}</span>
        </div>
        <div class="kv">
          <span class="sub muted">备注</span>
          <span>{{ detail.remark || '—' }}</span>
        </div>

        <table class="tbl mini">
          <thead>
            <tr><th>商品</th><th class="num">单价</th><th class="num">数量</th><th class="num">小计</th></tr>
          </thead>
          <tbody>
            <tr v-for="(i, idx) in detail.items" :key="idx">
              <td>{{ i.name }}</td>
              <td class="num"><Money :cents="i.priceCents" muted /></td>
              <td class="num">{{ i.qty }}</td>
              <td class="num"><Money :cents="i.amountCents" /></td>
            </tr>
          </tbody>
        </table>

        <div class="kv">
          <span class="sub muted">商品小计</span>
          <span><Money :cents="detail.amountCents" /></span>
        </div>
        <div class="kv">
          <span class="sub muted">配送费</span>
          <span><Money :cents="detail.deliveryFeeCents" muted /></span>
        </div>
        <div class="kv total">
          <span>实付</span>
          <span><Money :cents="detail.totalCents" /></span>
        </div>
        <div class="kv">
          <span class="sub muted">服务费（退款时一并返还）</span>
          <span><Money :cents="detail.feeCents" muted /></span>
        </div>

        <div v-if="detail.timeline?.length" class="tl">
          <div v-for="t in detail.timeline" :key="t.label" class="tl__row">
            <span class="sub muted">{{ t.label }}</span>
            <span class="sub num">{{ timeText(t.at) }}</span>
          </div>
        </div>

        <p v-if="detail.autoCompleted" class="hint">本单由兜底任务自动置为已送达。</p>

        <!-- 动作：全部由服务端 state machine 给出 -->
        <div class="acts">
          <button
            v-if="can(detail, 'accept')"
            class="btn btn--primary"
            type="button"
            :disabled="!!acting"
            @click="act('accept')"
          >
            接单
          </button>
          <button
            v-if="can(detail, 'deliver')"
            class="btn btn--primary"
            type="button"
            :disabled="!!acting"
            @click="act('deliver')"
          >
            标记送达
          </button>
          <button
            v-if="can(detail, 'refund_start')"
            class="btn btn--danger"
            type="button"
            :disabled="!!acting"
            @click="showReject = true"
          >
            拒单 / 退款
          </button>
        </div>

        <div v-if="can(detail, 'refund_done')" class="refund">
          <div class="field">
            <label class="field__label">实际退款金额（元）</label>
            <input v-model="refundCents" class="input num" />
            <span class="field__hint">默认退全额 {{ (detail.totalCents / 100).toFixed(2) }} 元</span>
          </div>
          <button class="btn btn--primary" type="button" :disabled="!!acting" @click="refundDone()">确认退款到账</button>
        </div>
        <button
          v-if="can(detail, 'refund_reject')"
          class="btn btn--sm"
          type="button"
          :disabled="!!acting"
          @click="act('refund/reject')"
        >
          驳回退款申请
        </button>
      </div>
    </Modal>

    <!-- 拒单（= 发起退款）：钱已收就必须原路退回，没有"直接取消"这条路 -->
    <Modal :open="showReject" title="拒单" @close="showReject = false">
      <p class="hint">学生已付款，所以拒单等于发起退款：款项原路退回，已扣的服务费一并返还。</p>
      <div class="field">
        <label class="field__label">原因</label>
        <input v-model="rejectReason" class="input" placeholder="如 该栋今晚临时停送" />
        <span class="field__hint">会展示给学生，请写具体原因</span>
      </div>
      <template #footer>
        <button class="btn" type="button" @click="showReject = false">再想想</button>
        <button class="btn btn--danger" type="button" :disabled="!!acting" @click="doReject()">确认拒单并退款</button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.tabs {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
  margin-bottom: var(--sp-3);
}
.tab {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  height: 32px;
  padding: 0 var(--sp-3);
  border: var(--bd);
  border-radius: var(--r-full);
  background: var(--surface);
  color: var(--ink-700);
  font-size: var(--fs-sub);
  transition: background var(--d-color) var(--e-std), color var(--d-color) var(--e-std);
}
.tab:hover {
  background: var(--line-100);
}
.tab--on {
  background: var(--brand-500);
  border-color: var(--brand-500);
  color: var(--on-brand);
}
.tab__n {
  font-size: var(--fs-tag);
  opacity: 0.85;
}

.ops {
  text-align: right;
}
.remark {
  display: block;
  color: var(--warn);
}

.pager {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  border-top: var(--bd);
}

.kv {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: 2px 0;
}
.kv.total {
  font-weight: var(--fw-semibold);
  border-top: var(--bd);
  margin-top: var(--sp-2);
  padding-top: var(--sp-2);
}
.hintline {
  margin: var(--sp-2) 0;
  padding: var(--sp-2) var(--sp-3);
  background: var(--info-bg);
  color: var(--info);
  border-radius: var(--r-md);
}
.tbl.mini {
  margin: var(--sp-3) 0;
  border: var(--bd);
  border-radius: var(--r-md);
  overflow: hidden;
}
.tl {
  margin-top: var(--sp-3);
  padding-top: var(--sp-3);
  border-top: var(--bd);
}
.tl__row {
  display: flex;
  justify-content: space-between;
  gap: var(--sp-3);
}
.acts {
  display: flex;
  gap: var(--sp-2);
  margin-top: var(--sp-3);
}
.refund {
  display: flex;
  align-items: flex-end;
  gap: var(--sp-2);
  margin-top: var(--sp-3);
}
.refund .field {
  flex: 1;
}
.hint {
  margin: var(--sp-2) 0 0;
  padding: var(--sp-2) var(--sp-3);
  background: var(--info-bg);
  color: var(--info);
  border-radius: var(--r-md);
  font-size: var(--fs-sub);
  line-height: var(--lh-sub);
}
</style>
