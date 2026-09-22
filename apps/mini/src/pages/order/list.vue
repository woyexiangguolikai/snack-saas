<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad, onPullDownRefresh, onShow } from '@dcloudio/uni-app';
import SnNavBar from '../../components/SnNavBar.vue';
import SnSegmented from '../../components/SnSegmented.vue';
import SnOrderCard from '../../components/SnOrderCard.vue';
import SnStateBlock from '../../components/SnStateBlock.vue';
import SnPageSkeleton from '../../components/SnPageSkeleton.vue';
import { useThemeStore } from '../../stores/theme';
import { useSessionStore } from '../../stores/session';
import { useAsync } from '../../composables/useAsync';
import { api, type StudentOrder } from '../../utils/api';
import { toast, confirm, switchTab, TAB, pullRefresh } from '../../utils/ui';

/**
 * S-13 订单列表。
 *
 * 三个决定：
 *  ① **分区与计数由服务端给**（见 order.service 的 ONGOING/DONE_STATUSES）。
 *     前端自己按 status 分组的话，状态机新增状态时会掉进"两栏都看不见"的黑洞。
 *  ② **待支付倒计时只做展示**（卡片内部），到点去问服务端 ——
 *     本地把单判成"已关闭"会让服务端超时关单任务和前端显示打架。
 *  ③ 从支付结果页/详情页回来时 `onShow` 强制刷新：
 *     刚支付完的那一刻回来，如果还显示"待支付"会让学生以为没付上，进而重复支付。
 */
const theme = useThemeStore();
const session = useSessionStore();

const seg = ref<'ongoing' | 'done'>('ongoing');
const needLogin = ref(false);

const list = useAsync<{ items: StudentOrder[]; counts: { ongoing: number; done: number; all: number } }>(
  () => api.orders(seg.value),
);

onLoad(() => {
  void boot();
});

onShow(() => {
  // 只在下单/支付后需要刷新，但判断"是不是从支付回来"很容易做错；
  // 订单列表刷新成本很低（一次查询），直接每次都刷更可靠。
  if (session.resolved && !needLogin.value) void list.reload();
});

async function boot(): Promise<void> {
  await session.ensureResolved();
  const logged = await session.ensureLogin();
  if (!logged) {
    needLogin.value = true;
    return;
  }
  needLogin.value = false;
  await list.load();
}

onPullDownRefresh(() =>
  pullRefresh(async () => {
    await list.reload();
  }),
);

const counts = computed(() => list.data.value?.counts ?? { ongoing: 0, done: 0, all: 0 });

/** 另一个分栏里有几单 —— 空态文案与"直达"按钮都靠它，不另取一次数据 */
const otherCount = computed(() => (seg.value === 'ongoing' ? counts.value.done : counts.value.ongoing));
const otherLabel = computed(() => (seg.value === 'ongoing' ? '已结束' : '进行中'));
const emptyDesc = computed(() => {
  if (otherCount.value > 0) {
    return `${otherLabel.value}里还有 ${otherCount.value} 单，不在这一栏。`;
  }
  return seg.value === 'ongoing'
    ? '下单后还没走完流程的订单会出现在这里，方便你随时看进度。'
    : '已送达、已取消、已退款的订单会归档到这里。';
});

const segOptions = computed(() => [
  { value: 'ongoing', label: '进行中', count: counts.value.ongoing },
  { value: 'done', label: '已结束', count: counts.value.done },
]);

function onSeg(v: string): void {
  seg.value = v === 'done' ? 'done' : 'ongoing';
  void list.load();
}

function goPay(orderNo: string): void {
  uni.navigateTo({ url: `/pages/order/pay-result?orderNo=${orderNo}` });
}

function goDetail(orderNo: string): void {
  uni.navigateTo({ url: `/pages/order/detail?orderNo=${orderNo}` });
}

async function doCancel(orderNo: string): Promise<void> {
  // 取消前问一句：已下单的预占是真实的库存，误取消会放走别人。
  // 但文案要克制 —— 这是"提醒"，不是"警告"。
  const yes = await confirm('取消这一单？', '取消后需要重新下单，库存会释放给其他同学。', '取消订单');
  if (!yes) return;
  try {
    await api.cancelOrder(orderNo, '学生取消');
    toast('订单已取消');
    await list.reload();
  } catch (e) {
    toast(e instanceof Error ? e.message : '取消失败，请重试');
    await list.reload();
  }
}

/** 倒计时走到 0：去问服务端（可能已超时关单），本地不改状态 */
async function onExpired(): Promise<void> {
  await list.reload();
}

function gotoHome(): void {
  switchTab(TAB.home);
}
</script>

<template>
  <view class="ol" :style="theme.themeStyle">
    <!-- TabBar 根页面不画返回键：左上角一个"返回"会让人以为这里还有上一层，
         而它其实是和"点单"平级的一级页面（切换靠底部 TabBar） -->
    <SnNavBar title="我的订单" :show-back="false" />

    <view class="ol__segwrap">
      <SnSegmented :model-value="seg" :options="segOptions" @change="onSeg" />
    </view>

    <scroll-view scroll-y class="ol__scroll">
      <SnStateBlock
        v-if="needLogin"
        tone="off"
        glyph="—"
        title="登录后才能看订单"
        desc="订单是和你的微信身份绑定的，登录一次即可长期使用。"
        primary-text="重试登录"
        @primary="boot"
      />

      <!-- 骨架：筛选 Chip 30 + 订单卡 ×3 + 底部（卡片内虚线分隔也要画，
           漏掉它会有一像素位移） -->
      <SnPageSkeleton v-else-if="list.phase.value === 'loading'" preset="orderList" :rows="3" />

      <SnStateBlock
        v-else-if="list.phase.value === 'error'"
        tone="danger"
        glyph="!"
        title="订单没加载出来"
        :desc="list.error.value?.message ?? '网络不太顺，这次没取到数据。点「重新加载」再试一次'"
        primary-text="重新加载"
        @primary="list.reload()"
      />

      <!-- 空态（12 类之②③）：分两种情形，**必须区分开** ——
           ① 从未下过单：给"去点单"邀请。
           ② 订单在别的分栏里：必须说出来 + 给直达按钮。
              只写"暂无订单"会让学生以为订单丢了，然后来问客服。 -->
      <SnStateBlock
        v-else-if="list.isEmpty.value"
        tone="off"
        glyph="—"
        :title="otherCount > 0 ? `这一栏暂时是空的` : seg === 'ongoing' ? '还没有进行中的订单' : '还没有已结束的订单'"
        :desc="emptyDesc"
        :primary-text="otherCount > 0 ? `查看${otherLabel}（${otherCount}）` : '去点单'"
        @primary="otherCount > 0 ? (seg = seg === 'ongoing' ? 'done' : 'ongoing') : gotoHome()"
      />

      <view v-else class="ol__list">
        <SnOrderCard
          v-for="o in list.data.value?.items ?? []"
          :key="o.orderNo"
          :order="o"
          @pay="goPay"
          @cancel="doCancel"
          @open="goDetail"
          @expired="onExpired"
        />
        <!-- 到底提示：没有它会让人以为"下面还有、只是没加载出来"，一直往下拽 -->
        <view class="ol__end">
          <text class="ol__endtext">
            共 {{ seg === 'ongoing' ? counts.ongoing : counts.done }} 单，已经到底了
          </text>
        </view>
      </view>
      <view class="ol__pad" />
    </scroll-view>
  </view>
</template>

<style>
.ol {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  background: var(--paper);
}
.ol__segwrap {
  flex: none;
  padding: var(--sp-2) var(--page-x) var(--sp-3);
}
.ol__scroll {
  flex: 1;
  min-height: 0;
}
.ol__skel {
  padding: var(--sp-5) var(--page-x);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.ol__list {
  padding: var(--sp-1) var(--page-x) 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.ol__end {
  padding: var(--sp-6) 0;
  display: flex;
  justify-content: center;
}
.ol__endtext {
  font-size: var(--fs-tag);
  color: var(--ink-400);
}
.ol__pad {
  height: var(--sp-5);
}
</style>
