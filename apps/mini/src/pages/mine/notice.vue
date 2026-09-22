<script setup lang="ts">
import { ref } from 'vue';
import { onLoad, onPullDownRefresh } from '@dcloudio/uni-app';
import SnNavBar from '../../components/SnNavBar.vue';
import SnSkeleton from '../../components/SnSkeleton.vue';
import SnStateBlock from '../../components/SnStateBlock.vue';
import SnDivider from '../../components/SnDivider.vue';
import { useSessionStore } from '../../stores/session';
import { api, type Notice } from '../../utils/api';
import { switchTab, TAB } from '../../utils/ui';

/**
 * S-13 消息中心（订阅消息的**兜底通道**）。
 *
 * 三条设计决定：
 *  ① **进入即全部标记已读**，但不做延时动画：
 *     学生点进来就是为了看消息，全标是最符合直觉的；
 *     红点用服务端返回的 marked 数精确回退，而不是本地自己减。
 *  ② **上拉不分页**——消息是低频、短量的（一天顶多几条），
 *     做分页只会让人翻不到底还在转圈。
 *  ③ 每条消息都带 orderNo，**能点就点进去**：
 *     学生收到"已送达"最想做的是确认哪一单，而不是读完回列表自己找。
 */
const session = useSessionStore();

const items = ref<Notice[]>([]);
const loading = ref(true);
const errText = ref('');

async function load(): Promise<void> {
  loading.value = true;
  errText.value = '';
  try {
    const r = await api.notices(50);
    items.value = r.items;
    loading.value = false;
    // 进来即全部标为已读 —— 学生点进来就是为了"把消息处理掉"，
    // 保留"点开才已读"只会让红点永远消不掉。
    if (r.unread > 0) {
      await api.markRead();
      session.setUnread(0);
      for (const n of items.value) n.readAt = n.readAt ?? new Date().toISOString();
    }
  } catch (e) {
    errText.value = e instanceof Error ? e.message : '消息没加载出来';
    loading.value = false;
  }
}

onLoad(() => {
  void load();
});

onPullDownRefresh(async () => {
  await load();
  uni.stopPullDownRefresh();
});

/** 轻重 PTS-语义色：交付=ok，退款相关=warn，关闭=off。与订单状态卡保持同一套语言（AC-11） */
function toneOf(t: Notice['type']): 'ok' | 'warn' | 'off' {
  if (t === 'delivered') return 'ok';
  if (t === 'refund_done' || t === 'refund_rejected') return 'warn';
  return 'off';
}

function glyphOf(t: Notice['type']): string {
  return { paid: '付', accepted: '接', delivered: '达', closed: '关', refund_done: '退', refund_rejected: '留' }[t];
}

function openOrder(n: Notice): void {
  if (!n.orderNo) return;
  uni.navigateTo({ url: `/pages/order/detail?orderNo=${n.orderNo}` });
}

function back(): void {
  const pages = getCurrentPages();
  if (pages.length > 1) uni.navigateBack();
  else switchTab(TAB.mine);
}
</script>

<template>
  <view class="nt">
    <SnNavBar title="消息" @back="back" />

    <scroll-view scroll-y class="nt__scroll">
      <view v-if="loading" class="nt__skel">
        <SnSkeleton variant="text" />
        <SnSkeleton variant="text" />
        <SnSkeleton variant="text" />
      </view>

      <SnStateBlock
        v-else-if="errText"
        tone="danger"
        glyph="!"
        title="消息没打开"
        :desc="errText"
        primary-text="重新加载"
        @primary="load()"
      />

      <template v-else-if="items.length">
        <view class="nt__list">
          <view
            v-for="n in items"
            :key="n.id"
            class="nt__row"
            :class="{ 'is-unread': n.readAt === null }"
            @click="openOrder(n)"
          >
            <view class="nt__glyph" :class="'is-' + toneOf(n.type)">
              <text>{{ glyphOf(n.type) }}</text>
            </view>
            <view class="nt__main">
              <view class="nt__head">
                <text class="nt__title">{{ n.title }}</text>
                <text class="nt__time num">{{ n.createdAt }}</text>
              </view>
              <text class="nt__body">{{ n.body }}</text>
              <text v-if="n.orderNo" class="nt__more">查看订单 ›</text>
            </view>
            <view v-if="n.readAt === null" class="nt__dot" />
          </view>
        </view>
        <SnDivider space="md" />
        <text class="nt__foot">只保留最近 50 条。订单进展以站内消息为准，微信推送可能收不到。</text>
      </template>

      <view v-else class="nt__empty">
        <text class="nt__emptytitle">还没有消息</text>
        <text class="nt__emptydesc">下单之后，订单进展会同步到这里。</text>
      </view>
    </scroll-view>
  </view>
</template>

<style>
.nt {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  background: var(--paper);
}
.nt__scroll {
  flex: 1;
  min-height: 0;
}
.nt__skel {
  padding: var(--sp-5) var(--page-x);
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.nt__list {
  padding: var(--sp-3) var(--page-x) 0;
}
.nt__row {
  position: relative;
  display: flex;
  gap: var(--sp-3);
  padding: var(--sp-4);
  border-radius: var(--r-md);
  background: var(--surface);
  margin-bottom: var(--sp-2);
}
.nt__row.is-unread {
  background: var(--brand-50);
}
.nt__glyph {
  flex: none;
  width: 76rpx;
  height: 76rpx;
  border-radius: var(--r-full);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-tag);
  font-weight: var(--fw-semibold);
}
.nt__glyph.is-ok {
  background: var(--ok-bg);
  color: var(--ok);
}
.nt__glyph.is-warn {
  background: var(--warn-bg);
  color: var(--warn);
}
.nt__glyph.is-off {
  background: var(--off-bg);
  color: var(--off);
}
.nt__main {
  flex: 1;
  min-width: 0;
}
.nt__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-2);
}
.nt__title {
  font-size: var(--fs-card);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}
.nt__time {
  flex: none;
  font-size: var(--fs-tag);
  color: var(--ink-300);
}
.nt__body {
  display: block;
  margin-top: var(--sp-1);
  font-size: var(--fs-tag);
  color: var(--ink-500);
  line-height: var(--lh-body);
}
.nt__more {
  display: block;
  margin-top: var(--sp-2);
  font-size: var(--fs-tag);
  color: var(--brand-500);
}
.nt__dot {
  flex: none;
  width: 16rpx;
  height: 16rpx;
  border-radius: var(--r-full);
  background: var(--brand-500);
  margin-top: var(--sp-2);
}
.nt__empty {
  padding: var(--sp-8) var(--page-x);
  text-align: center;
}
.nt__emptytitle {
  display: block;
  font-size: var(--fs-title);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}
.nt__emptydesc {
  display: block;
  margin-top: var(--sp-2);
  font-size: var(--fs-tag);
  color: var(--ink-500);
}
.nt__foot {
  display: block;
  padding: 0 var(--page-x) var(--sp-6);
  font-size: var(--fs-tag);
  color: var(--ink-300);
  line-height: var(--lh-body);
}
</style>
