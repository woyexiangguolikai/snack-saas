<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import SnNavBar from '../../components/SnNavBar.vue';
import SnButton from '../../components/SnButton.vue';
import SnAmount from '../../components/SnAmount.vue';
import SnKeyValue from '../../components/SnKeyValue.vue';
import SnInput from '../../components/SnInput.vue';
import SnStateBlock from '../../components/SnStateBlock.vue';
import SnSkeleton from '../../components/SnSkeleton.vue';
import { useThemeStore } from '../../stores/theme';
import { useMerchantStore } from '../../stores/merchant';
import { useAsync } from '../../composables/useAsync';
import { mapi, type MerchantOrderView } from '../../utils/mapi';
import { toast, confirm } from '../../utils/ui';
import SnNetBanner from '../../components/SnNetBanner.vue';

/**
 * M-09 退款处理（CM-08）。
 *
 * 三条不能省：
 *   ① **拒绝必须填理由** —— 学生看到"已拒绝"却不知道为什么，下一步就是来店里吵。
 *      理由写清楚，这单才真的结束。
 *   ② **金额默认全额、可以改**：部分退款是常态（多件里退一件），
 *      但不给默认值就会有人填错成 0 或填成整单。
 *   ③ **必须写明"未送达会自动回库、服务费一并返还"**：
 *      商户最担心的是"钱退了货也没了"，这句不写他就不敢点同意。
 */
const theme = useThemeStore();
const merchant = useMerchantStore();

const orderNo = ref('');
const step = ref<'decide' | 'amount'>('decide');
const amountYuan = ref('');
const rejectReason = ref('');
const busy = ref(false);

const detail = useAsync<{ order: MerchantOrderView }>(() => mapi.orderDetail(orderNo.value));

onLoad((q) => {
  orderNo.value = String((q as { orderNo?: string })?.orderNo ?? '');
  void boot();
});

async function boot(): Promise<void> {
  const ok = await merchant.ensure();
  if (!ok) return;
  await detail.load();
  const o = detail.data.value?.order;
  if (o) amountYuan.value = (o.totalCents / 100).toFixed(2);
}

const order = computed(() => detail.data.value?.order ?? null);
const can = computed(() => new Set(order.value?.actions ?? []));

const refundCents = computed(() => {
  const n = Number(amountYuan.value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100);
});

const amountError = computed(() => {
  if (!amountYuan.value) return '请填写退款金额';
  if (refundCents.value <= 0) return '退款金额必须大于 0';
  if (order.value && refundCents.value > order.value.totalCents) return '不能超过本单实付金额';
  return '';
});

async function onAgree(): Promise<void> {
  const o = order.value;
  if (!o) return;
  // 尚未发起 → 先发起退款（这一步只是把订单置为"退款中"，钱还没动）
  if (can.value.has('refund_start')) {
    const yes = await confirm('为这一单发起退款？', '发起后订单进入退款中，你可以继续完成退款或驳回。', '发起退款');
    if (!yes) return;
    await run(() => mapi.refundStart(orderNo.value), '已进入退款中，请继续完成退款');
    return;
  }
  step.value = 'amount';
}

async function onConfirmRefund(): Promise<void> {
  if (amountError.value) {
    toast(amountError.value);
    return;
  }
  const yes = await confirm(
    '确认已退款给学生？',
    '确认后本单结束：未送达的部分会自动回到库存，本单服务费一并返还。',
    '确认已退款',
  );
  if (!yes) return;
  await run(() => mapi.refundDone(orderNo.value, refundCents.value), '退款已完成');
}

async function onReject(): Promise<void> {
  const reason = rejectReason.value.trim();
  if (!reason) {
    toast('请填写拒绝理由，学生会看到它');
    return;
  }
  const yes = await confirm('驳回这一笔退款？', `理由：${reason}。驳回后订单回到退款前的状态。`, '驳回退款');
  if (!yes) return;
  await run(() => mapi.refundReject(orderNo.value), '已驳回，订单回到退款前状态');
}

async function run(fn: () => Promise<unknown>, okText: string): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await fn();
    toast(okText);
    await detail.reload();
    step.value = 'decide';
  } catch (e) {
    toast(e instanceof Error ? e.message : '操作没有完成，请重试');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <view class="rf" :style="theme.themeStyle">
    <SnNavBar title="退款处理" />
    <!-- 网络横幅（§5.2：任何情况下可见）—— 导航栏正下方，不遮挡操作 -->
    <SnNetBanner />

    <scroll-view scroll-y class="rf__scroll">
      <view v-if="detail.phase.value === 'loading'" class="rf__skel">
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
        <view class="rf__card">
          <SnKeyValue label="订单号" :value="order.orderNo" value-type="mono" />
          <SnKeyValue label="送到" :value="`${order.buildingName} ${order.room}`" value-type="mono" />
          <SnKeyValue label="实付" :fen="order.totalCents" />
          <SnKeyValue label="其中服务费" :fen="order.feeCents" fen-muted />
          <SnKeyValue label="当前状态" :value="order.statusText" last />
        </view>

        <!-- 影响说明：不写这句，商户会以为"退了钱还得赔货" -->
        <view class="rf__note">
          <text class="rf__notetext">
            同意退款后：未送达的部分会自动回到对应楼栋的库存，本单服务费一并返还。
            已送达的商品不会回库。
          </text>
        </view>

        <view v-if="step === 'amount'" class="rf__card">
          <SnInput
            v-model="amountYuan"
            label="退款金额"
            type="digit"
            placeholder="如 12.00"
            :error="amountError && amountYuan ? amountError : ''"
            helper="单位：元。默认按本单实付全额"
          />
          <view class="rf__preview">
            <text class="rf__previewtext">本次退款</text>
            <SnAmount :fen="refundCents" size="md" />
          </view>
        </view>

        <view class="rf__card" v-if="can.has('refund_reject')">
          <SnInput
            v-model="rejectReason"
            label="拒绝理由"
            type="textarea"
            placeholder="如：商品已送达且无质量问题"
            helper="学生会在订单详情里看到这段话"
          />
        </view>

        <view class="rf__pad" />
      </template>
    </scroll-view>

    <view v-if="order" class="rf__bar">
      <template v-if="step === 'amount'">
        <SnButton size="md" type="sec" @click="step = 'decide'">返回</SnButton>
        <SnButton size="md" type="pri" :loading="busy" @click="onConfirmRefund">确认已退款</SnButton>
      </template>
      <template v-else>
        <SnButton
          v-if="can.has('refund_start') || can.has('refund_done')"
          size="md"
          type="pri"
          :loading="busy"
          @click="onAgree"
        >
          {{ can.has('refund_start') ? '发起退款' : '同意退款' }}
        </SnButton>
        <SnButton
          v-if="can.has('refund_reject')"
          size="md"
          type="dan"
          :loading="busy"
          @click="onReject"
        >
          驳回
        </SnButton>
      </template>
    </view>
  </view>
</template>

<style>
.rf {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  background: var(--paper);
}
.rf__scroll {
  flex: 1;
  min-height: 0;
}
.rf__skel {
  padding: var(--sp-5) var(--page-x);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.rf__card {
  margin: var(--sp-3) var(--page-x);
  padding: var(--sp-3) var(--sp-4);
  background: var(--surface);
  border-radius: var(--r-md);
}
.rf__note {
  margin: 0 var(--page-x) var(--sp-3);
  padding: var(--sp-3);
  background: var(--info-bg);
  border-radius: var(--r-md);
}
.rf__notetext {
  font-size: var(--fs-tag);
  color: var(--ink-700);
  line-height: var(--lh-body);
}
.rf__preview {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-3) 0 0;
}
.rf__previewtext {
  font-size: var(--fs-sub);
  color: var(--ink-500);
}
.rf__bar {
  flex: none;
  display: flex;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--page-x);
  padding-bottom: calc(var(--sp-3) + env(safe-area-inset-bottom));
  background: var(--surface);
  box-shadow: var(--sup);
}
.rf__bar > * {
  flex: 1;
}
.rf__pad {
  height: var(--sp-6);
}
</style>
