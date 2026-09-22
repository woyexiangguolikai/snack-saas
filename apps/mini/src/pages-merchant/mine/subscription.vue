<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import SnNavBar from '../../components/SnNavBar.vue';
import SnKeyValue from '../../components/SnKeyValue.vue';
import SnStateBlock from '../../components/SnStateBlock.vue';
import SnSkeleton from '../../components/SnSkeleton.vue';
import { useThemeStore } from '../../stores/theme';
import { useMerchantStore } from '../../stores/merchant';
import { useAsync } from '../../composables/useAsync';
import { mapi, type BillingView } from '../../utils/mapi';
import SnNetBanner from '../../components/SnNetBanner.vue';

/**
 * M-07 服务期详情。
 *
 * 这一页只回答三个问题：还能用多久、从哪天到哪天、快到期时谁会提醒我。
 * 刻意**不做续费支付** —— v1 的续费走线下（与充值同一条路），
 * 做一枚"立即续费"按钮却付不了钱，是比不做更糟的体验。
 */
const theme = useThemeStore();
const merchant = useMerchantStore();

const billing = useAsync<BillingView>(() => mapi.billing(1));

onLoad(() => void boot());

async function boot(): Promise<void> {
  const ok = await merchant.ensure();
  if (!ok) return;
  await billing.load();
}

const sub = computed(() => billing.data.value?.subscription ?? null);

/**
 * 已到期（含今天到期）。
 * 到期的第一行**不能**再显示"0 天后到期" —— 那读起来像"还剩 0 天，随时会停"，
 * 而事实是它已经停了。标题直接换成服务端下发的中性标题（§5.4-8）：
 * 「本学期服务期已结束」，正文给恢复条件「续费后即可继续接单」。
 */
const expired = computed(() => sub.value?.daysLeft !== null && (sub.value?.daysLeft ?? 1) <= 0);

function dateText(iso: string | null): string {
  if (!iso) return '—';
  return iso.slice(0, 10);
}

/**
 * 状态枚举 → 人话。
 * 直接把 `status` 印出来，商户会看到「expired」——那是我们的内部枚举，不是他要读的东西。
 */
const STATUS_TEXT: Record<string, string> = {
  active: '正常',
  expiring: '即将到期',
  expired: '已结束',
};

const statusText = computed(() => STATUS_TEXT[sub.value?.status ?? ''] ?? '—');
</script>

<template>
  <view class="ms" :style="theme.themeStyle">
    <SnNavBar title="服务期" />
    <!-- 网络横幅（§5.2：任何情况下可见）—— 导航栏正下方，不遮挡操作 -->
    <SnNetBanner />

    <scroll-view scroll-y class="ms__scroll">
      <view v-if="billing.phase.value === 'loading'" class="ms__skel">
        <SnSkeleton variant="text" />
        <SnSkeleton variant="text" />
      </view>

      <SnStateBlock
        v-else-if="billing.phase.value === 'error'"
        tone="danger"
        glyph="!"
        title="服务期没加载出来"
        :desc="billing.error.value?.message ?? '网络不太顺，这次没取到数据。点「重新加载」再试一次'"
        primary-text="重新加载"
        @primary="billing.reload()"
      />

      <template v-else-if="sub">
        <view class="ms__top">
          <text v-if="expired" class="ms__headline">{{ sub.noticeTitle }}</text>
          <template v-else>
            <text class="ms__days">
              {{ sub.daysLeft === null ? '—' : sub.daysLeft }}
            </text>
            <text class="ms__daysunit">天后到期</text>
          </template>
          <text class="ms__notice">{{ sub.notice }}</text>
        </view>

        <view class="ms__card">
          <SnKeyValue label="起始日期" :value="dateText(sub.periodStart)" value-type="mono" />
          <SnKeyValue label="结束日期" :value="dateText(sub.periodEnd)" value-type="mono" />
          <SnKeyValue label="当前状态" :value="statusText" last />
        </view>

        <view class="ms__card">
          <text class="ms__title">到期提醒</text>
          <text class="ms__desc">
            到期前 15 天、7 天、3 天各提醒一次，通过站内消息送达；
            你在「我的」页的消息入口就能看到。
          </text>
        </view>

        <view class="ms__card">
          <text class="ms__title">如何续期</text>
          <text class="ms__desc">
            续期与充值走同一条线下流程：平台确认后自动延长服务期，无需重新提交审核或发版。
          </text>
        </view>
        <view class="ms__pad" />
      </template>
    </scroll-view>
  </view>
</template>

<style>
.ms {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  background: var(--paper);
}
.ms__scroll {
  flex: 1;
  min-height: 0;
}
.ms__skel {
  padding: var(--sp-5) var(--page-x);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.ms__top {
  margin: var(--sp-3) var(--page-x);
  padding: var(--sp-5) var(--sp-4);
  background: var(--surface);
  border-radius: var(--r-md);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-1);
}
.ms__days {
  font-size: 40px;
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
  line-height: var(--lh-title);
}
/* 已到期时第一行换成标题，字号降一档 —— 它不是"数字"，占那么大反而像在喊 */
.ms__headline {
  font-size: var(--fs-card);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
  line-height: var(--lh-title);
  text-align: center;
}
.ms__daysunit {
  font-size: var(--fs-sub);
  color: var(--ink-500);
}
.ms__notice {
  margin-top: var(--sp-2);
  font-size: var(--fs-sub);
  color: var(--ink-700);
}
.ms__card {
  margin: 0 var(--page-x) var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  background: var(--surface);
  border-radius: var(--r-md);
}
.ms__title {
  display: block;
  font-size: var(--fs-sub);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
  margin-bottom: var(--sp-2);
}
.ms__desc {
  font-size: var(--fs-tag);
  color: var(--ink-500);
  line-height: var(--lh-body);
}
.ms__pad {
  height: var(--sp-6);
}
</style>
