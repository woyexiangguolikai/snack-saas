<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad, onPullDownRefresh } from '@dcloudio/uni-app';
import SnNavBar from '../../components/SnNavBar.vue';
import SnProductItem from '../../components/SnProductItem.vue';
import SnAmount from '../../components/SnAmount.vue';
import SnBadge from '../../components/SnBadge.vue';
import SnBuildingSheet from '../../components/SnBuildingSheet.vue';
import SnProductSheet from '../../components/SnProductSheet.vue';
import SnCartSheet from '../../components/SnCartSheet.vue';
import SnSkeleton from '../../components/SnSkeleton.vue';
import SnStateBlock from '../../components/SnStateBlock.vue';
import { useSessionStore } from '../../stores/session';
import { useThemeStore } from '../../stores/theme';
import { useShop } from '../../composables/useShop';
import { useAsync } from '../../composables/useAsync';
import { api, type Category, type StorefrontItem } from '../../utils/api';

/**
 * S-06 分类页。
 *
 * 与首页的差别只在**浏览方式**：首页是纵向连续浏览（按分类分段 + 锚点跳转），
 * 这里是左右分栏（左选分类、右看该分类）。
 * 数据源、楼栋过滤、库存上限、购物车全部与首页共用 ——
 * 否则会出现"首页能加购、分类页加不进"这类看似随机的问题。
 *
 * 左栏宽度 92px 是设计定值：再窄放不下 4 个汉字（"饮料冷饮"），
 * 再宽就把右侧商品网格挤到 2 列放不下。
 */
const theme = useThemeStore();
const session = useSessionStore();
const shop = useShop();

const activeCat = ref<number | null>(null);
const showBuilding = ref(false);
const showProduct = ref(false);
const showCart = ref(false);
const activeProduct = ref<StorefrontItem | null>(null);

const cats = useAsync<{ items: Category[] }>(() => api.categories());
const goods = useAsync<{ items: StorefrontItem[] }>(() => api.storefront(shop.buildingId.value));

onLoad(async () => {
  await session.ensureResolved();
  shop.bindCart();
  await Promise.all([cats.load(), shop.loadGate()]);
  await goods.load();
  shop.cart.syncLimits(goods.data.value?.items ?? []);
  // 默认选中第一个分类 —— 进页面就看到商品，而不是一块空白的右栏
  if (!activeCat.value) activeCat.value = cats.data.value?.items?.[0]?.id ?? null;
});

onPullDownRefresh(async () => {
  await Promise.all([shop.loadGate(), cats.reload(), goods.reload()]);
  shop.cart.syncLimits(goods.data.value?.items ?? []);
  uni.stopPullDownRefresh();
});

/** 右栏内容：某个分类在该栋的可售商品。没有分类归属的用 0 表示 */
const current = computed(() => {
  const items = goods.data.value?.items ?? [];
  if (activeCat.value === null) return items;
  return items.filter((it) => (it.categoryId ?? 0) === activeCat.value);
});

/** 每个分类在本栋的可售数量 —— 显示在左栏，避免学生点进去才发现是空的 */
const countOf = computed(() => {
  const m = new Map<number, number>();
  for (const it of goods.data.value?.items ?? []) {
    const k = it.categoryId ?? 0;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
});

const buildingName = computed(() => shop.buildingName.value);
const buildingId = computed(() => shop.buildingId.value);
const multiBuilding = computed(() => shop.multiBuilding.value);
const orderable = computed(() => shop.orderable.value);
const gate = shop.gate;

async function switchBuilding(id: number): Promise<void> {
  activeProduct.value = null;
  await shop.pickBuilding(id);
  goods.reset();
  await goods.load();
  shop.cart.syncLimits(goods.data.value?.items ?? []);
}

function pickCat(id: number): void {
  activeCat.value = id;
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
  <view class="cat" :style="theme.themeStyle">
    <SnNavBar title="分类" @back="onBack" />

    <!-- 楼栋牌：与首页同一枚签名组件（AC-01：六处复用必须完全一致） -->
    <view class="cat__bwrap">
      <view class="cat__bchip" @click="multiBuilding && (showBuilding = true)">
        <text class="cat__bname">{{ buildingName || '选择宿舍楼' }}</text>
        <text v-if="multiBuilding" class="cat__bchev">⌄</text>
      </view>
    </view>

    <view class="cat__body">
      <!-- 骨架 -->
      <view v-if="goods.phase.value === 'loading'" class="cat__skel">
        <SnSkeleton variant="text" />
        <SnSkeleton variant="text" />
        <SnSkeleton variant="text" />
      </view>

      <SnStateBlock
        v-else-if="goods.phase.value === 'error'"
        tone="danger"
        glyph="!"
        title="商品没加载出来"
        :desc="goods.error.value?.message ?? '网络不太顺，请稍后重试'"
        primary-text="重新加载"
        @primary="goods.reload()"
      />

      <SnStateBlock
        v-else-if="goods.isEmpty.value"
        tone="off"
        glyph="—"
        title="本栋暂时没有可买的商品"
        desc="店家可能在补货，也可能是这栋还没上架商品。"
        :primary-text="multiBuilding ? '切换楼栋' : ''"
        @primary="showBuilding = true"
      />

      <!-- 左右分栏 -->
      <template v-else>
        <scroll-view scroll-y class="cat__rail">
          <view
            v-for="c in cats.data.value?.items ?? []"
            :key="c.id"
            class="cat__railitem"
            :class="{ 'is-on': c.id === activeCat, 'is-empty': !(countOf.get(c.id) ?? 0) }"
            @click="pickCat(c.id)"
          >
            <text class="cat__railname">{{ c.name }}</text>
            <text class="cat__railcount num">{{ countOf.get(c.id) ?? 0 }}</text>
          </view>
        </scroll-view>

        <scroll-view scroll-y class="cat__pane">
          <!-- 该分类下没货：说清是"这个分类空了"，而不是整店没货 -->
          <SnStateBlock
            v-if="!current.length"
            tone="off"
            glyph="—"
            title="这个分类在本栋没有可买的商品"
            desc="可以看看左边其他分类。"
          />
          <view v-else class="cat__grid">
            <view v-for="it in current" :key="it.productId" class="cat__cell">
              <SnProductItem
                :item="it"
                :qty="shop.qtyOf(it.productId)"
                layout="grid"
                :orderable="orderable"
                @add="shop.addToCart(it)"
                @set-qty="(v: number) => shop.setQty(it.productId, v)"
                @open="openProduct(it)"
              />
            </view>
          </view>
          <view class="cat__tailpad" />
        </scroll-view>
      </template>
    </view>

    <view v-if="!shop.cart.isEmpty" class="cat__cart">
      <view class="cat__cartinner" @click="showCart = true">
        <view class="cat__carticon">
          <text class="cat__cartglyph">🛒</text>
          <view class="cat__cartbadge"><SnBadge :count="shop.cart.count" /></view>
        </view>
        <view class="cat__cartsum">
          <SnAmount :fen="shop.cart.totalCents" size="md" />
          <text class="cat__cartnote">{{ shop.cart.hasInvalid ? '有商品已售完，请先移出' : '已含本栋库存校验' }}</text>
        </view>
        <view class="cat__cartgo" :class="{ 'is-disabled': shop.cart.hasInvalid }" @click.stop="shop.gotoCheckout()">
          <text>去结算</text>
        </view>
      </view>
    </view>

    <SnBuildingSheet
      v-model="showBuilding"
      :buildings="session.buildings"
      :current-id="buildingId"
      :locked="!multiBuilding"
      @pick="switchBuilding"
    />
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
    <SnCartSheet v-model="showCart" :building-name="buildingName" @checkout="shop.gotoCheckout()" />
  </view>
</template>

<style>
.cat {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  background: var(--paper);
}
.cat__bwrap {
  flex: none;
  padding: 0 var(--page-x) var(--sp-3);
}
.cat__bchip {
  height: var(--building-chip-h);
  border-radius: var(--building-chip-r);
  background: var(--building-chip-bg);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
}
.cat__bname {
  font-size: var(--fs-card);
  font-weight: var(--fw-semibold);
  color: var(--building-chip-fg);
}
.cat__bchev {
  font-size: var(--fs-card);
  color: var(--building-chip-fg);
}
.cat__body {
  flex: 1;
  min-height: 0;
  display: flex;
  border-top: var(--bd);
}
.cat__skel {
  padding: var(--sp-5) var(--page-x);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
/* 左栏 92px 是设计定值，不要改成百分比：窄了放不下 4 个汉字 */
.cat__rail {
  width: 92px;
  flex: none;
  background: var(--line-100);
}
.cat__railitem {
  padding: var(--sp-4) var(--sp-2);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}
.cat__railitem.is-on {
  background: var(--paper);
}
.cat__railname {
  font-size: var(--fs-sub);
  color: var(--ink-700);
  text-align: center;
}
.cat__railitem.is-on .cat__railname {
  font-weight: var(--fw-semibold);
  color: var(--brand-700);
}
/* 空分类压暗但仍可点：完全隐藏会让左栏"跳"，学生找不到刚才那个分类了 */
.cat__railitem.is-empty .cat__railname {
  color: var(--ink-300);
}
.cat__railcount {
  font-size: var(--fs-tag);
  color: var(--ink-400);
}
.cat__pane {
  flex: 1;
  min-width: 0;
}
.cat__grid {
  display: flex;
  flex-wrap: wrap;
  padding: var(--sp-3) var(--sp-3) 0;
  gap: var(--sp-2);
}
.cat__cell {
  width: calc((100% - var(--sp-2)) / 2);
}
.cat__tailpad {
  height: 88px;
}
.cat__cart {
  flex: none;
  padding: var(--sp-2) var(--page-x);
  padding-bottom: calc(var(--sp-2) + env(safe-area-inset-bottom));
  background: var(--surface);
  box-shadow: var(--sup);
  z-index: var(--z-absorb);
}
.cat__cartinner {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
.cat__carticon {
  position: relative;
  width: 44px;
  height: 44px;
  border-radius: var(--r-md);
  background: var(--brand-100);
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
.cat__cartglyph {
  font-size: 20px;
}
.cat__cartbadge {
  position: absolute;
  top: -4px;
  right: -4px;
}
.cat__cartsum {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.cat__cartnote {
  font-size: var(--fs-tag);
  color: var(--ink-500);
}
.cat__cartgo {
  flex: none;
  height: 44px;
  padding: 0 var(--sp-6);
  border-radius: var(--r-lg);
  background: var(--brand-500);
  display: flex;
  align-items: center;
  justify-content: center;
}
.cat__cartgo text {
  font-size: var(--fs-card);
  font-weight: var(--fw-semibold);
  color: var(--on-brand);
}
.cat__cartgo.is-disabled {
  background: var(--brand-300);
}
</style>
