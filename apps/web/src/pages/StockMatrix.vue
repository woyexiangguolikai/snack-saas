<script setup lang="ts">
/**
 * W-05 库存矩阵 —— 整个后台的核心页。
 *
 * 四条必须落到界面上的纪律：
 *   ① 三态分明：**未上架 ≠ 售罄 ≠ 在售**。前者是"这栋不卖"，中者是"卖完了"，
 *      学生的下一步动作完全不同（换一栋 / 明天再来），界面不能把它们画成一样。
 *   ② 双重编码：每格同时有**底色和文字角标**，色盲也能读（AC-11）。
 *   ③ 两个"同步"必须分开（AC-10）：同步上架只改上下架、同步库存只改数值，
 *      绝不能做一个"同步"按钮干两件事 —— 那会让"我以为只是补货，结果某栋被上架了"。
 *   ④ 网页端改库存**理由必填**：一次往往动几十格，月底对账必须能回答"谁为什么改的"。
 *      （手机端走另一个接口 quick-set，高频小幅当场可逆，不要求手填。）
 */
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '@/api';
import type { MatrixCell, MatrixRow } from '@/api/types';
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

const router = useRouter();
const matrix = useLoad(() => api.matrix(false));
const keyword = ref('');
const onlyIssue = ref(false);

const buildings = computed(() => matrix.data.value?.buildings ?? []);
const rows = computed(() => {
  let list = matrix.data.value?.rows ?? [];
  const kw = keyword.value.trim();
  if (kw) list = list.filter((r) => r.name.includes(kw) || (r.spec ?? '').includes(kw));
  // "只看要处理的" = 至少有一格是售罄或未上架
  if (onlyIssue.value) {
    list = list.filter((r) => r.cells.some((c) => c.visibility !== 'on_sale' || c.stock === 0));
  }
  return list;
});

/* ------------------------------------------------------------ 改一格库存 */

const editing = ref<{ row: MatrixRow; cell: MatrixCell } | null>(null);
const stockInput = ref('');
const reason = ref('');
const saving = ref(false);

function openCell(row: MatrixRow, cell: MatrixCell): void {
  editing.value = { row, cell };
  stockInput.value = String(cell.stock);
  reason.value = '';
}

async function saveCell(): Promise<void> {
  const e = editing.value;
  if (!e) return;
  const stock = Number(stockInput.value);
  if (!Number.isInteger(stock) || stock < 0) {
    toast('库存必须是 0 或正整数', 'warn');
    return;
  }
  if (!reason.value.trim()) {
    toast('请填写调整理由 —— 月底对账要靠它', 'warn');
    return;
  }
  saving.value = true;
  try {
    await api.adjustStock({
      productId: e.row.productId,
      buildingId: e.cell.buildingId,
      stock,
      reason: reason.value.trim(),
      operator: session.operator || '店主',
    });
    toast('已调整', 'ok');
    editing.value = null;
    await matrix.run();
  } catch (err) {
    toast(messageOf(err), 'danger');
  } finally {
    saving.value = false;
  }
}

/* ------------------------------------------------------ 两个同步（AC-10） */

const syncing = ref<MatrixRow | null>(null);
const syncMode = ref<'publish' | 'stock'>('publish');
const publishStatus = ref<'on' | 'off'>('on');
const fromBuilding = ref<number | ''>('');
const syncBusy = ref(false);

function openSync(row: MatrixRow, mode: 'publish' | 'stock'): void {
  syncing.value = row;
  syncMode.value = mode;
  publishStatus.value = 'on';
  fromBuilding.value = row.cells.find((c) => c.exists)?.buildingId ?? '';
}

async function doSync(): Promise<void> {
  const row = syncing.value;
  if (!row) return;
  syncBusy.value = true;
  try {
    if (syncMode.value === 'publish') {
      const r = await api.syncPublish({ productId: row.productId, status: publishStatus.value });
      toast(noticeOf(r), 'ok');
    } else {
      if (fromBuilding.value === '') {
        toast('请选择从哪一栋复制库存', 'warn');
        return;
      }
      const r = await api.syncStock({
        productId: row.productId,
        fromBuildingId: Number(fromBuilding.value),
        mode: 'value',
      });
      toast(noticeOf(r), 'ok');
    }
    syncing.value = null;
    await matrix.run();
  } catch (e) {
    toast(messageOf(e), 'danger');
  } finally {
    syncBusy.value = false;
  }
}

/** 服务端在返回里带 doesNotChange / skipped —— 界面必须把它说出来，否则用户会以为做了没做的事 */
function noticeOf(r: unknown): string {
  const b = (r ?? {}) as { doesNotChange?: string; skipped?: Array<{ buildingName?: string; reason?: string }> };
  if (b.doesNotChange) return b.doesNotChange;
  if (b.skipped?.length) {
    const first = b.skipped[0];
    return `已同步，跳过 ${b.skipped.length} 栋（${first?.buildingName ?? ''}：${first?.reason ?? '未上架'}）`;
  }
  return '已同步';
}

/* ------------------------------------------------------------ 自洽核对 */

const reconcile = ref<{ diffTotal: number; rows: Array<{ diff: number }> } | null>(null);
const checking = ref(false);

async function runReconcile(): Promise<void> {
  checking.value = true;
  try {
    reconcile.value = await api.stockReconcile();
  } catch (e) {
    toast(messageOf(e), 'danger');
  } finally {
    checking.value = false;
  }
}

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
</script>

<template>
  <div>
    <PageHeader
      code="W-05"
      title="库存矩阵"
      desc="商品 × 楼栋 一张表。点格子直接改数量；改完可跑一次自洽核对，差额应为 0。"
    >
      <template #actions>
        <button class="btn" type="button" :disabled="checking" @click="runReconcile()">
          {{ checking ? '核对中…' : '库存自洽核对' }}
        </button>
      </template>
    </PageHeader>

    <ErrorBanner :text="matrix.error.value" @retry="matrix.run()" :kept="'楼栋列与搜索条件都还在。'" />

    <div v-if="reconcile" class="banner" :class="reconcile.diffTotal === 0 ? 'banner--ok' : 'banner--danger'">
      自洽核对：{{ reconcile.rows.length }} 格参与，差额合计 {{ reconcile.diffTotal }}
      {{ reconcile.diffTotal === 0 ? '（与流水一致）' : '（请核对库存流水）' }}
    </div>

    <Panel flush>
      <template #actions>
        <div class="row row--wrap">
          <input v-model="keyword" class="input" style="width: 180px" placeholder="搜索商品" />
          <label class="check"><input v-model="onlyIssue" type="checkbox" /><span>只看要处理的</span></label>
        </div>
      </template>

      <PageSkeleton v-if="matrix.loading.value && !rows.length" preset="stockMatrix" :cols="buildings.length" />
      <!-- 空态（12 类之⑨）：给**两条路**（逐个建 / 批量导入），并说清顺序 ——
           "先建商品，再分配库存"是商户最容易搞混的地方：反着做的话，
           这张表上根本没有格子可填，人会以为系统坏了。 -->
      <EmptyState
        v-else-if="!rows.length && !matrix.error.value"
        text="还没有商品"
        hint="先建几个商品，再给各楼栋分配库存 —— 顺序反了这张表会一直是空的。也可以从 Excel 一次导入。"
      >
        <button class="btn btn--sm btn--primary" type="button" @click="router.push('/products')">新建商品</button>
        <button class="btn btn--sm" type="button" @click="router.push('/import')">Excel 导入</button>
      </EmptyState>

      <div v-else class="tbl-wrap">
        <table class="tbl matrix">
          <thead>
            <tr>
              <th class="col-p">商品</th>
              <th class="num col-t">合计</th>
              <th v-for="b in buildings" :key="b.id" class="num col-c">{{ b.name }}</th>
              <th class="col-op"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.productId">
              <td class="col-p">
                <span class="pname">{{ r.name }}</span>
                <span class="sub muted"><Money :cents="r.priceCents" /> · {{ r.spec || '—' }}</span>
              </td>
              <td class="num col-t">{{ r.totalStock }}</td>
              <td v-for="c in r.cells" :key="c.buildingId" class="num col-c">
                <button
                  class="cell"
                  :style="{ background: BG[c.tone], color: FG[c.tone] }"
                  type="button"
                  @click="openCell(r, c)"
                >
                  <span class="cell__num">{{ c.stock }}</span>
                  <span class="cell__badge">{{ c.badge }}</span>
                </button>
              </td>
              <td class="col-op">
                <div class="ops">
                  <button class="btn btn--sm btn--ghost" type="button" @click="openSync(r, 'publish')">同步上架</button>
                  <button class="btn btn--sm btn--ghost" type="button" @click="openSync(r, 'stock')">同步库存</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </Panel>

    <p class="legend sub muted">
      底色 + 角标同时表达状态：在售 / 售罄 / 未上架是三件不同的事，颜色只是其中一层编码。
    </p>

    <!-- 改一格 -->
    <Modal :open="!!editing" :title="`调整库存 · ${editing?.row.name ?? ''}`" @close="editing = null">
      <p class="sub muted">
        {{ editing?.cell.buildingName }}
        · 当前可售 {{ editing?.cell.stock }}
        · 预占 {{ editing?.cell.locked }}
        · 累计售出 {{ editing?.cell.sold }}
      </p>
      <div class="field">
        <label class="field__label">改为</label>
        <input v-model="stockInput" class="input num" type="number" min="0" />
        <span class="field__hint">可用量即"可售"，预占在下单时已扣走，不要再减一遍</span>
      </div>
      <div class="field">
        <label class="field__label">调整理由（必填）</label>
        <input v-model="reason" class="input" placeholder="如 到货补 24 瓶 / 盘点少了 2 瓶" />
      </div>
      <template #footer>
        <button class="btn" type="button" @click="editing = null">取消</button>
        <button class="btn btn--primary" type="button" :disabled="saving" @click="saveCell()">保存</button>
      </template>
    </Modal>

    <!-- 两个同步分开（AC-10） -->
    <Modal :open="!!syncing" :title="syncMode === 'publish' ? '同步上架' : '同步库存'" @close="syncing = null">
      <p class="sub muted">商品：{{ syncing?.name }}</p>

      <template v-if="syncMode === 'publish'">
        <div class="field">
          <label class="field__label">把该商品在全部楼栋设为</label>
          <select v-model="publishStatus" class="select">
            <option value="on">上架</option>
            <option value="off">下架</option>
          </select>
        </div>
        <p class="hint">同步上架**只改上下架状态，不会改动任何一栋的库存数值**。</p>
      </template>

      <template v-else>
        <div class="field">
          <label class="field__label">从哪一栋复制库存</label>
          <select v-model="fromBuilding" class="select">
            <option v-for="c in syncing?.cells ?? []" :key="c.buildingId" :value="c.buildingId">
              {{ c.buildingName }}（{{ c.stock }}）
            </option>
          </select>
        </div>
        <p class="hint">同步库存**只改数值，不会把未上架的楼栋变成上架**。未上架的栋会被跳过。</p>
      </template>

      <template #footer>
        <button class="btn" type="button" @click="syncing = null">取消</button>
        <button class="btn btn--primary" type="button" :disabled="syncBusy" @click="doSync()">执行</button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.matrix .col-p {
  min-width: 180px;
}
.matrix .col-t {
  width: 72px;
}
.matrix .col-c {
  width: 96px;
}
.matrix .col-op {
  width: 170px;
}
.pname {
  display: block;
  font-weight: var(--fw-medium);
}

.cell {
  width: 100%;
  min-width: 76px;
  height: 44px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  border: var(--bd);
  border-radius: var(--r-md);
  font-family: var(--mono);
  transition: transform var(--d-press) var(--e-out);
}
.cell:hover {
  border-color: var(--brand-500);
}
.cell:active {
  transform: scale(0.985);
}
.cell__num {
  font-size: var(--fs-card);
  font-weight: var(--fw-semibold);
  line-height: 1.1;
}
.cell__badge {
  font-size: var(--fs-tag);
  opacity: 0.9;
}

.ops {
  display: flex;
  gap: var(--sp-1);
  justify-content: flex-end;
}
.check {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  font-size: var(--fs-sub);
  color: var(--ink-700);
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
.legend {
  margin: var(--sp-3) 0 0;
}
</style>
