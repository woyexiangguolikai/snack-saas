<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import SnNavBar from '../../components/SnNavBar.vue';
import SnStateBlock from '../../components/SnStateBlock.vue';
import { useThemeStore } from '../../stores/theme';
import { api, type OrderGate } from '../../utils/api';
import { goBackOrHome } from '../../utils/ui';
import SnNetBanner from '../../components/SnNetBanner.vue';

/**
 * S-17 订单状态页（四种「今天不行」共用一张模板）。
 *
 * AC-02 是这一页的全部意义：
 *   截单 / 停送 / 休息 / 未覆盖 —— 四种情况的**图标、颜色、排版完全一致**，
 *   只有文案不同。因为它们对学生的含义是同一件事：现在下不了单，等会儿再来。
 *   如果按"严重程度"给不同颜色（比如截单红、停送黄），学生会以为店铺出事了，
 *   而实际上明天照常送 —— 这是纯粹的误导。
 *
 * 职责划分（避免文案变成两个真相源）：
 *   · 「为什么不能下单」= 服务端的 message，本页原样显示
 *   · 「那我现在能做什么」= 本页按 state 给出的补充说明
 *   这是两种不同的信息，各管各的，不重复。
 */
const theme = useThemeStore();

const gate = ref<OrderGate | null>(null);
const errText = ref('');
const loading = ref(true);

onLoad(async (query) => {
  const buildingId = Number((query as Record<string, string>)?.buildingId ?? 0);
  if (!buildingId) {
    errText.value = '缺少楼栋参数';
    loading.value = false;
    return;
  }
  try {
    gate.value = await api.gate(buildingId);
  } catch (e) {
    errText.value = e instanceof Error ? e.message : '暂时无法确认能否下单';
  } finally {
    loading.value = false;
  }
});

/**
 * 「今天不行」里有两种状态属于**商户的经营状况**（服务期 / 余额）。
 * 学生不欠我们钱、也替店家充不了值，所以这两种在页面上必须长得一模一样 ——
 * 只要能区分，"这家店快开不下去了"就会顺着界面传出去（§6.5 / AC-13）。
 */
const MERCHANT_STATE_DESC = '店铺暂时没有营业，商品可以浏览；开店后这里就能下单。';

/** 「那我现在能做什么」—— 按状态给可行动的补充说明 */
const FALLBACK_DESC: Record<string, string> = {
  closed: '已经过了今天的接单时间。可以先把想买的加进购物车，明天开单后一键下单。',
  building_paused: '本栋今天暂停配送，其他楼栋正常。如果换楼栋下单，收货地址也要一起换。',
  resting: '店铺还没开始今天的接单。可以先把想买的加进购物车，开单后直接结算。',
  subscription_expired: MERCHANT_STATE_DESC,
  balance_blocked: MERCHANT_STATE_DESC,
};

const desc = computed(() => {
  if (errText.value) return errText.value;
  const s = gate.value?.state ?? '';
  return FALLBACK_DESC[s] ?? '当前不可下单，稍后再试。';
});

/**
 * 标题与恢复时间都由服务端给（AC-02 / §6.4）：
 *   三种"今天做不了"共用同一张模板，差别**只在标题与恢复时间**。
 *   前端拿 message 当标题、自己拼"下次可下单时间"，就等于把同一件事
 *   在四端各写一遍 —— 迟早有一端忘了改。
 */
const title = computed(() => {
  if (errText.value) return '暂时无法确认能否下单';
  return gate.value?.title || '当前不可下单';
});

const nextText = computed(() => gate.value?.recovery ?? '');

async function retry(): Promise<void> {
  loading.value = true;
  errText.value = '';
  try {
    const pages = getCurrentPages();
    const cur = pages[pages.length - 1] as unknown as { options?: { buildingId?: string } };
    const buildingId = Number(cur?.options?.buildingId ?? 0);
    if (buildingId) gate.value = await api.gate(buildingId);
  } catch (e) {
    errText.value = e instanceof Error ? e.message : '暂时无法确认能否下单';
  } finally {
    loading.value = false;
  }
}

function back(): void {
  goBackOrHome();
}
</script>

<template>
  <view class="st" :style="theme.themeStyle">
    <SnNavBar title="下单状态" @back="back" />
    <!-- 网络横幅（§5.2：任何情况下可见）—— 导航栏正下方，不遮挡操作 -->
    <SnNetBanner />
    <view class="st__body">
      <SnStateBlock
        tone="off"
        glyph="—"
        :title="loading ? '正在确认…' : title"
        :desc="loading ? '' : desc"
        :next-text="nextText"
        primary-text="去逛逛别家商品"
        secondary-text="重新确认"
        @primary="back"
        @secondary="retry"
      />
    </view>
  </view>
</template>

<style>
.st {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  background: var(--paper);
}
.st__body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
}
</style>
