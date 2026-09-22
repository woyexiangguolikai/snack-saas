<script setup lang="ts">
import { computed, getCurrentInstance, nextTick, ref } from 'vue';
import { onLoad, onPullDownRefresh, onShow } from '@dcloudio/uni-app';
import SnProductItem from '../../components/SnProductItem.vue';
import SnAnchor from '../../components/SnAnchor.vue';
import SnAmount from '../../components/SnAmount.vue';
import SnBadge from '../../components/SnBadge.vue';
import SnBuildingSheet from '../../components/SnBuildingSheet.vue';
import SnBuildingBar from '../../components/SnBuildingBar.vue';
import SnProductSheet from '../../components/SnProductSheet.vue';
import SnCartSheet from '../../components/SnCartSheet.vue';
import SnUndoBar from '../../components/SnUndoBar.vue';
import SnSkeleton from '../../components/SnSkeleton.vue';
import SnPageSkeleton from '../../components/SnPageSkeleton.vue';
import SnNetBanner from '../../components/SnNetBanner.vue';
import SnStateBlock from '../../components/SnStateBlock.vue';
import SnPartialFailure from '../../components/SnPartialFailure.vue';
import { useSessionStore } from '../../stores/session';
import { useThemeStore } from '../../stores/theme';
import { useShop } from '../../composables/useShop';
import { useAsync } from '../../composables/useAsync';
import { useBoot } from '../../composables/useBoot';
import { useNavMetrics } from '../../composables/useNavMetrics';
import { api, type Category, type StorefrontItem } from '../../utils/api';
import { callShop } from '../../utils/contact';
import { formatAmount } from '../../utils/amount';
import { pullRefresh } from '../../utils/ui';

/**
 * S-04 点单首页。
 *
 * 结构（自上而下，**前两块不参与滚动**）：
 *   ① 楼栋牌（吸顶）—— 浏览上下文，任何时刻都要能看见"我在给哪栋看"
 *   ② 时间状态条     —— "此刻能不能下单"必须常驻，不能藏进弹窗
 *   ③~⑤ 公告 / 分类锚点 / 商品列表（滚动区）
 *   ⑥ 吸底购物车条
 *
 * 为什么①②不放进 scroll-view：小程序里 `position:sticky` 在部分安卓 webview 上不生效，
 * 「吸顶」写成 CSS 会有概率性失效 —— 而"看不见自己在哪一栋"正是本项目最贵的错误来源。
 * 用 flex 布局把它们放在滚动区**外面**，吸顶就是物理事实，不依赖 CSS 支持度。
 */
const session = useSessionStore();
const theme = useThemeStore();
const shop = useShop();

/**
 * 顶部几何：状态栏高度 + 胶囊位置。
 *
 * 首页没有导航栏组件，但它顶部那一行（店名 + 搜索）**就是导航栏**，
 * 所以它必须自己把状态栏和胶囊让出来：
 *   · 整块内容从状态栏下沿开始（paddingTop 走行内样式，CSS class 会被页面样式覆盖）
 *   · 店名那一行取导航栏高度，并把右侧胶囊区留空 —— 否则「搜索商品」按钮会压进胶囊里
 */
const nav = useNavMetrics();
const topStyle = computed(() => ({ paddingTop: `${nav.statusBarHeight}px` }));
const brandStyle = computed(() => ({
  height: `${nav.navBarHeight}px`,
  paddingRight: `${nav.rightReserve}px`,
}));

/** S-01 启动闪屏 / S-02 解析骨架 */
const boot = useBoot();

/** 启动期：楼栋牌与时间条都要占位，否则数据到达时下方整体位移（AC-06） */
const booting = computed(() => boot.phase.value !== 'content');

/* --------------------------------------------------- R-2 未选楼栋的兜底 */

/** 有可选的楼栋吗 —— 没有时"请先选择"就是错误的指引（根本没得选） */
const hasBuildings = computed(() => session.buildings.length > 0);

/**
 * 还没选中任何楼栋（R-2）。
 *
 * 这个状态必须被**显式处理**：如果只让商品区安静地空着，
 * 学生的第一反应是"这家店是空的"或"这个 App 坏了"，然后直接退出去。
 * 正确做法是三件事一起做：说清要先选一栋 + 商品区给可点的空态 + 自动弹抽屉。
 */
const noBuilding = computed(() => session.resolved && !shop.buildingId.value);

/**
 * 店铺信息没解析出来 —— 注意与"未开通"区分：
 * 未开通/停用 是业务状态，走 S-03；这里只处理网络类失败。
 * 两者都不该留白屏，但出路不同（一个联系客服，一个重试）。
 */
const resolveFailed = computed(
  () => !session.resolved && !session.notFound && !session.suspended && !!session.lastError,
);

/**
 * ⚠️ 必须在这里（setup 同步执行期）就抓住组件实例。
 * `getCurrentInstance()` 只在 setup 同步执行期间与生命周期钩子里有效；
 * 我们的 measure() 是 `await load()` 之后才调的，那时"当前实例"已经是 null，
 * 拿它去 createSelectorQuery().in(null) 会**静默**量不到任何东西 ——
 * 表现就是"锚点高亮永远停在第一项"，而且不报任何错。
 */
const inst = getCurrentInstance();

const showBuilding = ref(false);
const showProduct = ref(false);
const showCart = ref(false);
const activeProduct = ref<StorefrontItem | null>(null);

/* ------------------------------------------------------------------ 数据 */

const cats = useAsync<{ items: Category[] }>(() => api.categories());

const goods = useAsync<{ items: StorefrontItem[] }>(() => api.storefront(shop.buildingId.value));

/* ------------------------------------------------------------------ 首屏 */

onLoad(async () => {
  boot.begin();
  const ok = await session.ensureResolved();
  boot.settle(ok);
  if (!ok) {
    // AppID 未匹配 / 店铺暂停 —— 走专门页面，**绝不留白屏**（§2.2）。
    // reLaunch 而不是 navigateTo：关掉导航栈，避免"未开通"页还能返回首页形成来回跳。
    if (session.notFound || session.suspended) {
      uni.reLaunch({ url: '/pages/common/closed' });
    }
    return; // 其它错误（网络类）由页面自身的错误态接管
  }
  shop.bindCart();
  await Promise.all([cats.load(), shop.loadGate()]);
  await goods.load();
  shop.cart.syncLimits(goods.data.value?.items ?? []);
  await nextTick();
  measure();
  void autoOpenBuildingIfNeeded();
});

/**
 * R-2：没选楼栋就**自动把抽屉弹出来**。
 *
 * 设计原文是"不让用户自己找入口"。这不是体贴，而是必要性：
 * 没选楼栋时商品区是空的，学生的注意力在"这里什么都没有"上，
 * 他不会想到去点顶部那块牌子 —— 他会退出去。
 */
async function autoOpenBuildingIfNeeded(): Promise<void> {
  if (!noBuilding.value || !shop.multiBuilding.value) return;
  await nextTick();
  showBuilding.value = true;
}

onShow(() => {
  // 从结算页/分类页回来时楼栋可能已经变了 —— 这里补一次绑定检查
  if (session.resolved) shop.bindCart();
});

onPullDownRefresh(() =>
  pullRefresh(async () => {
    await Promise.all([shop.loadGate(), cats.reload(), goods.reload()]);
    shop.cart.syncLimits(goods.data.value?.items ?? []);
    await nextTick();
    measure();
  }),
);

/**
 * 解析失败后的重试。与 onLoad 走同一套流程 ——
 * 不整页 reLaunch：数据只是没请求成功，没必要重建页面（那会闪白屏）。
 */
async function retryResolve(): Promise<void> {
  boot.retrying();
  const ok = await session.ensureResolved();
  boot.settle(ok);
  if (!ok) return;
  shop.bindCart();
  await Promise.all([cats.load(), shop.loadGate()]);
  await goods.load();
  shop.cart.syncLimits(goods.data.value?.items ?? []);
  await nextTick();
  measure();
}

/**
 * 按当前楼栋重拉商品列表。
 *
 * 抽出来是因为它有两个调用者：用户切楼栋之后、以及**撤销切楼栋**之后（R-5）。
 * 撤销时如果只把购物车还回去、不重拉列表，屏幕上还是新楼栋的商品，
 * 而车里装的是旧楼栋的货 —— 学生一点结算就被拒，且完全看不懂为什么。
 */
async function reloadGoods(): Promise<void> {
  // 先丢弃旧楼栋的列表再拉新的：留着旧数据会让"切换后的那一秒"显示别楼商品
  goods.reset();
  await goods.load();
  shop.cart.syncLimits(goods.data.value?.items ?? []);
  await nextTick();
  measure();
  void autoOpenBuildingIfNeeded();
}

async function switchBuilding(id: number): Promise<void> {
  activeProduct.value = null;
  await shop.pickBuilding(id, reloadGoods);
  await reloadGoods();
}

/* ------------------------------------------------------ 分类分组与锚点 */

const groups = computed(() => {
  const items = goods.data.value?.items ?? [];
  const byId = new Map<number, StorefrontItem[]>();
  for (const it of items) {
    const key = it.categoryId ?? 0;
    const arr = byId.get(key);
    if (arr) arr.push(it);
    else byId.set(key, [it]);
  }
  const ordered: Array<{ id: number; name: string; items: StorefrontItem[] }> = [];
  for (const c of cats.data.value?.items ?? []) {
    const list = byId.get(c.id);
    if (list?.length) ordered.push({ id: c.id, name: c.name, items: list });
    byId.delete(c.id);
  }
  // 没有归类的商品兜底成一组 —— 不能让商品"存在但看不见"，那等于丢单。
  // 这一条同时是"分类接口挂掉"时的兜底：商品全部落在「其他」，
  // 学生照常能点、能加购、能下单（局部失败 §5.1 ②）。
  const rest = [...byId.values()].flat();
  if (rest.length) ordered.push({ id: 0, name: '其他', items: rest });
  return ordered;
});

/**
 * 只重试分类。**不重拉商品** —— 商品是好的，重拉会让整个列表闪一下骨架，
 * 而用户刚看到的位置会被打断。这也是局部失败的要义：只修坏掉的那一块。
 */
async function retryCats(): Promise<void> {
  await cats.reload();
  await nextTick();
  measure();
}

const anchorItems = computed(() => groups.value.map((g) => ({ key: sectionId(g.id), label: g.name })));
const activeAnchor = ref('');
const scrollIntoId = ref('');

function sectionId(catId: number): string {
  return `sn-cat-${catId}`;
}

function onAnchor(key: string): void {
  activeAnchor.value = key;
  // 同一个 id 连续点第二次不会触发滚动，先清空再设 —— 这类"点了没反应"最难自查
  scrollIntoId.value = '';
  nextTick(() => {
    scrollIntoId.value = key;
  });
}

/* 锚点高亮：先量出每节的绝对偏移，才能在滚动时判断"当前在哪一节" */
const offsets = ref<Array<{ key: string; top: number }>>([]);

/**
 * uni 的 `NodesRef` 类型把 `scrollOffset()` 声明成必须传回调，
 * 但我们用的是 `exec()` 批量取结果（多节点一次量完，少几次跨线程往返）。
 * 这里显式放宽类型 —— 迁就一个不准确的 d.ts 去改写正确用法是本末倒置。
 */
type LooseNodesRef = { boundingClientRect(): void; scrollOffset(): void };

function measure(): void {
  const list = groups.value;
  if (!list.length) return;
  const q = uni.createSelectorQuery().in(inst as never);
  const sv = q.select('.home__scroll') as unknown as LooseNodesRef;
  sv.boundingClientRect();
  sv.scrollOffset();
  for (const g of list) q.select(`#${sectionId(g.id)}`).boundingClientRect();

  q.exec((res: unknown[]) => {
    const rectSv = res[0] as { top: number } | null;
    const so = res[1] as { scrollTop: number } | null;
    if (!rectSv || !so) return;
    const st = so.scrollTop;
    const out: Array<{ key: string; top: number }> = [];
    list.forEach((g, i) => {
      const rect = res[2 + i] as { top: number } | null;
      if (!rect) return;
      out.push({ key: sectionId(g.id), top: rect.top - rectSv.top + st });
    });
    offsets.value = out;
    if (!activeAnchor.value && out.length) activeAnchor.value = out[0].key;
  });
}

function onScroll(e: { detail: { scrollTop: number } }): void {
  const st = e.detail.scrollTop;
  if (!offsets.value.length) return;
  let cur = offsets.value[0].key;
  for (const o of offsets.value) {
    if (st + 48 >= o.top) cur = o.key;
  }
  if (cur !== activeAnchor.value) activeAnchor.value = cur;
}

/* ------------------------------------------------------------ 交互 */

function addItem(it: StorefrontItem): void {
  shop.addToCart(it);
  // 加购后把上限刷新一遍：我们刚占了库存，不刷新的话下一个商品的上限还是旧值
  const cur = goods.data.value;
  if (cur) {
    goods.patch((d) => ({
      items: d.items.map((x) =>
        x.productId === it.productId ? { ...x, availableQty: Math.max(0, x.availableQty - 1) } : x,
      ),
    }));
  }
}

function setQty(productId: number, qty: number): void {
  shop.setQty(productId, qty);
}

function openProduct(it: StorefrontItem): void {
  activeProduct.value = it;
  showProduct.value = true;
}

function checkout(): void {
  shop.gotoCheckout();
}

function openBuilding(): void {
  // 没有可选的楼栋时，点楼栋牌唯一有意义的动作是找店家。
  // 点了没有任何反应是最让人恼火的一种交互 —— 它不是"无操作"，是"坏了"。
  if (!hasBuildings.value) {
    callShop();
    return;
  }
  if (shop.multiBuilding.value) showBuilding.value = true;
}

const gate = shop.gate;
const orderable = computed(() => shop.orderable.value);
const multiBuilding = computed(() => shop.multiBuilding.value);
const buildingName = computed(() => shop.buildingName.value);
const buildingId = computed(() => shop.buildingId.value);
</script>

<template>
  <view class="home" :style="theme.themeStyle">
    <!-- S-01 启动闪屏（覆盖层，不占布局）。
         文案取自本地缓存，所以能"立刻有内容"；没有缓存的首次安装只停 300ms 遮白屏，
         绝不让人盯着一块空的品牌色发呆。
         不放 loading 圈 —— 慢手机上转圈会看起来像卡死了。 -->
    <view
      v-if="boot.splashMounted.value"
      class="home__splash"
      :class="{ 'is-out': boot.phase.value !== 'splash' }"
    >
      <image
        v-if="session.logoUrl"
        class="home__splashlogo"
        :src="session.logoUrl"
        mode="aspectFit"
      />
      <text class="home__splashname">{{ session.shopName || '校园零食' }}</text>
      <!-- 主张只讲"送到哪"，不承诺时效 —— 时效是店家的口头承诺，
           写死在界面上会变成纠纷依据 -->
      <text class="home__splashsub">送到宿舍房间</text>
    </view>

    <!-- ① 楼栋牌（不参与滚动） -->
    <!-- 状态栏内边距必须是行内样式：页面样式表在 app.wxss 之后加载，
         用 class 写 padding-top 会被下面的 `.home__top { padding }` 简写覆盖掉。 -->
    <view class="home__top" :style="topStyle">
      <view class="home__brand" :style="brandStyle">
        <text class="home__shop">{{ session.shopName || '校园零食' }}</text>
        <view class="home__searchbtn" @click="shop.gotoSearch()">
          <text class="home__searchtext">搜索商品</text>
        </view>
      </view>

      <view class="home__building">
        <!-- 解析期占位。
             这里**不能**先显示「选择宿舍楼」：数据到达时会跳版，
             而且会让人以为必须先手动选一次才看得到商品。 -->
        <!-- AC-01：楼栋牌只允许有一个实现（SnBuildingBar），这里不再自己画 ——
             自己画迟早会长成另一个高度（历史上长成过 32px 和 46px 两版）。
             解析期的骨架占位也由组件自己出（loading），占位容器同理不自己画。 -->
        <SnBuildingBar
          :loading="booting"
          :name="buildingName"
          :placeholder="hasBuildings ? '请先选择宿舍楼' : '暂无配送楼栋'"
          :chevron="multiBuilding"
          @pick="openBuilding"
        />
        <!-- 起送行同样要占位，否则时间条会先上移再下移 -->
        <view v-if="booting" class="home__bmeta">
          <view class="home__bmetaskel" />
        </view>
        <text v-else-if="session.currentBuilding" class="home__bmeta">
          起送 {{ formatAmount(session.currentBuilding.minAmountCents) }}
          <text v-if="session.currentBuilding.deliveryFeeCents > 0">
            · 配送费 {{ formatAmount(session.currentBuilding.deliveryFeeCents) }}
          </text>
          <text v-if="multiBuilding"> · 点此切换</text>
        </text>
      </view>
    </view>

    <!-- 网络横幅：首页没有自定义导航栏，所以它紧跟"店名 + 搜索"那一行（视觉上就是导航栏） -->
    <SnNetBanner />

    <!--
      R-1 离线进店黄条。
      有本地缓存时我们让用户**进得来**（而不是甩一张"没连上店铺"的整页错误），
      但必须把实情说出来：现在显示的是上次的数据，且加购能成功、下单一定失败。
      不说清楚的后果是他在支付那一步彻底懵："刚才不是都好好的吗？"
    -->
    <view v-if="session.offline" class="home__offline">
      <text class="home__offlinetext">网络连不上，正在显示上次的内容。下单和支付需要联网。</text>
      <text class="home__offlinetry" @click="retryResolve()">重试</text>
    </view>

    <!-- ② 时间状态条（不参与滚动） -->
    <!-- 解析期占位：高度取 18px（= fs-tag 11 × 行高 1.65），与真实文本行一致 -->
    <view v-if="booting" class="home__gate home__gate--skel">
      <SnSkeleton variant="title" width="168px" />
    </view>
    <view v-else-if="shop.gateTip.value" class="home__gate" :class="`is-${shop.gateTip.value.tone}`">
      <text class="home__gatetext">{{ shop.gateTip.value.text }}</text>
      <text v-if="shop.gateTip.value.extra" class="home__gateextra">{{ shop.gateTip.value.extra }}</text>
      <text v-if="shop.cutoffSeconds.value !== null && gate?.orderable" class="home__gatetimer num">
        {{ shop.cutoffText.value }}
      </text>
    </view>

    <!-- 分类锚点（不参与滚动） -->
    <view v-if="groups.length" class="home__anchorwrap">
      <SnAnchor :items="anchorItems" :active-key="activeAnchor" @change="onAnchor" />
    </view>

    <!-- ③④⑤ 滚动区 -->
    <scroll-view
      scroll-y
      class="home__scroll"
      :scroll-into-view="scrollIntoId"
      :scroll-with-animation="true"
      @scroll="onScroll"
    >
      <!-- 局部失败（§5.1 ②）：分类挂了，商品还在。
           此时商品会兜底归到「其他」一组（见 groups 计算），所以页面**完全可用** ——
           绝不能因为一个次要请求就整页判失败。要写清"已显示的可以直接下单"，
           否则学生会以为整页都不可信而离开。 -->
      <SnPartialFailure
        v-if="cats.error.value && groups.length"
        title="分类没加载出来"
        safe="已显示的商品可以直接下单，只是分类锚点暂时用不了。"
        retry-label="只重试分类"
        @retry="retryCats"
      />

      <!-- 店铺公告 -->
      <view v-if="session.announcement" class="home__notice">
        <text class="home__noticetag">公告</text>
        <text class="home__noticetext">{{ session.announcement }}</text>
      </view>

      <!-- 慢网细条：只在启动期出现，解析一结束自然消失 -->
      <view v-if="booting && boot.slow.value" class="home__slow">
        <text class="home__slowtext">网络较慢，正在重试…</text>
      </view>

      <!-- 店铺信息没解析出来（网络类失败）：整页给一条出路，绝不留白 -->
      <SnStateBlock
        v-if="resolveFailed"
        tone="danger"
        glyph="!"
        title="没连上店铺"
        :desc="session.lastError?.message ?? '网络不太顺，这次没取到数据。点「重新加载」再试一次'"
        primary-text="重新加载"
        @primary="retryResolve"
      />

      <!-- 骨架（S-02：解析期直接进首页骨架，不给转圈页）。
           结构必须与真实一致：分类锚点 32 + 商品行 ×3（楼栋牌/时间条已在滚动区外占位）。 -->
      <SnPageSkeleton v-else-if="goods.phase.value === 'loading'" preset="home" :rows="3" />

      <!-- 错误态：说明是"没连上"，并给重试 -->
      <SnStateBlock
        v-else-if="goods.phase.value === 'error'"
        tone="danger"
        glyph="!"
        title="商品没加载出来"
        :desc="goods.error.value?.message ?? '网络不太顺，这次没取到数据。点「重新加载」再试一次'"
        primary-text="重新加载"
        @primary="goods.reload()"
      />

      <!--
        R-2 还没选楼栋：**必须**说清"要先选一栋"并给出可点的入口。
        安静地空着会让学生以为这家店是空的（或 App 坏了），然后直接退出去。
        相应地，真的一个楼栋都没有时不能说"请先选择" —— 他根本没得选。
      -->
      <SnStateBlock
        v-else-if="noBuilding"
        tone="off"
        glyph="—"
        :title="hasBuildings ? '请先选一栋宿舍楼' : '这家店还没有可配送的楼栋'"
        :desc="hasBuildings
          ? '选好之后，这里会显示能送到那栋的商品与库存。'
          : '店家还没添加配送楼栋，暂时无法下单。可以联系店家了解情况。'"
        :primary-text="hasBuildings ? '选择宿舍楼' : '联系店家'"
        @primary="hasBuildings ? openBuilding() : callShop()"
      />

      <!-- 空态（12 类之④）：必须点明**哪个楼栋**，并说明这是系统状态而非用户操作错误。
           不点明楼栋，学生会以为"这个店是不是坏了"；不说"不是你的问题"，他会反复切换楼栋找原因。 -->
      <SnStateBlock
        v-else-if="goods.isEmpty.value"
        tone="off"
        glyph="—"
        :title="`${buildingName || '这栋楼'}今天没有可卖的`"
        :desc="`${buildingName || '你选的这栋楼'}的商品还没上架，不是你的操作问题。店家可能在补货，也可能这栋今天不排配送。`"
        :primary-text="multiBuilding ? '切换楼栋' : '联系店家'"
        :secondary-text="multiBuilding ? '联系店家' : ''"
        @primary="multiBuilding ? openBuilding() : callShop()"
        @secondary="callShop()"
      />

      <!-- 内容 -->
      <template v-else>
        <view v-for="g in groups" :id="sectionId(g.id)" :key="g.id" class="home__group">
          <view class="home__grouphead">
            <text class="home__grouptitle">{{ g.name }}</text>
            <text class="home__groupcount">{{ g.items.length }} 种</text>
          </view>
          <view class="home__items">
            <SnProductItem
              v-for="it in g.items"
              :key="it.productId"
              :item="it"
              :qty="shop.qtyOf(it.productId)"
              layout="row"
              :orderable="orderable"
              @add="addItem(it)"
              @set-qty="(v: number) => setQty(it.productId, v)"
              @open="openProduct(it)"
            />
          </view>
        </view>

        <view v-if="shop.blocked.value" class="home__blocked">
          <!--
            商品照常可浏览，只是不能下单 —— 所以给"整页状态"而不是把列表藏起来。
            §6.4 / AC-02：标题与恢复时间都由服务端拆开给，与结算页、状态页共用同一套话，
            免得同一件事在三页里长出三种说法。
          -->
          <SnStateBlock
            tone="off"
            glyph="—"
            :title="gate?.title ?? '当前不可下单'"
            desc="商品可以正常浏览，恢复后可立即下单。"
            :next-text="gate?.recovery ?? ''"
          />
        </view>
        <view class="home__tailpad" />
      </template>
    </scroll-view>

    <!-- ⑥ 吸底购物车条 -->
    <view v-if="!shop.cart.isEmpty" class="home__cart">
      <view class="home__cartinner" @click="showCart = true">
        <view class="home__carticon">
          <text class="home__cartglyph">🛒</text>
          <view class="home__cartbadge"><SnBadge :count="shop.cart.count" /></view>
        </view>
        <view class="home__cartsum">
          <SnAmount :fen="shop.cart.totalCents" size="md" />
          <text class="home__cartnote">{{ shop.cart.hasInvalid ? '有商品已售完，请先移出' : '已含本栋库存校验' }}</text>
        </view>
        <view class="home__cartgo" :class="{ 'is-disabled': shop.cart.hasInvalid }" @click.stop="checkout">
          <text>去结算</text>
        </view>
      </view>
    </view>

    <!-- 抽屉：楼栋 / 商品 / 购物车 -->
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
      :gate-message="gate?.title ?? ''"
      :building-name="buildingName"
      @add="activeProduct && addItem(activeProduct)"
      @set-qty="(v: number) => activeProduct && setQty(activeProduct.productId, v)"
    />
    <SnCartSheet v-model="showCart" :building-name="buildingName" @checkout="checkout" />

    <!-- R-5 换楼栋的 5 秒撤销条（全局单例，只有这一处需要挂） -->
    <SnUndoBar />
  </view>
</template>

<style>
.home {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  background: var(--paper);
}
.home__top {
  flex: none;
  /* 顶部内边距由行内样式给（状态栏高度），这里不要写 padding 简写 —— 它会覆盖掉它 */
  padding: 0 var(--page-x);
}
.home__brand {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  /* 高度与右侧胶囊留白由行内样式给（实测几何） */
}
.home__shop {
  font-size: var(--fs-title);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  flex: 1;
}
.home__searchbtn {
  flex: none;
  height: 32px;
  padding: 0 var(--sp-3);
  border-radius: var(--r-full);
  background: var(--surface);
  border: var(--bw) solid var(--line-200);
  display: flex;
  align-items: center;
}
.home__searchtext {
  font-size: var(--fs-sub);
  color: var(--ink-500);
}
.home__building {
  padding: var(--sp-2) 0 var(--sp-3);
}
/* 楼栋牌本身不再在此定义 —— 见 SnBuildingBar（AC-01 单一实现） */
.home__bmeta {
  display: block;
  margin-top: var(--sp-2);
  font-size: var(--fs-tag);
  color: var(--ink-500);
}
.home__gate {
  flex: none;
  margin: 0 var(--page-x);
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.home__gate.is-ok {
  background: var(--ok-bg);
}
.home__gate.is-ok .home__gatetext {
  color: var(--ok);
}
.home__gate.is-warn {
  background: var(--warn-bg);
}
.home__gate.is-warn .home__gatetext {
  color: var(--warn);
}
.home__gate.is-off {
  background: var(--off-bg);
}
.home__gate.is-off .home__gatetext {
  color: var(--off);
}
.home__gate.is-danger {
  background: var(--danger-bg);
}
.home__gate.is-danger .home__gatetext {
  color: var(--danger);
}
.home__gatetext {
  flex: 1;
  font-size: var(--fs-sub);
  line-height: var(--lh-sub);
}
.home__gateextra {
  flex: none;
  font-size: var(--fs-tag);
  color: var(--ink-500);
}
.home__gatetimer {
  flex: none;
  font-size: var(--fs-sub);
  font-weight: var(--fw-semibold);
}
.home__anchorwrap {
  flex: none;
  margin-top: var(--sp-3);
}
.home__scroll {
  flex: 1;
  min-height: 0;
}
.home__notice {
  margin: var(--sp-3) var(--page-x) 0;
  padding: var(--sp-3);
  border-radius: var(--r-md);
  background: var(--brand-50);
  display: flex;
  gap: var(--sp-2);
}
.home__noticetag {
  flex: none;
  font-size: var(--fs-tag);
  font-weight: var(--fw-semibold);
  color: var(--brand-700);
}
.home__noticetext {
  flex: 1;
  font-size: var(--fs-sub);
  line-height: var(--lh-sub);
  color: var(--ink-700);
}
.home__skel {
  padding: var(--sp-5) var(--page-x);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.home__group {
  padding: var(--sp-4) var(--page-x) 0;
}
.home__grouphead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: var(--sp-3);
}
.home__grouptitle {
  font-size: var(--fs-section);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}
.home__groupcount {
  font-size: var(--fs-tag);
  color: var(--ink-400);
}
.home__items {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.home__blocked {
  margin-top: var(--sp-4);
}
.home__tailpad {
  height: 88px;
}
.home__cart {
  flex: none;
  padding: var(--sp-2) var(--page-x) var(--sp-2);
  padding-bottom: calc(var(--sp-2) + env(safe-area-inset-bottom));
  background: var(--surface);
  box-shadow: var(--sup);
  z-index: var(--z-absorb);
}
/* R-1 离线进店黄条：用琥珀而不是红 —— 它还没到"出错了"，只是"这次没连上" */
.home__offline {
  flex: none;
  margin: 0 var(--page-x) var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
  background: var(--warn-bg);
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
.home__offlinetext {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-tag);
  line-height: var(--lh-tag);
  color: var(--warn);
}
.home__offlinetry {
  flex: none;
  font-size: var(--fs-tag);
  font-weight: var(--fw-semibold);
  color: var(--brand-700);
}
.home__cartinner {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
.home__carticon {
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
.home__cartglyph {
  font-size: 20px;
}
.home__cartbadge {
  position: absolute;
  top: -4px;
  right: -4px;
}
.home__cartsum {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.home__cartnote {
  font-size: var(--fs-tag);
  color: var(--ink-500);
}
.home__cartgo {
  flex: none;
  height: 44px;
  padding: 0 var(--sp-6);
  border-radius: var(--r-lg);
  background: var(--brand-500);
  display: flex;
  align-items: center;
  justify-content: center;
}
.home__cartgo text {
  font-size: var(--fs-card);
  font-weight: var(--fw-semibold);
  color: var(--on-brand);
}
.home__cartgo.is-disabled {
  background: var(--brand-300);
}
/* ------------------------------------------------------------ 启动三态 */
/* S-01 闪屏：固定覆盖层，不参与布局计算 */
.home__splash {
  position: fixed;
  left: 0;
  top: 0;
  right: 0;
  bottom: 0;
  /* 借用最高的既有层级：启动期不会与 toast 同时出现，这个"借用"是安全的 */
  z-index: var(--z-toast);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: var(--brand-500);
  transition: opacity var(--d-fade) var(--e-std);
}
/* 淡出播完再卸载 —— 直接 v-if 会让它"啪"地消失，像闪了一下 */
.home__splash.is-out {
  opacity: 0;
  pointer-events: none;
}
.home__splashlogo {
  width: 64px;
  height: 64px;
  margin-bottom: var(--sp-4);
  border-radius: var(--r-lg);
}
.home__splashname {
  font-size: var(--fs-title);
  font-weight: var(--fw-semibold);
  color: var(--on-brand);
}
.home__splashsub {
  margin-top: var(--sp-2);
  font-size: var(--fs-sub);
  color: var(--on-brand);
  opacity: 0.82;
}

/* 时间条占位：外层复用 .home__gate 的 padding/圆角，所以高度天然一致 */
.home__gate--skel {
  background: var(--line-100);
}

/* 起送行占位：18px = fs-tag 11 × 默认行高 1.65。
   必须与真实文本行同高，否则数据到达时下方整体位移（AC-06）。 */
.home__bmetaskel {
  width: 128px;
  height: 18px;
  border-radius: var(--r-sm);
  background: var(--line-100);
}

/* 慢网细条 */
.home__slow {
  padding: var(--sp-2) var(--page-x) 0;
}
.home__slowtext {
  font-size: var(--fs-tag);
  color: var(--ink-500);
}
</style>
