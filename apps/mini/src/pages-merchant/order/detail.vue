<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad, onPullDownRefresh } from '@dcloudio/uni-app';
import SnNavBar from '../../components/SnNavBar.vue';
import SnTag from '../../components/SnTag.vue';
import SnButton from '../../components/SnButton.vue';
import SnAmount from '../../components/SnAmount.vue';
import SnKeyValue from '../../components/SnKeyValue.vue';
import SnStateBlock from '../../components/SnStateBlock.vue';
import SnSkeleton from '../../components/SnSkeleton.vue';
import { useThemeStore } from '../../stores/theme';
import { useMerchantStore } from '../../stores/merchant';
import { useAsync } from '../../composables/useAsync';
import { mapi, type MerchantOrderView } from '../../utils/mapi';
import { toast, confirm, pullRefresh } from '../../utils/ui';
import SnNetBanner from '../../components/SnNetBanner.vue';

/**
 * M-02 商户端订单详情。
 *
 * 与学生端详情页两处不同，都不是小事：
 *   ① **数量左置放大** —— 这一页的用途是"照着清单拿货"，不是"确认我买了啥"。
 *      房号 × 商品 × 数量 三列要能一眼扫完，金额反而次要。
 *   ② **动作按钮读 `actions`**，不读 status。服务端状态机改一条边，
 *      这里的按钮就跟着变；前端自己按 status 猜，迟早出现"按钮点了才报错"。
 */
const theme = useThemeStore();
const merchant = useMerchantStore();

const orderNo = ref('');
const busy = ref(false);

const detail = useAsync<{ order: MerchantOrderView }>(() => mapi.orderDetail(orderNo.value));

onLoad((q) => {
  orderNo.value = String((q as { orderNo?: string })?.orderNo ?? '');
  void boot();
});

onPullDownRefresh(() =>
  pullRefresh(async () => {
    await detail.reload();
  }),
);

async function boot(): Promise<void> {
  const ok = await merchant.ensure();
  if (!ok) return;
  await detail.load();
}

const order = computed(() => detail.data.value?.order ?? null);
const can = computed(() => new Set(order.value?.actions ?? []));

async function reload(): Promise<void> {
  await detail.reload();
}

async function doAccept(): Promise<void> {
  await act(() => mapi.accept(orderNo.value), '已接单');
}

/**
 * 标记送达：**不可逆**，所以这里必须有确认（AC-09 的另一半）。
 *
 * 与配送清单不同：那一页是"勾完先折叠、5 秒后才真的提交"，窗口内能撤销，
 * 所以它按 AC-08 走（立即生效 + 撤销，不弹确认）。
 * 这一页点了就**立刻**提交，服务端没有"撤回送达"，因此必须问一句，
 * 而且要说清后果（AC-09 反例："只写确定吗？"）—— 只写"确定吗"等于
 * 让商户在自己不知道后果的情况下做一个改不回来的动作。
 */
async function doDeliver(): Promise<void> {
  const yes = await confirm(
    '标记这一单已送达？',
    `送到 ${order.value?.buildingName ?? ''} ${order.value?.room ?? ''}。标记后学生这一单就结束了，不可撤销。`,
    '标记送达',
  );
  if (!yes) return;
  await act(() => mapi.deliver(orderNo.value), '已送达');
}

async function act(fn: () => Promise<unknown>, okText: string): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await fn();
    toast(okText);
    await reload();
  } catch (e) {
    toast(e instanceof Error ? e.message : '操作没有完成，请重试');
    await reload();
  } finally {
    busy.value = false;
  }
}

function goRefund(): void {
  uni.navigateTo({ url: `/pages-merchant/order/refund?orderNo=${orderNo.value}` });
}

function call(): void {
  const p = order.value?.phone;
  if (!p) return;
  uni.makePhoneCall({ phoneNumber: p });
}

function timeText(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
</script>

<template>
  <view class="od" :style="theme.themeStyle">
    <SnNavBar title="订单详情" />
    <!-- 网络横幅（§5.2：任何情况下可见）—— 导航栏正下方，不遮挡操作 -->
    <SnNetBanner />

    <scroll-view scroll-y class="od__scroll">
      <view v-if="detail.phase.value === 'loading'" class="od__skel">
        <SnSkeleton variant="text" />
        <SnSkeleton variant="text" />
        <SnSkeleton variant="text" />
      </view>

      <SnStateBlock
        v-else-if="detail.phase.value === 'error'"
        tone="danger"
        glyph="!"
        title="订单没加载出来"
        :desc="detail.error.value?.message ?? '网络不太顺，这次没取到数据。点「重新加载」再试一次'"
        primary-text="重新加载"
        @primary="detail.reload()"
      />

      <template v-else-if="order">
        <!-- 状态卡：颜色与文案都来自服务端（AC-11 / D5） -->
        <view class="od__card">
          <view class="od__cardtop">
            <SnTag :tone="order.tone" :label="order.statusText" />
            <text class="od__orderno">{{ order.orderNo }}</text>
          </view>
          <text class="od__hint">{{ order.hint }}</text>
          <!-- 系统兜底送达：商户没点过却看到"已送达"必须知道是谁改的、为什么改，
               否则他会怀疑自己误操作，或认为状态乱跳。这是逐条兜底 R-7 的**用户可见面**。 -->
          <text v-if="order.autoCompleted" class="od__autonote">
            这一单配送超时未点送达，系统已代你标记为已送达，方便对账。你不必再操作。
          </text>
        </view>

        <!-- 送到哪：这三项是送货的全部依据，必须放在一起且够大 -->
        <view class="od__addr">
          <text class="od__bldg">{{ order.buildingName }}</text>
          <text class="od__room">{{ order.room }}</text>
          <text v-if="order.floor" class="od__floor">{{ order.floor }} 层</text>
        </view>

        <view class="od__sec">
          <text class="od__sectitle">商品（照着拿货）</text>
          <view v-for="it in order.items" :key="it.productId" class="od__item">
            <text class="od__qty">×{{ it.qty }}</text>
            <text class="od__name">{{ it.name }}</text>
            <SnAmount :fen="it.amountCents" size="sm" muted />
          </view>
        </view>

        <view class="od__sec">
          <SnKeyValue label="下单时间" :value="timeText(order.createdAt)" value-type="mono" />
          <SnKeyValue label="实付" :fen="order.totalCents" />
          <SnKeyValue label="其中服务费" :fen="order.feeCents" fen-muted />
          <SnKeyValue label="支付流水号" :value="order.payTxnId ?? ''" value-type="mono" empty-reason="未支付" />
          <SnKeyValue label="备注" :value="order.remark ?? ''" empty-reason="无备注" last />
        </view>

        <view class="od__sec" v-if="order.timeline.length">
          <text class="od__sectitle">进展</text>
          <view v-for="t in order.timeline" :key="t.label" class="od__tl">
            <text class="od__tllabel">{{ t.label }}</text>
            <text class="od__tlat">{{ timeText(t.at) }}</text>
          </view>
        </view>

        <!-- 隐私说明：房间号在这里出现是正当的，但也必须说清它只到这一层 -->
        <view class="od__note">
          <text class="od__notetext">
            房间号仅用于本单配送，不会出现在任何报表或平台后台中。
          </text>
        </view>

        <view class="od__pad" />
      </template>
    </scroll-view>

    <view v-if="order" class="od__bar">
      <SnButton v-if="order.phone" size="md" type="sec" @click="call">打电话</SnButton>
      <SnButton
        v-if="can.has('accept')"
        size="md"
        type="pri"
        :loading="busy"
        @click="doAccept"
      >
        接单
      </SnButton>
      <SnButton
        v-if="can.has('deliver')"
        size="md"
        type="pri"
        :loading="busy"
        @click="doDeliver"
      >
        标记送达
      </SnButton>
      <SnButton
        v-if="can.has('refund_start')"
        size="md"
        type="dan"
        @click="goRefund"
      >
        退款处理
      </SnButton>
      <SnButton
        v-if="order.status === 'refunding'"
        size="md"
        type="dan"
        @click="goRefund"
      >
        处理退款
      </SnButton>
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
.od__card {
  margin: var(--sp-3) var(--page-x);
  padding: var(--sp-4);
  background: var(--surface);
  border-radius: var(--r-md);
}
.od__cardtop {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.od__orderno {
  font-size: var(--fs-tag);
  color: var(--ink-400);
}
.od__hint {
  margin-top: var(--sp-2);
  font-size: var(--fs-sub);
  color: var(--ink-700);
}
.od__autonote {
  display: block;
  margin-top: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  font-size: var(--fs-tag);
  color: var(--warn);
  background: var(--warn-bg);
  border-radius: var(--r-sm);
}
.od__addr {
  margin: 0 var(--page-x) var(--sp-3);
  padding: var(--sp-4);
  background: var(--dark-surface);
  border-radius: var(--r-md);
  display: flex;
  align-items: baseline;
  gap: var(--sp-3);
}
.od__bldg {
  font-size: var(--fs-sub);
  color: var(--ink-700);
}
.od__room {
  font-size: 24px;
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}
.od__floor {
  font-size: var(--fs-sub);
  color: var(--ink-500);
}
.od__sec {
  margin: 0 var(--page-x) var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  background: var(--surface);
  border-radius: var(--r-md);
}
.od__sectitle {
  font-size: var(--fs-tag);
  color: var(--ink-400);
  display: block;
  margin-bottom: var(--sp-2);
}
.od__item {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-2) 0;
}
.od__qty {
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
  min-width: 56rpx;
}
.od__name {
  flex: 1;
  font-size: var(--fs-body);
  color: var(--ink-900);
}
.od__tl {
  display: flex;
  justify-content: space-between;
  padding: var(--sp-1) 0;
}
.od__tllabel {
  font-size: var(--fs-sub);
  color: var(--ink-700);
}
.od__tlat {
  font-size: var(--fs-sub);
  color: var(--ink-400);
}
.od__note {
  margin: 0 var(--page-x);
  padding: var(--sp-3);
}
.od__notetext {
  font-size: var(--fs-tag);
  color: var(--ink-400);
  line-height: var(--lh-body);
}
.od__bar {
  flex: none;
  display: flex;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--page-x);
  padding-bottom: calc(var(--sp-3) + env(safe-area-inset-bottom));
  background: var(--surface);
  box-shadow: var(--sup);
}
.od__bar > * {
  flex: 1;
}
.od__pad {
  height: var(--sp-6);
}
</style>
