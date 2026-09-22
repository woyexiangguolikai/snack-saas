<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad, onPullDownRefresh } from '@dcloudio/uni-app';
import SnNavBar from '../../components/SnNavBar.vue';
import SnAmount from '../../components/SnAmount.vue';
import SnChip from '../../components/SnChip.vue';
import SnStateBlock from '../../components/SnStateBlock.vue';
import SnSkeleton from '../../components/SnSkeleton.vue';
import { useThemeStore } from '../../stores/theme';
import { useMerchantStore } from '../../stores/merchant';
import { useAsync } from '../../composables/useAsync';
import { mapi, type BillingView } from '../../utils/mapi';
import { pullRefresh } from '../../utils/ui';
import SnNetBanner from '../../components/SnNetBanner.vue';

/**
 * M-06 余额明细（CM-07）。
 *
 * 「小票汇总」这四行不是装饰：余额是**逐笔累加**出来的，看得到
 * 期初 → 充值 → 扣费 → 返还 → 当前 这一串，商户才敢相信这个数字；
 * 只给一个当前余额，他只能选择信或不信。
 *
 * 措辞全部走服务端下发的 `walletName / noticeTitle / noticeBody`（COPY 词表），
 * 前端不自己写"余额不足""欠费"这类话 —— 那是禁用词，而且是产品判断不是文案偏好。
 * 标题正文跟着 tone 一起下发，所以"预警"和"已停单"说的不是同一句话的一点变体，
 * 而是两套语气：前者建议充值，后者说清"充值后立即恢复接单"（§5.4-7）。
 */
const theme = useThemeStore();
const merchant = useMerchantStore();

const filter = ref<'all' | 'topup' | 'fee' | 'refund'>('all');
const billing = useAsync<BillingView>(() => mapi.billing(100));

onLoad(() => void boot());
onPullDownRefresh(() =>
  pullRefresh(async () => {
    await billing.reload();
  }),
);

async function boot(): Promise<void> {
  const ok = await merchant.ensure();
  if (!ok) return;
  await billing.load();
}

const wallet = computed(() => billing.data.value?.wallet ?? null);
const txns = computed(() => billing.data.value?.txns ?? []);
const shown = computed(() =>
  filter.value === 'all' ? txns.value : txns.value.filter((t) => t.type === filter.value),
);

/**
 * 小票汇总。
 * 期初是**倒推**出来的：当前余额 − 充值 − 返还 + 扣费（扣费为负，所以是减）。
 * 不倒推就得让服务端多存一个"期初"字段，而它本身也是算出来的 —— 多一个存错的字段。
 */
const summary = computed(() => {
  const topup = txns.value.filter((t) => t.type === 'topup').reduce((s, t) => s + t.amountCents, 0);
  const fee = txns.value.filter((t) => t.type === 'fee').reduce((s, t) => s + t.amountCents, 0);
  const refund = txns.value.filter((t) => t.type === 'refund').reduce((s, t) => s + t.amountCents, 0);
  const now = wallet.value?.balanceCents ?? 0;
  return { topup, fee, refund, now, opening: now - topup - refund - fee };
});

const TYPE_TEXT: Record<string, string> = {
  topup: '充值',
  fee: '服务费扣减',
  refund: '服务费返还',
  adjust: '人工调整',
};

function timeText(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const chips = [
  { key: 'all', label: '全部' },
  { key: 'topup', label: '充值' },
  { key: 'fee', label: '扣费' },
  { key: 'refund', label: '返还' },
] as const;
</script>

<template>
  <view class="mb" :style="theme.themeStyle">
    <SnNavBar title="服务费余额" />
    <!-- 网络横幅（§5.2：任何情况下可见）—— 导航栏正下方，不遮挡操作 -->
    <SnNetBanner />

    <scroll-view scroll-y class="mb__scroll">
      <view v-if="billing.phase.value === 'loading'" class="mb__skel">
        <SnSkeleton variant="text" />
        <SnSkeleton variant="text" />
      </view>

      <SnStateBlock
        v-else-if="billing.phase.value === 'error'"
        tone="danger"
        glyph="!"
        title="余额没加载出来"
        :desc="billing.error.value?.message ?? '网络不太顺，这次没取到数据。点「重新加载」再试一次'"
        primary-text="重新加载"
        @primary="billing.reload()"
      />

      <template v-else-if="wallet">
        <view class="mb__top">
          <text class="mb__label">{{ wallet.walletName }}</text>
          <SnAmount :fen="wallet.balanceCents" size="lg" />
          <text class="mb__warn" :class="wallet.tone === 'danger' ? 'is-danger' : ''">{{ wallet.noticeBody }}</text>
          <text class="mb__guide">
            余额通过线下转账充值，平台确认后自动到账；到账前不影响已接订单的配送。
          </text>
        </view>

        <view class="mb__receipt">
          <view class="mb__line">
            <text class="mb__k">期初</text>
            <SnAmount :fen="summary.opening" size="sm" muted />
          </view>
          <view class="mb__line">
            <text class="mb__k">充值</text>
            <SnAmount :fen="summary.topup" size="sm" signed />
          </view>
          <view class="mb__line">
            <text class="mb__k">服务费扣减</text>
            <SnAmount :fen="summary.fee" size="sm" signed />
          </view>
          <view class="mb__line">
            <text class="mb__k">返还</text>
            <SnAmount :fen="summary.refund" size="sm" signed />
          </view>
          <view class="mb__line mb__line--sum">
            <text class="mb__k">当前</text>
            <SnAmount :fen="summary.now" size="sm" />
          </view>
        </view>

        <view class="mb__chips">
          <SnChip
            v-for="c in chips"
            :key="c.key"
            :label="c.label"
            :selected="filter === c.key"
            @click="filter = c.key"
          />
        </view>

        <SnStateBlock
          v-if="shown.length === 0"
          tone="off"
          glyph="—"
          title="还没有这类流水"
          desc="充值到账或每日扣费后，明细会出现在这里。"
          :primary-text="filter === 'all' ? '' : '查看全部流水'"
          @primary="filter = 'all'"
        />

        <view v-else class="mb__list">
          <view v-for="t in shown" :key="t.id" class="mb__row">
            <view class="mb__rowmain">
              <text class="mb__type">{{ TYPE_TEXT[t.type] ?? t.type }}</text>
              <text class="mb__time">{{ timeText(t.createdAt) }}</text>
              <text v-if="t.refOrderNo" class="mb__ref">单号 {{ t.refOrderNo }}</text>
            </view>
            <view class="mb__rowside">
              <SnAmount :fen="t.amountCents" size="sm" signed />
              <text class="mb__after">余额 {{ (t.balanceAfterCents / 100).toFixed(2) }}</text>
            </view>
          </view>
          <view class="mb__pad" />
        </view>
      </template>
    </scroll-view>
  </view>
</template>

<style>
.mb {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  background: var(--paper);
}
.mb__scroll {
  flex: 1;
  min-height: 0;
}
.mb__skel {
  padding: var(--sp-5) var(--page-x);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.mb__top {
  margin: var(--sp-3) var(--page-x);
  padding: var(--sp-4);
  background: var(--surface);
  border-radius: var(--r-md);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.mb__label {
  font-size: var(--fs-sub);
  color: var(--ink-500);
}
.mb__warn {
  font-size: var(--fs-tag);
  color: var(--ink-500);
  line-height: var(--lh-body);
}
/* 触底（= 真的停了）是唯一需要立刻动手的账本状态，也只有它配红（§6.5）；
   预警线以下仍然用中性灰字 —— 提前提醒不该看起来像报警。 */
.mb__warn.is-danger {
  color: var(--danger);
}
.mb__guide {
  font-size: var(--fs-tag);
  color: var(--ink-400);
  line-height: var(--lh-body);
}
.mb__receipt {
  margin: 0 var(--page-x) var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  background: var(--dark-surface);
  border-radius: var(--r-md);
}
.mb__line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-1) 0;
}
.mb__line--sum {
  margin-top: var(--sp-2);
  padding-top: var(--sp-2);
  border-top: 1rpx solid var(--line-200);
}
.mb__k {
  font-size: var(--fs-sub);
  color: var(--ink-500);
}
.mb__chips {
  display: flex;
  gap: var(--sp-2);
  padding: 0 var(--page-x) var(--sp-3);
}
.mb__list {
  padding: 0 var(--page-x);
}
.mb__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-3);
  background: var(--surface);
  border-radius: var(--r-md);
  margin-bottom: var(--sp-2);
}
.mb__rowmain {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.mb__type {
  font-size: var(--fs-body);
  color: var(--ink-900);
}
.mb__time {
  font-size: var(--fs-tag);
  color: var(--ink-400);
}
.mb__ref {
  font-size: var(--fs-tag);
  color: var(--ink-300);
}
.mb__rowside {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
}
.mb__after {
  font-size: var(--fs-tag);
  color: var(--ink-400);
}
.mb__pad {
  height: var(--sp-6);
}
</style>
