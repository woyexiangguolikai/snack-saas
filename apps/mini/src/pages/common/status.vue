<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import SnNavBar from '../../components/SnNavBar.vue';
import SnStateBlock from '../../components/SnStateBlock.vue';
import { useThemeStore } from '../../stores/theme';
import { api, type OrderGate } from '../../utils/api';
import { goBackOrHome } from '../../utils/ui';

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

/** 「那我现在能做什么」—— 按状态给可行动的补充说明 */
const FALLBACK_DESC: Record<string, string> = {
  closed: '已经过了今天的接单时间。可以先把想买的加进购物车，明天开单后一键下单。',
  building_paused: '本栋今天暂停配送，其他楼栋正常。如果换楼栋下单，收货地址也要一起换。',
  resting: '店铺还没开始今天的接单。可以先把想买的加进购物车，开单后直接结算。',
  subscription_expired: '店铺服务期已结束，商品可以浏览但暂不可下单。可以联系店家了解情况。',
  balance_blocked: '店铺暂时不承接新订单，可以联系店家。已下单的订单不受影响。',
};

const desc = computed(() => {
  if (errText.value) return errText.value;
  const s = gate.value?.state ?? '';
  return FALLBACK_DESC[s] ?? '当前不可下单，稍后再试。';
});

const nextText = computed(() => {
  const n = gate.value?.nextOpenAt;
  return n ? `下次可下单时间 ${n}` : '';
});

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
    <view class="st__body">
      <SnStateBlock
        tone="off"
        glyph="—"
        :title="loading ? '正在确认…' : (gate?.message ?? '当前不可下单')"
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
