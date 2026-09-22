<script setup lang="ts">
/**
 * W-06 库存流水与调拨。
 *
 * 流水的意义不在"看历史"，而在**对得上账**：每一行都有"变更后的值"，
 * 逐条复算能回到当前库存。所以这里不提供删改，只提供筛选 —— 流水一旦可改，
 * 它就不再是证据了。
 *
 * 调拨做成次级入口：跨栋调货是例外不是常态（常态是各栋自己补货），
 * 放在主操作位只会让人误以为应该每天调来调去。
 */
import { computed, ref } from 'vue';
import { api } from '@/api';
import { useLoad, messageOf } from '@/composables/useLoad';
import { toast } from '@/utils/feedback';
import { session } from '@/stores/session';
import Modal from '@/components/Modal.vue';
import Panel from '@/components/Panel.vue';
import PageHeader from '@/components/PageHeader.vue';
import EmptyState from '@/components/EmptyState.vue';
import PageSkeleton from '@/components/PageSkeleton.vue';
import ErrorBanner from '@/components/ErrorBanner.vue';
import PartialFailure from '@/components/PartialFailure.vue';

const filter = ref({ productId: '' as number | '', buildingId: '' as number | '', limit: 100 });

const logs = useLoad(() =>
  api.stockLogs({
    productId: filter.value.productId === '' ? undefined : Number(filter.value.productId),
    buildingId: filter.value.buildingId === '' ? undefined : Number(filter.value.buildingId),
    limit: filter.value.limit,
  }),
);
const products = useLoad(() => api.products(true));
const buildings = useLoad(() => api.buildings());

const items = computed(() => logs.data.value?.items ?? []);
const nameOf = (id: number) => products.data.value?.items.find((p) => p.id === id)?.name ?? `商品 ${id}`;
const buildingOf = (id: number) =>
  buildings.data.value?.items.find((b) => b.buildingId === id)?.buildingName ?? `楼栋 ${id}`;

/** 类型 → 人话。服务端给的是枚举，界面要说的是"发生了什么" */
const TYPE_TEXT: Record<string, string> = {
  hold: '下单预占',
  release: '释放预占',
  confirm_paid: '支付确认',
  refund_return: '退款回库',
  manual_adjust: '人工调整',
  transfer_out: '调出',
  transfer_in: '调入',
  bulk_import: '批量导入',
};

/* ------------------------------------------------------------------ 调拨 */

const showTransfer = ref(false);
const tf = ref({ productId: '' as number | '', from: '' as number | '', to: '' as number | '', qty: 1 });
const transferring = ref(false);

async function transfer(): Promise<void> {
  if (tf.value.productId === '' || tf.value.from === '' || tf.value.to === '') {
    toast('请选择商品与楼栋', 'warn');
    return;
  }
  if (tf.value.from === tf.value.to) {
    toast('调出与调入不能是同一栋', 'warn');
    return;
  }
  if (!Number.isInteger(tf.value.qty) || tf.value.qty <= 0) {
    toast('调拨数量必须是正整数', 'warn');
    return;
  }
  transferring.value = true;
  try {
    await api.transferStock({
      productId: Number(tf.value.productId),
      fromBuildingId: Number(tf.value.from),
      toBuildingId: Number(tf.value.to),
      qty: tf.value.qty,
      operator: session.operator || '店主',
    });
    toast('已调拨，两端各记一条流水', 'ok');
    showTransfer.value = false;
    await logs.run();
  } catch (e) {
    toast(messageOf(e), 'danger');
  } finally {
    transferring.value = false;
  }
}

function signClass(change: number): string {
  return change > 0 ? 'chg--plus' : change < 0 ? 'chg--minus' : 'chg--zero';
}
</script>

<template>
  <div>
    <PageHeader code="W-06" title="库存流水与调拨" desc="每一次库存变动都在这里。逐条复算可以回到当前库存。">
      <template #actions>
        <button class="btn" type="button" @click="showTransfer = true">跨栋调拨</button>
      </template>
    </PageHeader>

    <ErrorBanner :text="logs.error.value" @retry="logs.run()" :kept="'已显示的流水还在。'" />
    <PartialFailure
      v-if="(products.error.value || buildings.error.value) && logs.data.value"
      title="筛选项没加载出来"
      safe="已显示的流水可以直接查看，按商品或楼栋筛选暂时用不了。"
      @retry="products.run(); buildings.run()"
      retry-label="只重试筛选项"
    />

    <Panel flush>
      <template #actions>
        <div class="row row--wrap">
          <select v-model="filter.productId" class="select" style="width: 160px" @change="logs.run()">
            <option value="">全部商品</option>
            <option v-for="p in products.data.value?.items ?? []" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
          <select v-model="filter.buildingId" class="select" style="width: 160px" @change="logs.run()">
            <option value="">全部楼栋</option>
            <option v-for="b in buildings.data.value?.items ?? []" :key="b.buildingId" :value="b.buildingId">
              {{ b.buildingName }}
            </option>
          </select>
          <select v-model.number="filter.limit" class="select" style="width: 110px" @change="logs.run()">
            <option :value="50">最近 50 条</option>
            <option :value="100">最近 100 条</option>
            <option :value="300">最近 300 条</option>
          </select>
        </div>
      </template>

      <PageSkeleton v-if="logs.loading.value && !items.length" preset="table" :rows="6" />
      <EmptyState v-else-if="!items.length && !logs.error.value" text="还没有库存变动" hint="下单、改库存、调拨都会留下记录" />

      <div v-else class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>时间</th>
              <th>商品</th>
              <th>楼栋</th>
              <th>类型</th>
              <th class="num">变化</th>
              <th class="num">变更后</th>
              <th>关联单号</th>
              <th>操作人</th>
              <th>备注</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in items" :key="l.id">
              <td class="sub muted">{{ new Date(l.createdAt).toLocaleString('zh-CN') }}</td>
              <td>{{ nameOf(l.productId) }}</td>
              <td>{{ buildingOf(l.buildingId) }}</td>
              <td>{{ TYPE_TEXT[l.type] ?? l.type }}</td>
              <td class="num" :class="signClass(l.change)">{{ l.change > 0 ? `+${l.change}` : l.change }}</td>
              <td class="num">{{ l.stockAfter }}</td>
              <td class="num sub muted">{{ l.refOrderNo ?? '—' }}</td>
              <td class="sub muted">{{ l.operator ?? '—' }}</td>
              <td class="sub muted">{{ l.remark ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Panel>

    <Modal :open="showTransfer" title="跨栋调拨" @close="showTransfer = false">
      <p class="hint">调拨是例外操作 —— 常态是各栋自己补货。两端各记一条流水，可在这里查到。</p>
      <div class="field">
        <label class="field__label">商品</label>
        <select v-model="tf.productId" class="select">
          <option v-for="p in products.data.value?.items ?? []" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
      </div>
      <div class="grid2">
        <div class="field">
          <label class="field__label">调出楼栋</label>
          <select v-model="tf.from" class="select">
            <option v-for="b in buildings.data.value?.items ?? []" :key="b.buildingId" :value="b.buildingId">
              {{ b.buildingName }}
            </option>
          </select>
        </div>
        <div class="field">
          <label class="field__label">调入楼栋</label>
          <select v-model="tf.to" class="select">
            <option v-for="b in buildings.data.value?.items ?? []" :key="b.buildingId" :value="b.buildingId">
              {{ b.buildingName }}
            </option>
          </select>
        </div>
      </div>
      <div class="field">
        <label class="field__label">数量</label>
        <input v-model.number="tf.qty" class="input num" type="number" min="1" />
      </div>
      <template #footer>
        <button class="btn" type="button" @click="showTransfer = false">取消</button>
        <button class="btn btn--primary" type="button" :disabled="transferring" @click="transfer()">确认调拨</button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.chg--plus {
  color: var(--ok);
  font-weight: var(--fw-medium);
}
.chg--minus {
  color: var(--warn);
  font-weight: var(--fw-medium);
}
.chg--zero {
  color: var(--ink-500);
}
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-3);
}
.hint {
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  background: var(--info-bg);
  color: var(--info);
  border-radius: var(--r-md);
  font-size: var(--fs-sub);
  line-height: var(--lh-sub);
}
</style>
