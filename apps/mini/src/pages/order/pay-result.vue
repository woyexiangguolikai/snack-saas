<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad, onUnload } from '@dcloudio/uni-app';
import SnNavBar from '../../components/SnNavBar.vue';
import SnAmount from '../../components/SnAmount.vue';
import SnButton from '../../components/SnButton.vue';
import SnDivider from '../../components/SnDivider.vue';
import { useThemeStore } from '../../stores/theme';
import { useSessionStore } from '../../stores/session';
import { api, type StudentOrder } from '../../utils/api';
import { useCountdown } from '../../composables/useCountdown';
import { switchTab, TAB } from '../../utils/ui';
import { pushAvailable, requestPushGrant } from '../../utils/push';
import SnNetBanner from '../../components/SnNetBanner.vue';

/**
 * S-12 支付中转 / 结果页 —— **四种状态一个都不能少**。
 *
 * 为什么「处理中」是最关键的那个状态（原型里专门写明的一条）：
 *   学生点了支付，微信那边扣款成功了，但我们的回调还没到（微信通知有延迟，
 *   或者网络抖动）。此时如果只给"成功 / 失败"两态，我们会把它判成失败，
 *   然后学生看到"支付失败"就**再点一次支付** —— 重复付款。
 *   正确做法是给一个"处理中 + 订单已保留 + 稍后自动确认"，把学生的动作
 *   从"重付"改成"等待/刷新"。
 *
 * 判定永远以**服务端订单状态**为准，不以 "requestPayment 的返回值"为准：
 * requestPayment 成功只说明"微信受理了"，不等于"我们的订单已入账"。
 */
const theme = useThemeStore();
const session = useSessionStore();

type Phase = 'transit' | 'success' | 'fail' | 'pending';

const phase = ref<Phase>('transit');
const orderNo = ref('');
/**
 * 订单详情（含房间号）。
 *
 * 成功态必须把「送到哪」写出来（订单号 + 送到哪 + 下一步，三件缺一不可）：
 *   学生在这一屏唯一想确认的事就是"我付的这一单，是不是送到我这儿"。
 *   只给金额不给地址，他就得跳去订单详情再确认一次 —— 而很多人不会跳，
 *   他们会带着"不确定"离开，然后在半小时后打电话问店家。
 */
const order = ref<(StudentOrder & { room: string }) | null>(null);
const failReason = ref('');
const hint = ref('');
const payParams = ref<Record<string, string> | null>(null);
const devSimulate = ref(false);
const busy = ref(false);

/** 支付倒计时（服务端给的剩余秒数；判定仍在服务端） */
const paySeconds = ref<number | null>(null);
const { text: payText } = useCountdown(paySeconds, () => {
  // 到点不在本地改状态，去问服务端（可能已经超时关单）
  void refresh();
});

let pollTimer: ReturnType<typeof setInterval> | null = null;

onLoad((query) => {
  orderNo.value = String((query as Record<string, string>)?.orderNo ?? '');
  if (!orderNo.value) {
    phase.value = 'fail';
    failReason.value = '缺少订单号';
    return;
  }
  void start();
});

onUnload(() => stopPoll());

function stopPoll(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** 轮询等待回调落账。间隔 2s、最多 10 次（约 20 秒）—— 超过就交给"处理中"状态 */
function startPoll(): void {
  stopPoll();
  let n = 0;
  pollTimer = setInterval(async () => {
    n += 1;
    const done = await refresh();
    if (done || n >= 10) stopPoll();
  }, 2_000);
}

async function start(): Promise<void> {
  phase.value = 'transit';
  const ok = await refresh();
  if (ok) return;

  // 还是待支付 → 尝试发起支付
  if (order.value?.status !== 'pending_pay') return;
  try {
    const info = await api.payInfo(orderNo.value);
    paySeconds.value = info.payExpiresInSeconds;
    devSimulate.value = info.devSimulateAvailable;

    if (!info.configured || !info.payParams) {
      // 未接入微信支付 —— 这是正常的中间状态，不是失败
      phase.value = 'pending';
      hint.value = info.hint;
      return;
    }

    payParams.value = info.payParams;
    invokePay();
  } catch (e) {
    phase.value = 'fail';
    failReason.value = e instanceof Error ? e.message : '支付没有发起成功';
  }
}

/** 调起微信支付 */
function invokePay(): void {
  const p = payParams.value;
  if (!p) return;
  busy.value = true;
  uni.requestPayment({
    provider: 'wxpay',
    timeStamp: p.timeStamp,
    nonceStr: p.nonceStr,
    package: p.package,
    signType: (p.signType as 'MD5' | 'HMAC-SHA256' | 'RSA') ?? 'RSA',
    paySign: p.paySign,
    success: () => {
      // ⚠️ 这里**不能**直接判成功。微信受理 ≠ 我们入账。
      // 所以转为"等待回调落账"，用服务端订单状态来定论。
      busy.value = false;
      phase.value = 'transit';
      startPoll();
    },
    fail: (e) => {
      busy.value = false;
      const msg = String((e as { errMsg?: string })?.errMsg ?? '');
      // 用户主动取消不是"失败"，也不该写红字吓人
      if (msg.includes('cancel')) {
        phase.value = 'pending';
        hint.value = '支付已取消。订单仍为你保留，可随时继续支付。';
        return;
      }
      phase.value = 'fail';
      failReason.value = '微信支付没有完成';
    },
  });
}

/**
 * 拉一次订单状态并更新页面。
 * @returns 是否已经"定论"（成功 或 已关闭）—— 定论后不需要再轮询
 */
async function refresh(): Promise<boolean> {
  try {
    const d = await api.orderDetail(orderNo.value);
    order.value = d;
    if (d.status === 'pending_pay') return false;

    if (d.status === 'cancelled') {
      phase.value = 'fail';
      failReason.value = '订单已超时关闭。如果已经付款，款项会原路退回。';
      return true;
    }
    // pending_accept / delivering / delivered / refunding / refunded 都说明钱已收到
    phase.value = 'success';
    void askPushGrant(orderNo.value);
    return true;
  } catch (e) {
    // 刷新失败不改判定：可能只是网络抖，保持"处理中"让学生刷新
    hint.value = e instanceof Error ? e.message : '暂时查不到订单状态';
    return false;
  }
}

/**
 * 支付成功后**顺势**申请一次订阅消息授权。
 *
 * 时机为什么放在这里：学生刚付完钱，是唯一一个"确实想知道订单进展"的时刻。
 * 放在首页冷启动弹，他会当成骚扰；放在这里，他理解这是在问"要不要通知我"。
 *
 * 未配置模板 ID 时整个函数直接跳过 —— 不弹、不报错、不影响任何东西。
 */
async function askPushGrant(no: string): Promise<void> {
  if (!pushAvailable()) return;
  const grants = await requestPushGrant();
  if (!grants) return;
  await api.reportSubscriptions(no, grants);
}

async function retry(): Promise<void> {
  if (busy.value) return;
  await start();
}

async function simulate(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await api.simulatePay(orderNo.value);
    await refresh();
  } catch (e) {
    failReason.value = e instanceof Error ? e.message : '模拟支付没有成功';
    phase.value = 'fail';
  } finally {
    busy.value = false;
  }
}

function gotoTicket(): void {
  uni.redirectTo({ url: `/pages/order/detail?orderNo=${orderNo.value}` });
}

function gotoShopping(): void {
  switchTab(TAB.home);
}

function gotoOrders(): void {
  switchTab(TAB.orders);
}

/** 小票上的“还剩多少秒”只做展示，超时判定仍由服务端关单任务完成 */
const showTimer = computed(() => phase.value === 'pending' && paySeconds.value !== null);
</script>

<template>
  <view class="pr" :style="theme.themeStyle">
    <SnNavBar :title="phase === 'success' ? '支付结果' : '支付'" @back="gotoOrders" />
    <!-- 网络横幅（§5.2：任何情况下可见）—— 导航栏正下方，不遮挡操作 -->
    <SnNetBanner />

    <view class="pr__body">
      <!-- 中转：转圈 + 订单号 + 应付 + 查看订单 -->
      <view v-if="phase === 'transit'" class="pr__center">
        <view class="pr__spin sn-spin" />
        <text class="pr__title">正在确认支付结果</text>
        <text class="pr__desc">请不要关闭页面，通常几秒内完成</text>

        <view class="pr__kv">
          <text class="pr__k">订单号</text>
          <text class="pr__v num">{{ orderNo }}</text>
        </view>
        <view class="pr__kv">
          <text class="pr__k">应付</text>
          <SnAmount :fen="order?.totalCents ?? 0" size="md" />
        </view>
        <view class="pr__acts">
          <SnButton type="sec" block @click="gotoOrders">查看订单</SnButton>
        </view>
      </view>

      <!-- 成功：绿圈 + 小票 + 双按钮 -->
      <view v-else-if="phase === 'success'" class="pr__center">
        <view class="pr__icon is-ok"><text>✓</text></view>
        <text class="pr__title">支付成功</text>
        <text class="pr__desc">店家会尽快接单，可在订单里看进度</text>

        <view class="pr__receipt">
          <view class="pr__kv">
            <text class="pr__k">订单号</text>
            <text class="pr__v num">{{ orderNo }}</text>
          </view>
          <SnDivider dashed space="sm" />
          <!-- 「送到哪」与「商户」：学生可核对的两件事（设计稿要求的三要素之二） -->
          <view class="pr__kv">
            <text class="pr__k">商户</text>
            <text class="pr__v">{{ session.shopName || '本店' }}</text>
          </view>
          <view class="pr__kv">
            <text class="pr__k">送到</text>
            <text class="pr__v">{{ order?.buildingName }}{{ order?.room ? ' · ' + order.room : '' }}</text>
          </view>
          <SnDivider dashed space="sm" />
          <view v-for="(it, i) in order?.items ?? []" :key="i" class="pr__line">
            <text class="pr__linename">{{ it.name }}</text>
            <text class="pr__lineqty num">×{{ it.qty }}</text>
          </view>
          <SnDivider dashed space="sm" />
          <view class="pr__kv pr__kv--total">
            <text class="pr__k">实付</text>
            <SnAmount :fen="order?.totalCents ?? 0" size="lg" />
          </view>
        </view>

        <!-- 预期管理：微信订阅消息**只能发一条**，学生不会看到每一步状态。
             不写这句，学生会以为"每一步都会收到通知"，然后在没收到时来问。 -->
        <text class="pr__desc">送达后你会收到一条通知</text>

        <view class="pr__acts">
          <SnButton type="pri" block @click="gotoTicket">查看订单</SnButton>
          <SnButton type="tex" block @click="gotoShopping">继续逛逛</SnButton>
        </view>
      </view>

      <!-- 失败：红圈 + 原因 + 重付 -->
      <view v-else-if="phase === 'fail'" class="pr__center">
        <view class="pr__icon is-danger"><text>×</text></view>
        <text class="pr__title">支付没有完成</text>
        <text class="pr__desc">{{ failReason }}</text>

        <view class="pr__acts">
          <SnButton type="pri" block :loading="busy" loading-text="处理中" @click="retry">重新支付</SnButton>
          <SnButton type="tex" block @click="gotoOrders">查看订单</SnButton>
        </view>
      </view>

      <!-- 处理中：琥珀 + 订单保留声明 + 刷新状态（**这一态的存在就是为了防止重复付款**） -->
      <view v-else class="pr__center">
        <view class="pr__icon is-warn"><text>⏳</text></view>
        <text class="pr__title">支付结果待确认</text>
        <text class="pr__desc">{{ hint || '订单已为你保留，稍后会自动确认。' }}</text>

        <view v-if="showTimer" class="pr__timer">
          <text class="pr__timerlabel">剩余可支付时间</text>
          <text class="pr__timerval num">{{ payText }}</text>
        </view>

        <view class="pr__kv">
          <text class="pr__k">状态</text>
          <text class="pr__v">{{ order?.statusText ?? '待付款' }}</text>
        </view>
        <view class="pr__kv">
          <text class="pr__k">订单号</text>
          <text class="pr__v num">{{ orderNo }}</text>
        </view>
        <view class="pr__kv">
          <text class="pr__k">应付</text>
          <SnAmount :fen="order?.totalCents ?? 0" size="md" />
        </view>

        <view class="pr__acts">
          <SnButton type="pri" block :loading="busy" loading-text="查询中" @click="refresh">刷新状态</SnButton>
          <!-- 这个按钮只在服务端明确说“本环境开放模拟支付”时出现。
               是否显示由服务端决定，前端不自己读环境变量 —— 否则就成了
               “前端决定要不要显示一个绕过支付的按钮”。 -->
          <SnButton v-if="devSimulate" type="sec" block @click="simulate">
            模拟支付成功（开发用）
          </SnButton>
          <SnButton type="tex" block @click="gotoOrders">查看订单</SnButton>
        </view>
      </view>
    </view>
  </view>
</template>

<style>
.pr {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  background: var(--paper);
}
.pr__body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.pr__center {
  height: 100%;
  padding: var(--sp-8) var(--page-x);
  display: flex;
  flex-direction: column;
  align-items: center;
}
.pr__spin {
  width: 32px;
  height: 32px;
  border-width: 3px;
  color: var(--brand-500);
}
.pr__icon {
  width: 58px;
  height: 58px;
  border-radius: var(--r-full);
  display: flex;
  align-items: center;
  justify-content: center;
}
.pr__icon.is-ok {
  background: var(--ok-bg);
}
.pr__icon.is-ok text {
  color: var(--ok);
  font-size: 26px;
  font-weight: var(--fw-semibold);
}
.pr__icon.is-warn {
  background: var(--warn-bg);
}
.pr__icon.is-warn text {
  color: var(--warn);
  font-size: 24px;
}
.pr__icon.is-danger {
  background: var(--danger-bg);
}
.pr__icon.is-danger text {
  color: var(--danger);
  font-size: 28px;
  font-weight: var(--fw-semibold);
}
.pr__title {
  margin-top: var(--sp-5);
  font-size: var(--fs-section);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}
.pr__desc {
  margin-top: var(--sp-2);
  font-size: var(--fs-body);
  color: var(--ink-500);
  text-align: center;
  line-height: var(--lh-body);
}
.pr__timer {
  margin-top: var(--sp-4);
  padding: var(--sp-2) var(--sp-4);
  border-radius: var(--r-md);
  background: var(--warn-bg);
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.pr__timerlabel {
  font-size: var(--fs-sub);
  color: var(--warn);
}
.pr__timerval {
  font-size: var(--fs-card);
  font-weight: var(--fw-semibold);
  color: var(--warn);
}
.pr__kv {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-2) 0;
}
.pr__kv--total {
  padding-top: var(--sp-2);
}
.pr__k {
  font-size: var(--fs-body);
  color: var(--ink-700);
}
.pr__v {
  font-size: var(--fs-sub);
  color: var(--ink-700);
}
.pr__receipt {
  width: 100%;
  margin-top: var(--sp-5);
  padding: var(--sp-4);
  background: var(--surface);
  border: var(--bd);
  border-radius: var(--r-md);
}
.pr__line {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 2px 0;
}
.pr__linename {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-sub);
  color: var(--ink-700);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.pr__lineqty {
  font-size: var(--fs-tag);
  color: var(--ink-500);
}
.pr__acts {
  width: 100%;
  margin-top: var(--sp-6);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
</style>
