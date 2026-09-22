<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import SnNavBar from '../../components/SnNavBar.vue';
import SnInput from '../../components/SnInput.vue';
import SnChip from '../../components/SnChip.vue';
import SnProductItem from '../../components/SnProductItem.vue';
import SnStateBlock from '../../components/SnStateBlock.vue';
import SnSkeleton from '../../components/SnSkeleton.vue';
import SnProductSheet from '../../components/SnProductSheet.vue';
import { useThemeStore } from '../../stores/theme';
import { useShop } from '../../composables/useShop';
import { useAsync } from '../../composables/useAsync';
import { api, type StorefrontItem } from '../../utils/api';

/**
 * S-07 搜索页。
 *
 * 关键判断：**搜索在本地做，不再打接口**。
 *   搜索范围就是"本栋在售商品" —— 这批数据在进页面时已经完整拿到（校园店 SKU 量级很小），
 *   本地过滤是零延迟的。改成每次输入都请求服务端，收益是"支持超出本栋的商品"，
 *   但那个收益在本项目里是负的：搜到本栋没有的商品，点进去发现买不了。
 *   代价却是每次输入都要等网络 —— 学生打三个字要等三次。
 *
 * 历史记录存本地、最多 10 条：它是"这台设备上用过什么"，不是账号数据，
 * 所以不上传。超过 10 条淘汰最旧的，避免无限增长。
 */
const theme = useThemeStore();
const shop = useShop();

const keyword = ref('');
const submitted = ref(false);
const showProduct = ref(false);
const activeProduct = ref<StorefrontItem | null>(null);

const HISTORY_KEY = 'snack.search.history';
const HISTORY_MAX = 10;

const history = ref<string[]>(readHistory());

function readHistory(): string[] {
  try {
    const raw = uni.getStorageSync(HISTORY_KEY);
    return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string').slice(0, HISTORY_MAX) : [];
  } catch {
    return [];
  }
}

function pushHistory(kw: string): void {
  const k = kw.trim();
  if (!k) return;
  const next = [k, ...history.value.filter((x) => x !== k)].slice(0, HISTORY_MAX);
  history.value = next;
  try {
    uni.setStorageSync(HISTORY_KEY, next);
  } catch {
    /* 存储满不该让搜索失败 */
  }
}

function clearHistory(): void {
  history.value = [];
  try {
    uni.removeStorageSync(HISTORY_KEY);
  } catch {
    /* ignore */
  }
}

const goods = useAsync<{ items: StorefrontItem[] }>(() => api.storefront(shop.buildingId.value));

onLoad(async () => {
  shop.bindCart();
  await Promise.all([goods.load(), shop.loadGate()]);
  shop.cart.syncLimits(goods.data.value?.items ?? []);
});

/** 本地过滤：商品名与规格都参与匹配（学生经常按规格搜，如"大瓶"） */
const results = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  const items = goods.data.value?.items ?? [];
  if (!kw) return items;
  return items.filter(
    (it) => it.name.toLowerCase().includes(kw) || (it.spec ?? '').toLowerCase().includes(kw),
  );
});

const orderable = computed(() => shop.orderable.value);
const buildingName = computed(() => shop.buildingName.value);
const gate = shop.gate;

function onInput(v: string): void {
  keyword.value = v;
  if (!v.trim()) submitted.value = false;
}

/** 回车/点搜索：写入历史。历史上只记"明确搜过"的词，不记每次输入 */
function onConfirm(): void {
  const k = keyword.value.trim();
  if (!k) return;
  submitted.value = true;
  pushHistory(k);
}

function pickHistory(k: string): void {
  keyword.value = k;
  submitted.value = true;
  pushHistory(k);
}

function openProduct(it: StorefrontItem): void {
  activeProduct.value = it;
  showProduct.value = true;
}

function onBack(): void {
  const pages = getCurrentPages();
  if (pages.length > 1) uni.navigateBack();
  else uni.reLaunch({ url: '/pages/shop/home' });
}
</script>

<template>
  <view class="se" :style="theme.themeStyle">
    <SnNavBar title="搜索" @back="onBack" />

    <view class="se__barwrap">
      <SnInput
        :model-value="keyword"
        placeholder="商品名或规格，如「可乐」"
        clearable
        auto-focus
        confirm-type="search"
        @update:model-value="onInput"
        @confirm="onConfirm"
      />
    </view>

    <scroll-view scroll-y class="se__scroll">
      <!-- 未输入：历史 + 本栋在售 -->
      <template v-if="!keyword.trim()">
        <view v-if="history.length" class="se__block">
          <view class="se__head">
            <text class="se__title">搜索历史</text>
            <text class="se__clear" @click="clearHistory">清空</text>
          </view>
          <view class="se__chips">
            <SnChip v-for="h in history" :key="h" :label="h" @click="pickHistory(h)" />
          </view>
        </view>

        <view class="se__block">
          <view class="se__head">
            <text class="se__title">本栋在售</text>
            <text class="se__count">{{ results.length }} 种</text>
          </view>
          <view class="se__list">
            <SnProductItem
              v-for="it in results"
              :key="it.productId"
              :item="it"
              :qty="shop.qtyOf(it.productId)"
              layout="row"
              :orderable="orderable"
              @add="shop.addToCart(it)"
              @set-qty="(v: number) => shop.setQty(it.productId, v)"
              @open="openProduct(it)"
            />
          </view>
        </view>
      </template>

      <!-- 已输入 -->
      <template v-else>
        <view v-if="goods.phase.value === 'loading'" class="se__skel">
          <SnSkeleton variant="text" />
          <SnSkeleton variant="thumb" />
        </view>

        <SnStateBlock
          v-else-if="!results.length"
          tone="off"
          glyph="—"
          title="没有找到相关商品"
          :desc="`本栋在售商品里没有匹配「${keyword.trim()}」的。换个词试试，或确认一下当前楼栋对不对。`"
          secondary-text="清空关键词"
          @secondary="keyword = ''"
        />

        <view v-else class="se__block">
          <view class="se__head">
            <text class="se__title">找到 {{ results.length }} 种</text>
            <text class="se__count">本栋在售</text>
          </view>
          <view class="se__list">
            <SnProductItem
              v-for="it in results"
              :key="it.productId"
              :item="it"
              :qty="shop.qtyOf(it.productId)"
              layout="row"
              :orderable="orderable"
              @add="shop.addToCart(it)"
              @set-qty="(v: number) => shop.setQty(it.productId, v)"
              @open="openProduct(it)"
            />
          </view>
        </view>
      </template>
      <view class="se__pad" />
    </scroll-view>

    <SnProductSheet
      v-model="showProduct"
      :item="activeProduct"
      :qty="activeProduct ? shop.qtyOf(activeProduct.productId) : 0"
      :orderable="orderable"
      :gate-message="gate?.message ?? ''"
      :building-name="buildingName"
      @add="activeProduct && shop.addToCart(activeProduct)"
      @set-qty="(v: number) => activeProduct && shop.setQty(activeProduct.productId, v)"
    />
  </view>
</template>

<style>
.se {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  background: var(--paper);
}
.se__barwrap {
  flex: none;
  padding: 0 var(--page-x) var(--sp-3);
}
.se__scroll {
  flex: 1;
  min-height: 0;
}
.se__block {
  padding: var(--sp-3) var(--page-x) 0;
}
.se__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: var(--sp-3);
}
.se__title {
  font-size: var(--fs-section);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}
.se__count {
  font-size: var(--fs-tag);
  color: var(--ink-400);
}
.se__clear {
  font-size: var(--fs-sub);
  color: var(--ink-500);
}
.se__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}
.se__list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.se__skel {
  padding: var(--sp-5) var(--page-x);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.se__pad {
  height: var(--sp-8);
}
</style>
