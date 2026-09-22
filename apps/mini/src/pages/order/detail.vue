<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad, onPullDownRefresh } from '@dcloudio/uni-app';
import SnNavBar from '../../components/SnNavBar.vue';
import SnAmount from '../../components/SnAmount.vue';
import SnTag from '../../components/SnTag.vue';
import SnKeyValue from '../../components/SnKeyValue.vue';
import SnDivider from '../../components/SnDivider.vue';
import SnButton from '../../components/SnButton.vue';
import SnStateBlock from '../../components/SnStateBlock.vue';
import SnPageSkeleton from '../../components/SnPageSkeleton.vue';
import { useThemeStore } from '../../stores/theme';
import { useSessionStore } from '../../stores/session';
import { useCartStore } from '../../stores/cart';
import { api } from '../../utils/api';
import { useCountdown } from '../../composables/useCountdown';
import { toast, confirm, switchTab, TAB, pullRefresh } from '../../utils/ui';
import { CUSTOMER_COPY } from '../../utils/copy';

/**
 * S-14 订单详情。
 *
 * 结构：状态卡（回答"现在到哪了"）→ 地址卡 → 小票明细 → 时间线 → 底部操作。
 *
 * 两条设计决定：
 *  ① **没有「确认收货」**（D15）。送达是商户动作，学生确认收货只会引入
 *     "学生不确认就一直挂着"的死结，而这个项目里货是当面交付的，不需要。
 *  ② **底部按钮由服务端 actions 决定**。这一页拿到的是 `actions`（学生侧），
 *     `merchantActions` 只用来在调试时看清"这一步之后该谁动"。
 *
 * 状态卡是这一页的重点：学生打开订单只有两个问题 ——
 * "我的东西到哪了"和"我现在该做什么"。所以状态卡同时回答这两件事：
 * 状态 + 服务端给的 hint（中性措辞）。
 */
const theme = useThemeStore();
const session = useSessionStore();
const cart = useCartStore();

const orderNo = ref('');
/**
 * 直接复用接口的返回类型，不手写内联类型 ——
 * 服务端加字段（如 timeline）时前端不会再静默漏掉。
 */
type OrderDetail = Awaited<ReturnType<typeof api.orderDetail>>;
const order = ref<OrderDetail | null>(null);
const loading = ref(true);
const errText = ref('');

const { text: payText } = useCountdown(
  computed(() => (order.value?.status === 'pending_pay' ? order.value.payExpiresInSeconds : null)),
  () => {
    // 到点去问服务端（关单是服务端动作，不在本地判）
    void load(true);
  },
);

onLoad((query) => {
  orderNo.value = String((query as Record<string, string>)?.orderNo ?? '');
  if (!orderNo.value) {
    errText.value = '缺少订单号';
    loading.value = false;
    return;
  }
  void load();
});

onPullDownRefresh(() =>
  pullRefresh(async () => {
    await load(true);
  }),
);

async function load(silent = false): Promise<void> {
  if (!silent) loading.value = true;
  errText.value = '';
  try {
    order.value = await api.orderDetail(orderNo.value);
    if (!silent) loading.value = false;
  } catch (e) {
    errText.value = e instanceof Error ? e.message : '订单没加载出来';
    loading.value = false;
  }
}

const canPay = computed(() => !!order.value?.actions.includes('pay'));
const canCancel = computed(() => !!order.value?.actions.includes('cancel'));

/**
 * 时间线来自服务端（真实发生过的节点）。
 * 前端**不自己推**"下单时间之后应该发生什么" —— 那等于在前端又写一遍状态机，
 * 而且很容易写出"已经取消的单还显示预计送达"这种自相矛盾的界面。
 */
const timeline = computed(() => order.value?.timeline ?? []);

const reordering = ref(false);
/**
 * 只有"已经走完"的单才给「再来一单」。
 * 进行中的单再买一单，学生自己也会搞不清哪一单是哪一单。
 */
const canReorder = computed(() => {
  const s = order.value?.status;
  return s === 'delivered' || s === 'cancelled' || s === 'refunded';
});

/**
 * 再来一单（S-12）。
 *
 * 关键顺序：**先换栋再补货**。购物车绑楼栋，bindBuilding 会把车清空，
 * 反过来做就是"加进去了又被自己清掉"，而且这种 bug 只在跨栋时复现，很难自查。
 */
async function reorder(): Promise<void> {
  const o = order.value;
  if (!o || reordering.value) return;
  reordering.value = true;
  try {
    await session.ensureResolved();
    if (!session.buildings.some((b) => b.buildingId === o.buildingId)) {
      toast('这一栋现在已经不在配送范围了');
      return;
    }
    // 按"现在能不能买"补，不按"当时买过多少"
    const res = await api.storefront(o.buildingId);
    session.setLastBuilding(o.buildingId);
    cart.bindBuilding(o.buildingId);

    const r = cart.addFromHistory(
      o.items.map((i) => ({ productId: i.productId, name: i.name, qty: i.qty })),
      res.items,
    );
    if (r.addedCount === 0) {
      toast('这些商品现在买不到了');
      return;
    }
    switchTab(TAB.home);
    const parts = [`${r.addedCount} 件已放回购物车`];
    if (r.partial.length) parts.push(CUSTOMER_COPY.reorderPartial(r.partial.length));
    if (r.missing.length) parts.push(`${r.missing.length} 件已经下架`);
    toast(parts.join('，'));
  } catch (e) {
    toast(e instanceof Error ? e.message : '没有加载出来，请重试');
  } finally {
    reordering.value = false;
  }
}

function onBack(): void {
  const pages = getCurrentPages();
  if (pages.length > 1) uni.navigateBack();
  else switchTab(TAB.orders);
}

function goPay(): void {
  uni.navigateTo({ url: `/pages/order/pay-result?orderNo=${orderNo.value}` });
}

async function doCancel(): Promise<void> {
  const yes = await confirm('取消这一单？', '取消后需要重新下单，库存会释放给其他同学。', '取消订单');
  if (!yes) return;
  try {
    await api.cancelOrder(orderNo.value, '学生取消');
    toast('订单已取消');
    await load(true);
  } catch (e) {
    toast(e instanceof Error ? e.message : '取消失败，请重试');
    await load(true);
  }
}
</script>

<template>
  <view class="od" :style="theme.themeStyle">
    <SnNavBar title="订单详情" @back="onBack" />

    <scroll-view scroll-y class="od__scroll">
      <!-- 骨架：状态卡 · 小票明细（**含合计行**）· 键值卡 · 底部操作区。
           漏掉合计行 → 数据到达时下面会多出一行（AC-19：与真实布局同构）。 -->
      <SnPageSkeleton v-if="loading" preset="orderDetail" />

      <SnStateBlock
        v-else-if="errText"
        tone="danger"
        glyph="!"
        title="订单没打开"
        :desc="errText"
        primary-text="重新加载"
        @primary="load()"
      />

      <template v-else-if="order">
        <!-- ① 状态卡：回答"现在到哪了 / 我该做什么" -->
        <view class="od__block">
          <view class="od__status" :class="`is-${order.tone}`">
            <view class="od__statusrow">
              <text class="od__statustext">{{ order.statusText }}</text>
              <SnTag :tone="order.tone" :label="order.buildingName" />
            </view>
            <text class="od__statushint">{{ order.hint }}</text>
            <view v-if="order.status === 'pending_pay' && order.payExpiresInSeconds !== null" class="od__timer">
              <text class="od__timerlabel">剩余</text>
              <text class="od__timerval num">{{ payText }}</text>
              <text class="od__timerlabel">后自动关闭</text>
            </view>
          </view>
        </view>

        <!-- ② 地址卡：本人房间号回显（只有本人看得到，§4.13.4） -->
        <view class="od__block">
          <view class="od__card">
            <view class="od__addrhead">
              <text class="od__room num">{{ order.room }}</text>
              <text class="od__bname">{{ order.buildingName }}</text>
            </view>
            <SnDivider space="sm" />
            <SnKeyValue label="订单号" :value="order.orderNo" value-type="mono" />
            <SnKeyValue label="下单时间" :value="order.createdAt" />
            <SnKeyValue
              label="备注"
              :value="order.remark ?? ''"
              :empty-reason="'没有备注'"
              last
            />
          </view>
        </view>

        <!-- ③ 小票明细 -->
        <view class="od__block">
          <view class="od__card">
            <text class="od__shopname">{{ session.shopName }}</text>
            <SnDivider dashed space="sm" />
            <view v-for="(it, i) in order.items" :key="i" class="od__line">
              <text class="od__linename">{{ it.name }}</text>
              <text class="od__lineqty num">×{{ it.qty }}</text>
              <SnAmount :fen="it.amountCents" size="sm" />
            </view>
            <SnDivider dashed space="sm" />
            <view class="od__total">
              <text class="od__totallabel">实付</text>
              <SnAmount :fen="order.totalCents" size="lg" />
            </view>
          </view>
        </view>

        <!-- ④ 时间线 -->
        <view class="od__block">
          <text class="od__sectiontitle">订单进展</text>
          <view class="od__card">
            <view v-for="(t, i) in timeline" :key="i" class="od__tlrow">
              <view class="od__tldot" />
              <text class="od__tllabel">{{ t.label }}</text>
              <text class="od__tltime num">{{ t.at }}</text>
            </view>
            <text class="od__tlnote">
              送达由店家标记。货是当面交给你的，不需要你确认收货。
            </text>
          </view>
        </view>

        <view class="od__pad" />
      </template>
    </scroll-view>

    <!-- ⑤ 底部操作：**服务端说能做什么就显示什么**（pay/cancel 来自状态机） -->
    <view v-if="order && (canPay || canCancel || canReorder)" class="od__foot">
      <SnButton v-if="canReorder" type="tex" size="lg" :loading="reordering" @click="reorder">
        再来一单
      </SnButton>
      <SnButton v-if="canCancel" type="sec" size="lg" @click="doCancel">取消订单</SnButton>
      <SnButton v-if="canPay" type="pri" size="lg" @click="goPay">去支付</SnButton>
    </view>
  </view>
</template>

<style>
.od {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  background: var(--paper);
}
.od__scroll {
  flex: 1;
  min-height: 0;
}
.od__skel {
  padding: var(--sp-5) var(--page-x);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.od__block {
  padding: var(--sp-3) var(--page-x) 0;
}
.od__status {
  border-radius: var(--r-md);
  padding: var(--sp-4);
}
.od__status.is-ok {
  background: var(--ok-bg);
}
.od__status.is-warn {
  background: var(--warn-bg);
}
.od__status.is-danger {
  background: var(--danger-bg);
}
.od__status.is-off {
  background: var(--off-bg);
}
.od__statusrow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}
.od__statustext {
  font-size: var(--fs-section);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}
.od__statushint {
  display: block;
  margin-top: var(--sp-2);
  font-size: var(--fs-sub);
  color: var(--ink-700);
  line-height: var(--lh-sub);
}
.od__timer {
  margin-top: var(--sp-2);
  display: flex;
  align-items: baseline;
  gap: var(--sp-1);
}
.od__timerlabel {
  font-size: var(--fs-tag);
  color: var(--ink-500);
}
.od__timerval {
  font-size: var(--fs-card);
  font-weight: var(--fw-semibold);
  color: var(--warn);
}
.od__card {
  background: var(--surface);
  border: var(--bd);
  border-radius: var(--r-md);
  padding: var(--sp-4);
}
.od__addrhead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-2);
}
.od__room {
  font-size: var(--fs-title);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}
.od__bname {
  font-size: var(--fs-sub);
  color: var(--ink-500);
}
.od__shopname {
  display: block;
  font-size: var(--fs-card);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}
.od__line {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-1) 0;
}
.od__linename {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-body);
  color: var(--ink-700);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.od__lineqty {
  font-size: var(--fs-sub);
  color: var(--ink-500);
}
.od__total {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.od__totallabel {
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}
.od__sectiontitle {
  display: block;
  margin-bottom: var(--sp-2);
  font-size: var(--fs-section);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}
.od__tlrow {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) 0;
}
.od__tldot {
  width: 8px;
  height: 8px;
  border-radius: var(--r-full);
  background: var(--brand-500);
  flex: none;
}
.od__tllabel {
  flex: 1;
  font-size: var(--fs-body);
  color: var(--ink-700);
}
.od__tltime {
  font-size: var(--fs-sub);
  color: var(--ink-500);
}
.od__tlnote {
  display: block;
  margin-top: var(--sp-2);
  font-size: var(--fs-tag);
  color: var(--ink-400);
  line-height: var(--lh-tag);
}
.od__pad {
  height: 88px;
}
.od__foot {
  flex: none;
  padding: var(--sp-3) var(--page-x);
  padding-bottom: calc(var(--sp-3) + env(safe-area-inset-bottom));
  background: var(--surface);
  box-shadow: var(--sup);
  display: flex;
  gap: var(--sp-3);
  z-index: var(--z-absorb);
}
/* 底栏按钮均分宽度：单按钮时占满，双按钮时各半 —— 不做固定宽度，
   否则"去支付"和"取消订单"两个长短不一的按钮会空出一块 */
.od__foot > .sn-btn-wrap {
  flex: 1;
  min-width: 0;
}
</style>
