<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import SnStateBlock from '../../components/SnStateBlock.vue';
import { useSessionStore } from '../../stores/session';
import { useThemeStore } from '../../stores/theme';
import { currentAppId } from '../../utils/appid';
import { switchTab, TAB } from '../../utils/ui';

/**
 * S-03 店铺未开通。
 *
 * 这一页存在的理由就是一条硬约束：**AppID 未匹配时绝不白屏**（§2.2）。
 *
 * 它是**业务状态**，不是错误页 —— 这个区别很实际：
 *   · 一个没在你这里开店的 AppID 扫进来，看到"网络错误"会一直重试、
 *     甚至来投诉"你们小程序坏了"。看到"本店尚未开通"他才知道该找谁。
 *   · 所以这里不写"加载失败"，也不给"重试"当主按钮 ——
 *     主按钮是「联系客服」（正确的下一步），次按钮才是「重新加载」。
 *
 * 底部显示 AppID 缩写：学生报障时念一下就能定位是哪家店/哪个小程序，
 * 比"我扫的是那个零食的码"有用得多。缩写而不是全量，是因为没人会念 18 位字符。
 */
const session = useSessionStore();
const theme = useThemeStore();

const appid = ref('');
const checking = ref(false);

onLoad(() => {
  appid.value = currentAppId();
});

const shortAppId = computed(() => {
  const a = appid.value;
  if (!a) return '未取到 AppID';
  return a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
});

const title = computed(() => {
  if (session.notFound) return '本店尚未开通';
  if (session.suspended) return '本店暂停服务';
  return '店铺信息没加载出来';
});

const desc = computed(() => {
  if (session.notFound) {
    return '这个小程序还没有绑定任何店铺。请确认你扫的是店家给你的码；如果你就是店家，请联系我们开通。';
  }
  if (session.suspended) return '本店当前暂停接单。已下单的订单不受影响，可在「我的订单」里查看进度。';
  return session.lastError?.message ?? '网络不太顺，请稍后重试。';
});

/** 重新加载：走一次完整 resolve，成功就回首页。失败则留在本页（本页不会白屏） */
async function reload(): Promise<void> {
  if (checking.value) return;
  checking.value = true;
  const ok = await session.ensureResolved();
  checking.value = false;
  if (ok) {
    switchTab(TAB.home);
    return;
  }
  if (!session.notFound && !session.suspended) {
    uni.showToast({ title: '还是没连上，请稍后再试', icon: 'none' });
  }
}

function contact(): void {
  // 未开通时还没有店铺联系人可找 —— 这里指向平台方（开店咨询）
  uni.showModal({
    title: '联系我们',
    content: `请把下面这串 AppID 发给客服，我们能立刻定位到是哪个小程序：\n${appid.value || '（未取到）'}`,
    showCancel: false,
    confirmText: '复制 AppID',
    success: (r) => {
      if (r.confirm && appid.value) {
        uni.setClipboardData({ data: appid.value });
      }
    },
  });
}
</script>

<template>
  <view class="closed" :style="theme.themeStyle">
    <SnStateBlock
      tone="off"
      glyph="—"
      :title="title"
      :desc="desc"
      primary-text="联系客服"
      secondary-text="重新加载"
      :foot-text="`AppID ${shortAppId}`"
      @primary="contact"
      @secondary="reload"
    />
  </view>
</template>

<style>
.closed {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  background: var(--paper);
  display: flex;
  flex-direction: column;
  justify-content: center;
}
</style>
