<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad, onPullDownRefresh, onShow } from '@dcloudio/uni-app';
import SnNavBar from '../../components/SnNavBar.vue';
import SnSheet from '../../components/SnSheet.vue';
import SnInput from '../../components/SnInput.vue';
import SnButton from '../../components/SnButton.vue';
import SnStateBlock from '../../components/SnStateBlock.vue';
import SnSkeleton from '../../components/SnSkeleton.vue';
import SnPageSkeleton from '../../components/SnPageSkeleton.vue';
import SnMerchantTab from '../../components/SnMerchantTab.vue';
import { useThemeStore } from '../../stores/theme';
import { useMerchantStore } from '../../stores/merchant';
import { useSessionStore } from '../../stores/session';
import { useAsync } from '../../composables/useAsync';
import { mapi, type MatrixCell, type MatrixRow } from '../../utils/mapi';
import { toast, pullRefresh } from '../../utils/ui';

/* ============================================================================
 * M-03 库存快改（CM-05）
 * ----------------------------------------------------------------------------
 * 三条纪律：
 *   ① **不弹保存**：改了就生效。这是高频、小幅、可逆的操作，
 *      每次弹"确定保存吗"会把它变成没人用的功能 —— 库存就不会被及时修正，
 *      而"库存不准"是会真实造成超卖的。
 *   ② **300ms 去抖**：连点两下不能发两个请求。库存是绝对值写入，
 *      两个请求乱序到达会让最后的值取决于网络，而不是取决于商户点了什么。
 *   ③ **可以撤销**：把库存改成 0 等于当场下架，必须给一条撤销条。
 *      这里的撤销是"再写回原值"，不是状态机回滚 —— 库存没有终态，所以它是真的可撤销
 *      （配送清单那个"撤销"是延迟提交，两者机制不同，别混为一谈）。
 * ==========================================================================*/

const theme = useThemeStore();
const merchant = useMerchantStore();
/** 楼栋清单来自租户解析 —— 骨架要按它决定画几个库存格 */
const session = useSessionStore();

const matrix = useAsync<{ rows: MatrixRow[] }>(() => mapi.matrix());

/** 正在编辑的格子 */
const editing = ref<{ row: MatrixRow; cell: MatrixCell } | null>(null);
const inputVal = ref('');
/** 去抖：同一格子 300ms 内的重复提交直接丢弃 */
const lastSubmit = new Map<string, number>();
const submitting = ref(false);

/** 撤销条：记录上一次被改动的格子与它原来的值 */
const undo = ref<{ productId: number; buildingId: number; prev: number; name: string; buildingName: string } | null>(null);
let undoTimer: ReturnType<typeof setTimeout> | null = null;

const singleBuilding = computed(() => (matrix.data.value?.rows?.[0]?.cells?.length ?? 2) <= 1);

/**
 * 骨架要画几个库存格 = 这家店有几栋楼。
 * 数据还没到，所以只能从商户会话里的楼栋清单推 —— 推不出来时退回 2 格
 * （单楼栋商户占多数，2 格是最小可信值；宁可少画也不多画，
 * 少画时数据到达是"补上"，多画时是"缩回"，后者更跳）。
 */
const skeletonCells = computed(() => Math.max(1, session.buildings.length || 2));

onLoad(() => void boot());
onShow(() => {
  if (merchant.ready) void matrix.reload();
});
onPullDownRefresh(() =>
  pullRefresh(async () => {
    await matrix.reload();
  }),
);

async function boot(): Promise<void> {
  const ok = await merchant.ensure();
  if (!ok) return;
  await matrix.load();
}

function openEdit(row: MatrixRow, cell: MatrixCell): void {
  editing.value = { row, cell };
  inputVal.value = String(cell.stock);
}

function closeEdit(): void {
  editing.value = null;
}

async function submit(): Promise<void> {
  const ed = editing.value;
  if (!ed) return;
  const next = Number(inputVal.value);
  if (!Number.isInteger(next) || next < 0) {
    toast('库存必须是 0 或正整数');
    return;
  }
  if (next === ed.cell.stock) {
    closeEdit();
    return;
  }

  const key = `${ed.row.productId}:${ed.cell.buildingId}`;
  const now = Date.now();
  // 去抖：300ms 内的重复提交丢弃 —— 绝对值写入最怕乱序
  if (now - (lastSubmit.get(key) ?? 0) < 300) return;
  lastSubmit.set(key, now);

  const prev = ed.cell.stock;
  submitting.value = true;
  try {
    const r = await mapi.quickSet(ed.row.productId, ed.cell.buildingId, next);
    // 本地直接换成服务端返回的格子：tone/badge 由服务端算，前端不自己推颜色（AC-11）
    matrix.patch((cur) => {
      if (!cur) return cur;
      return {
        ...cur,
        rows: cur.rows.map((row) =>
          row.productId !== ed.row.productId
            ? row
            : { ...row, cells: row.cells.map((c) => (c.buildingId === ed.cell.buildingId ? r.cell : c)) },
        ),
      };
    });
    closeEdit();
    showUndo(ed.row, ed.cell, prev, next);
  } catch (e) {
    toast(e instanceof Error ? e.message : '修改没有生效，请重试');
  } finally {
    submitting.value = false;
  }
}

function showUndo(row: MatrixRow, cell: MatrixCell, prev: number, next: number): void {
  if (undoTimer) clearTimeout(undoTimer);
  undo.value = {
    productId: row.productId,
    buildingId: cell.buildingId,
    prev,
    name: row.name,
    buildingName: cell.buildingName,
  };
  if (next === 0) toast(`${row.name} 已置为售罄`);
  undoTimer = setTimeout(() => {
    undo.value = null;
    undoTimer = null;
  }, 6000);
}

async function doUndo(): Promise<void> {
  const u = undo.value;
  if (!u) return;
  try {
    const r = await mapi.quickSet(u.productId, u.buildingId, u.prev);
    matrix.patch((cur) => {
      if (!cur) return cur;
      return {
        ...cur,
        rows: cur.rows.map((row) =>
          row.productId !== u.productId
            ? row
            : { ...row, cells: row.cells.map((c) => (c.buildingId === u.buildingId ? r.cell : c)) },
        ),
      };
    });
    toast('已撤销');
  } catch (e) {
    toast(e instanceof Error ? e.message : '撤销没有生效，请重试');
  }
  undo.value = null;
  if (undoTimer) clearTimeout(undoTimer);
}
</script>

<template>
  <view class="mq" :style="theme.themeStyle">
    <SnNavBar title="库存快改" :show-back="false" />

    <scroll-view scroll-y class="mq__scroll">
      <!-- 骨架：商品行 ×4（72px 缩略图 + 一排库存格）。
           格数**按实际楼栋数**渲染 —— 写死 3 个的话，4 栋商户会看到"骨架 3 格、
           数据到达变 4 格"，恰好违反骨架唯一的价值（布局不跳动）。 -->
      <SnPageSkeleton
        v-if="matrix.phase.value === 'loading'"
        preset="stockQuick"
        :cells="skeletonCells"
      />

      <SnStateBlock
        v-else-if="matrix.phase.value === 'error'"
        tone="danger"
        glyph="!"
        title="库存没加载出来"
        :desc="matrix.error.value?.message ?? '网络不太顺，这次没取到数据。点「重新加载」再试一次'"
        primary-text="重新加载"
        @primary="matrix.reload()"
      />

      <SnStateBlock
        v-else-if="matrix.isEmpty.value"
        tone="off"
        glyph="—"
        title="还没有商品"
        desc="先在电脑端或「商品」页添加商品，这里就能直接改各楼栋的库存。"
      />

      <template v-else>
        <!-- 撤销条：改错了当场能回来，这是"不弹保存"能成立的前提 -->
        <view v-if="undo" class="mq__undo">
          <text class="mq__undotext">已改 {{ undo.name }} · {{ undo.buildingName }}</text>
          <text class="mq__undobtn" @click="doUndo">撤销</text>
        </view>

        <view v-for="row in matrix.data.value?.rows ?? []" :key="row.productId" class="mq__row">
          <view class="mq__head">
            <text class="mq__name">{{ row.name }}</text>
            <text class="mq__price">¥{{ (row.priceCents / 100).toFixed(2) }}</text>
          </view>

          <!-- 单楼栋商户不显示楼栋名（§4.9）：他没有"各栋"的概念，显示出来只会让他困惑 -->
          <view class="mq__cells">
            <view
              v-for="cell in row.cells"
              :key="cell.buildingId"
              class="mq__cell"
              :class="`is-${cell.tone}`"
              @click="openEdit(row, cell)"
            >
              <text v-if="!singleBuilding" class="mq__cellbldg">{{ cell.buildingName }}</text>
              <text class="mq__cellnum">{{ cell.stock }}</text>
              <text class="mq__cellbadge">{{ cell.badge }}</text>
            </view>
          </view>
        </view>

        <!-- 批量引导：手机端是"改一格"，批量是电脑端的事，别在手机里硬塞 -->
        <view class="mq__tip">
          <text class="mq__tiptext">需要一次性改很多？在电脑端用库存矩阵批量处理更快。</text>
        </view>
        <view class="mq__pad" />
      </template>
    </scroll-view>

    <SnSheet :model-value="!!editing" title="修改库存" @update:model-value="closeEdit">
      <view class="mq__sheet">
        <text class="mq__sheetname">{{ editing?.row.name }}</text>
        <text v-if="editing && !singleBuilding" class="mq__sheetbldg">{{ editing.cell.buildingName }}</text>
        <SnInput
          v-model="inputVal"
          label="库存数量"
          type="number"
          placeholder="如 24"
          helper="改成 0 就是这一栋暂时售罄"
        />
        <SnButton block size="md" type="pri" :loading="submitting" @click="submit">立即生效</SnButton>
      </view>
    </SnSheet>

    <SnMerchantTab current="stock" />
  </view>
</template>

<style>
.mq {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  background: var(--paper);
}
.mq__scroll {
  flex: 1;
  min-height: 0;
}
.mq__skel {
  padding: var(--sp-5) var(--page-x);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.mq__undo {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-3) var(--page-x);
  background: var(--warn-bg);
}
.mq__undotext {
  font-size: var(--fs-sub);
  color: var(--warn);
}
.mq__undobtn {
  font-size: var(--fs-sub);
  font-weight: var(--fw-semibold);
  color: var(--warn);
}
.mq__row {
  margin: var(--sp-3) var(--page-x);
  padding: var(--sp-3) var(--sp-4);
  background: var(--surface);
  border-radius: var(--r-md);
}
.mq__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.mq__name {
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}
.mq__price {
  font-size: var(--fs-tag);
  color: var(--ink-400);
}
.mq__cells {
  margin-top: var(--sp-3);
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}
.mq__cell {
  min-width: 132rpx;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
  display: flex;
  flex-direction: column;
  align-items: center;
  background: var(--ok-bg);
}
.mq__cell.is-warn {
  background: var(--warn-bg);
}
.mq__cell.is-danger {
  background: var(--danger-bg);
}
.mq__cell.is-off {
  background: var(--dark-surface);
}
.mq__cellbldg {
  font-size: 10px;
  color: var(--ink-500);
}
.mq__cellnum {
  font-size: 17px;
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}
.mq__cellbadge {
  font-size: 10px;
  color: var(--ink-500);
}
.mq__tip {
  margin: var(--sp-4) var(--page-x);
  padding: var(--sp-3);
}
.mq__tiptext {
  font-size: var(--fs-tag);
  color: var(--ink-400);
  line-height: var(--lh-body);
}
.mq__sheet {
  padding: var(--sp-4) var(--page-x);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.mq__sheetname {
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
}
.mq__sheetbldg {
  font-size: var(--fs-sub);
  color: var(--ink-500);
}
.mq__pad {
  height: var(--sp-6);
}
</style>
