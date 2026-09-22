<script setup lang="ts">
/**
 * W-11 数据导出。
 *
 * 现在的实现是**浏览器端按当前筛选生成 CSV**，不占服务端资源、不排队、链接不过期。
 *
 * 为什么不等服务端做导出任务：长任务队列（提交 → 轮询 → 下载）属于 S6/S7 的范围，
 * 而商户"把这学期订单导出来对账"这个需求现在就有。先给一个立刻能用的版本，
 * 等数据量真的大到浏览器扛不住（几万行以上）再换成服务端任务 ——
 * 届时页面只需要把 generate() 换成"提交任务 + 轮询"，参数与筛选逻辑一行不用改。
 */
import { ref } from 'vue';
import { api } from '@/api';
import { downloadCsv, toCsv } from '@/utils/csv';
import { messageOf } from '@/composables/useLoad';
import { toast } from '@/utils/feedback';
import { centsToYuan } from '@/utils/money';
import Panel from '@/components/Panel.vue';
import PageHeader from '@/components/PageHeader.vue';

const KIND = [
  { key: 'orders', label: '订单明细', desc: '单号 / 楼栋 / 房间 / 状态 / 金额 / 服务费 / 时间' },
  { key: 'stock', label: '库存矩阵', desc: '商品 × 楼栋 的当前库存与状态' },
  { key: 'stockLogs', label: '库存流水', desc: '每次库存变动的类型、数量与操作人' },
  { key: 'wallet', label: '余额流水', desc: '充值与扣费的逐笔记录' },
] as const;

type Kind = (typeof KIND)[number]['key'];

const kind = ref<Kind>('orders');
const status = ref('');
const busy = ref(false);
const lastInfo = ref('');

const yuan = (cents: number) => centsToYuan(cents);

async function generate(): Promise<void> {
  busy.value = true;
  lastInfo.value = '';
  try {
    const rows: Array<Array<string | number>> = [];
    let header: string[] = [];
    let filename = '';

    if (kind.value === 'orders') {
      header = ['单号', '楼栋', '楼层', '房间', '状态', '商品小计', '配送费', '实付', '服务费', '下单时间', '送达时间'];
      filename = '订单明细.csv';
      // 逐页取，最多 2000 条 —— 再多就该走服务端任务队列了
      for (let offset = 0; offset < 2000; offset += 200) {
        const r = await api.orders({ status: status.value || undefined, limit: 200, offset });
        for (const o of r.items) {
          rows.push([
            o.orderNo,
            o.buildingName,
            o.floor ?? '',
            o.room,
            o.statusText,
            yuan(o.amountCents),
            yuan(o.deliveryFeeCents),
            yuan(o.totalCents),
            yuan(o.feeCents),
            o.createdAt,
            o.deliveredAt ?? '',
          ]);
        }
        if (r.items.length < 200) break;
      }
    } else if (kind.value === 'stock') {
      const m = await api.matrix(false);
      header = ['商品', '规格', '单价', '合计', ...m.buildings.map((b) => b.name)];
      filename = '库存矩阵.csv';
      for (const r of m.rows) {
        rows.push([r.name, r.spec ?? '', yuan(r.priceCents), r.totalStock, ...r.cells.map((c) => `${c.stock}(${c.badge})`)]);
      }
    } else if (kind.value === 'stockLogs') {
      const r = await api.stockLogs({ limit: 300 });
      const p = await api.products(true);
      const b = await api.buildings();
      const nameOf = (id: number) => p.items.find((x) => x.id === id)?.name ?? String(id);
      const bOf = (id: number) => b.items.find((x) => x.buildingId === id)?.buildingName ?? String(id);
      header = ['时间', '商品', '楼栋', '类型', '变化', '变更后', '关联单号', '操作人', '备注'];
      filename = '库存流水.csv';
      for (const l of r.items) {
        rows.push([
          l.createdAt,
          nameOf(l.productId),
          bOf(l.buildingId),
          l.type,
          l.change,
          l.stockAfter,
          l.refOrderNo ?? '',
          l.operator ?? '',
          l.remark ?? '',
        ]);
      }
    } else {
      const v = await api.billing(300);
      header = ['时间', '类型', '金额', '落账后余额', '关联单号', '备注'];
      filename = '余额流水.csv';
      for (const t of v.txns) {
        rows.push([t.createdAt, t.type, yuan(t.amountCents), yuan(t.balanceAfter), t.refOrderNo ?? '', t.remark ?? '']);
      }
    }

    if (!rows.length) {
      lastInfo.value = '当前筛选下没有数据，未生成文件';
      return;
    }
    downloadCsv(filename, toCsv(header, rows));
    lastInfo.value = `已导出 ${rows.length} 行到 ${filename}`;
    toast(`已导出 ${rows.length} 行`, 'ok');
  } catch (e) {
    toast(messageOf(e), 'danger');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div>
    <PageHeader code="W-11" title="数据导出" desc="按当前筛选生成 CSV，在浏览器里完成，不占服务端资源。" />

    <Panel title="选择要导出的数据">
      <div class="kinds">
        <label v-for="k in KIND" :key="k.key" class="kind" :class="{ 'kind--on': kind === k.key }">
          <input v-model="kind" type="radio" :value="k.key" />
          <span>
            <b>{{ k.label }}</b>
            <span class="sub muted">{{ k.desc }}</span>
          </span>
        </label>
      </div>

      <div v-if="kind === 'orders'" class="field" style="max-width: 240px; margin-top: var(--sp-3)">
        <label class="field__label">订单状态</label>
        <select v-model="status" class="select">
          <option value="">全部</option>
          <option value="pending_accept">待接单</option>
          <option value="delivering">配送中</option>
          <option value="delivered">已送达</option>
          <option value="refunding">待退款</option>
          <option value="refunded">已退款</option>
          <option value="cancelled">已取消</option>
        </select>
      </div>

      <div class="row" style="margin-top: var(--sp-4)">
        <div class="spacer" />
        <button class="btn btn--primary" type="button" :disabled="busy" @click="generate()">
          {{ busy ? '正在生成…' : '生成并下载' }}
        </button>
      </div>

      <p v-if="lastInfo" class="sub muted last">{{ lastInfo }}</p>
    </Panel>

    <p class="sub muted note">
      导出文件带 BOM，Excel 直接打开不会乱码。订单一次最多导出 2000 行 ——
      超过这个量级应由服务端生成（属后续里程碑）。
    </p>
  </div>
</template>

<style scoped>
.kinds {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: var(--sp-2);
}
.kind {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  padding: var(--sp-3);
  border: var(--bd);
  border-radius: var(--r-md);
  cursor: pointer;
  transition: background var(--d-color) var(--e-std), border-color var(--d-color) var(--e-std);
}
.kind:hover {
  background: var(--line-100);
}
.kind--on {
  border-color: var(--brand-500);
  background: var(--brand-50);
}
.kind b {
  display: block;
  font-weight: var(--fw-medium);
  color: var(--ink-900);
}
.last {
  margin: var(--sp-3) 0 0;
  color: var(--ink-700);
}
.note {
  margin: var(--sp-3) 0 0;
}
</style>
