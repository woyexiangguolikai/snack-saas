<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad, onPullDownRefresh, onShow } from '@dcloudio/uni-app';
import SnNavBar from '../../components/SnNavBar.vue';
import SnChip from '../../components/SnChip.vue';
import SnInput from '../../components/SnInput.vue';
import SnTag from '../../components/SnTag.vue';
import SnSwitch from '../../components/SnSwitch.vue';
import SnThumb from '../../components/SnThumb.vue';
import SnStateBlock from '../../components/SnStateBlock.vue';
import SnSkeleton from '../../components/SnSkeleton.vue';
import { useThemeStore } from '../../stores/theme';
import { useMerchantStore } from '../../stores/merchant';
import { useAsync } from '../../composables/useAsync';
import { mapi, type MatrixRow } from '../../utils/mapi';
import { toast, confirm, pullRefresh } from '../../utils/ui';
import SnNetBanner from '../../components/SnNetBanner.vue';

/**
 * M-04 商品列表（售罄 / 上下架开关）。
 *
 * **「下架」和「售罄」必须视觉分离**（需求 CW-02）：
 *   下架 = 我主动不卖了（学生端根本看不到这一项）；
 *   售罄  = 我还想卖但没货了（学生端看得到，显示为已售完）。
 * 合成一个开关，商户就会以为"售罄 = 我下架了"，然后在有货的时候忘记重新上架。
 * 所以这里：开关只管上下架，售罄是一个**只读标签**。
 *
 * 筛选为什么只有四类：再多一类（比如"高库存"）对"现在该补什么"没有帮助，
 * 商户手机端真正要回答的只有三个问题：哪个没了、哪个快没了、哪个忘了上架。
 */
const theme = useThemeStore();
const merchant = useMerchantStore();

const keyword = ref('');
const filter = ref<'all' | 'low' | 'soldout' | 'off'>('all');

const matrix = useAsync<{ rows: MatrixRow[] }>(() => mapi.matrix(true));

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

const WARN_DEFAULT = 3;

function isSoldOut(row: MatrixRow): boolean {
  return row.cells.length > 0 && row.cells.every((c) => c.status === 'off' || c.stock === 0);
}

function isLow(row: MatrixRow): boolean {
  return row.cells.some((c) => c.status === 'on' && c.stock > 0 && c.stock <= (c.warnStock ?? WARN_DEFAULT));
}

function isOff(row: MatrixRow): boolean {
  return row.status === 'off' || row.cells.every((c) => c.status === 'off');
}

const counts = computed(() => {
  const rows = matrix.data.value?.rows ?? [];
  return {
    all: rows.length,
    low: rows.filter(isLow).length,
    soldout: rows.filter(isSoldOut).length,
    off: rows.filter(isOff).length,
  };
});

const visible = computed(() => {
  const rows = matrix.data.value?.rows ?? [];
  const kw = keyword.value.trim().toLowerCase();
  return rows.filter((r) => {
    if (kw && !r.name.toLowerCase().includes(kw)) return false;
    if (filter.value === 'low') return isLow(r);
    if (filter.value === 'soldout') return isSoldOut(r);
    if (filter.value === 'off') return isOff(r);
    return true;
  });
});

const chips = computed(() => [
  { key: 'all', label: '全部' },
  { key: 'low', label: '低库存' },
  { key: 'soldout', label: '售罄' },
  { key: 'off', label: '未上架' },
] as const);

async function toggleStatus(row: MatrixRow, next: boolean): Promise<void> {
  // 下架是"学生端立刻看不见"，不是小事 —— 但也不该弹一个吓人的确认框
  if (!next) {
    const yes = await confirm(`下架「${row.name}」？`, '下架后学生在小程序里看不到这件商品，库存数值会保留。', '下架');
    if (!yes) return;
  }
  try {
    await mapi.setProductStatus(row.productId, next ? 'active' : 'off');
    toast(next ? '已上架' : '已下架');
    await matrix.reload();
  } catch (e) {
    toast(e instanceof Error ? e.message : '操作没有完成，请重试');
    await matrix.reload();
  }
}

function stockSummary(row: MatrixRow): string {
  if (row.cells.length <= 1) return `${row.totalStock} 件`;
  return `${row.cells.length} 栋共 ${row.totalStock} 件`;
}
</script>

<template>
  <view class="gl" :style="theme.themeStyle">
    <SnNavBar title="商品" />
    <!-- 网络横幅（§5.2：任何情况下可见）—— 导航栏正下方，不遮挡操作 -->
    <SnNetBanner />

    <view class="gl__search">
      <SnInput v-model="keyword" type="text" placeholder="搜索商品名" confirm-type="search" />
    </view>

    <view class="gl__chips">
      <SnChip
        v-for="c in chips"
        :key="c.key"
        :label="`${c.label} ${counts[c.key]}`"
        :selected="filter === c.key"
        @click="filter = c.key"
      />
    </view>

    <scroll-view scroll-y class="gl__scroll">
      <view v-if="matrix.phase.value === 'loading'" class="gl__skel">
        <SnSkeleton variant="text" />
        <SnSkeleton variant="text" />
        <SnSkeleton variant="text" />
      </view>

      <SnStateBlock
        v-else-if="matrix.phase.value === 'error'"
        tone="danger"
        glyph="!"
        title="商品没加载出来"
        :desc="matrix.error.value?.message ?? '网络不太顺，这次没取到数据。点「重新加载」再试一次'"
        primary-text="重新加载"
        @primary="matrix.reload()"
      />

      <SnStateBlock
        v-else-if="visible.length === 0"
        tone="off"
        glyph="—"
        :title="keyword ? '没有匹配的商品' : '这个筛选下没有商品'"
        :desc="keyword ? '换个关键词试试。' : '换一个筛选条件，或者到电脑端添加商品。'"
        :primary-text="keyword ? '清空关键词' : ''"
        @primary="keyword = ''"
      />

      <view v-else class="gl__list">
        <view v-for="row in visible" :key="row.productId" class="gl__row">
          <SnThumb :src="''" :size="56" />
          <view class="gl__main">
            <text class="gl__name">{{ row.name }}</text>
            <text class="gl__meta">¥{{ (row.priceCents / 100).toFixed(2) }} · {{ stockSummary(row) }}</text>
            <view class="gl__tags">
              <!-- 售罄是只读标签：它不是开关，改不了也不该改 -->
              <SnTag v-if="isSoldOut(row)" tone="off" label="售罄" />
              <SnTag v-else-if="isLow(row)" tone="warn" label="库存偏低" />
            </view>
          </view>
          <view class="gl__side">
            <SnSwitch
              :model-value="row.status === 'active'"
              label="在售"
              @change="(v: boolean) => toggleStatus(row, v)"
            />
          </view>
        </view>
        <view class="gl__pad" />
      </view>
    </scroll-view>
  </view>
</template>

<style>
.gl {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  background: var(--paper);
}
.gl__search {
  flex: none;
  padding: var(--sp-3) var(--page-x) var(--sp-2);
}
.gl__chips {
  flex: none;
  display: flex;
  gap: var(--sp-2);
  padding: 0 var(--page-x) var(--sp-3);
}
.gl__scroll {
  flex: 1;
  min-height: 0;
}
.gl__skel {
  padding: var(--sp-5) var(--page-x);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.gl__list {
  padding: 0 var(--page-x);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.gl__row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3);
  background: var(--surface);
  border-radius: var(--r-md);
}
.gl__main {
  flex: 1;
  min-width: 0;
}
.gl__name {
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}
.gl__meta {
  font-size: var(--fs-tag);
  color: var(--ink-500);
}
.gl__tags {
  margin-top: var(--sp-1);
  display: flex;
  gap: var(--sp-2);
}
.gl__side {
  flex: none;
}
.gl__pad {
  height: var(--sp-6);
}
</style>
