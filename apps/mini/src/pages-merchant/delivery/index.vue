<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { onLoad, onPullDownRefresh, onShow } from '@dcloudio/uni-app';
import SnNavBar from '../../components/SnNavBar.vue';
import SnTag from '../../components/SnTag.vue';
import SnButton from '../../components/SnButton.vue';
import SnCheckbox from '../../components/SnCheckbox.vue';
import SnStickyBar from '../../components/SnStickyBar.vue';
import SnStateBlock from '../../components/SnStateBlock.vue';
import SnPageSkeleton from '../../components/SnPageSkeleton.vue';
import SnMerchantTab from '../../components/SnMerchantTab.vue';
import { useThemeStore } from '../../stores/theme';
import { useMerchantStore } from '../../stores/merchant';
import { useAsync } from '../../composables/useAsync';
import { mapi, type MerchantDeliveryGroup, type MerchantDeliveryItem } from '../../utils/mapi';
import { formatAmount } from '../../utils/amount';
import { toast, confirm, pullRefresh } from '../../utils/ui';

/* ============================================================================
 * M-01 配送清单 —— 商户端的**主视图**，也是本版本的"主视图翻转"落点（§4.13.3）
 * ----------------------------------------------------------------------------
 * 三条硬约束，都是 AC-03 写死的：
 *
 * ① **排序只有空间序**：楼栋 → 楼层 → 房间号（服务端已排好，前端原样渲染）。
 *    界面上**不得出现"按时间排序"或"由新到旧"的切换** —— 商户在楼里送一趟，
 *    需要的是"这栋楼还有哪些房间"，不是"谁先下的单"。
 *
 * ② **整行是勾选热区**：他一只手扶着货箱，另一只手要点的是"这一行"，
 *    不是行尾那个 24px 的小方框。
 *
 * ③ **送达可撤销，但撤销必须是"延迟提交"**：
 *    `delivered` 是状态机的**终态**，一旦提交就改不回来了。所以这里的设计是
 *    先在本地把行标成已送达（乐观 UI，立刻给反馈），**5 秒后才真正发请求**。
 *    这 5 秒里点撤销 = 取消提交，不是"再改一次状态"。
 *    如果换成"提交成功后再给撤销按钮"，那个按钮点了必然报错 —— 那是在骗人。
 * ==========================================================================*/

const theme = useThemeStore();
const merchant = useMerchantStore();

const list = useAsync<{
  groups: MerchantDeliveryGroup[];
  totalPending: number;
  today: { day: string; deliveredCount: number; deliveredCents: number };
}>(() => mapi.delivery());

/** 已勾选、等待送达的订单号 */
const checked = ref<Set<string>>(new Set());
/** 已乐观标记为送达（尚未提交 / 已提交）的订单号 */
const delivered = ref<Set<string>>(new Set());
/** 延迟提交的定时器（orderNo → timer 由批次统一持有） */
let submitTimer: ReturnType<typeof setTimeout> | null = null;
/** 待提交批次 —— 撤销就是把它清空并撤掉定时器 */
const pendingBatch = ref<string[]>([]);
const undoLeft = ref(0);
let countdown: ReturnType<typeof setInterval> | null = null;

const needLogin = ref(false);

onLoad(() => void boot());
onShow(() => {
  if (merchant.ready && !needLogin.value) void list.reload();
});
onUnmounted(() => clearTimers());

async function boot(): Promise<void> {
  const ok = await merchant.ensure();
  if (!ok) {
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

/* ------------------------------------------------------------ 派生数据 */

/** 楼层分组：服务端已按 楼栋→楼层→房间号 排好，这里只做**分桶**，不重排 */
function floorsOf(items: MerchantDeliveryItem[]): Array<{ floor: string; items: MerchantDeliveryItem[] }> {
  const out: Array<{ floor: string; items: MerchantDeliveryItem[] }> = [];
  for (const it of items) {
    const key = it.floor ?? '';
    const last = out[out.length - 1];
    if (last && last.floor === key) last.items.push(it);
    else out.push({ floor: key, items: [it] });
  }
  return out;
}

const groups = computed(() => (list.data.value?.groups ?? []).map((g) => {
  const alive = g.items.filter((i) => !delivered.value.has(i.orderNo));
  return {
    ...g,
    alive,
    allDone: g.items.length > 0 && alive.length === 0,
    floors: floorsOf(alive),
  };
}));

const totalPending = computed(() => groups.value.reduce((s, g) => s + g.alive.length, 0));

/**
 * 今日配送日报（空态 ⑦ 用）。
 *
 * 这个空态是**唯一用 ok 色**的："没有待送订单"对商户是好事。
 * 所以它不该只说"没有订单"（读起来像故障），而要给出正向反馈 ——
 * 今天送了几单、收了多少钱。数字来自服务端，与 groups 同一次请求返回，
 * 因此不会出现"待送 0 单、营收却是昨天的"这种对不上的组合。
 */
const today = computed(() => list.data.value?.today ?? { day: '', deliveredCount: 0, deliveredCents: 0 });
const totalItems = computed(() =>
  groups.value.reduce((s, g) => s + g.alive.reduce((n, i) => n + i.itemCount, 0), 0),
);

const checkedList = computed(() =>
  (list.data.value?.groups ?? [])
    .flatMap((g) => g.items)
    .filter((i) => checked.value.has(i.orderNo)),
);
const checkedCount = computed(() => checked.value.size);

/* ------------------------------------------------------------ 勾选 */

function toggle(orderNo: string): void {
  if (delivered.value.has(orderNo)) return;
  const next = new Set(checked.value);
  if (next.has(orderNo)) next.delete(orderNo);
  else next.add(orderNo);
  checked.value = next;
}

function clearChecked(): void {
  checked.value = new Set();
}

function toggleGroup(g: { alive: MerchantDeliveryItem[] }): void {
  const next = new Set(checked.value);
  const allOn = g.alive.every((i) => next.has(i.orderNo));
  for (const i of g.alive) {
    if (allOn) next.delete(i.orderNo);
    else next.add(i.orderNo);
  }
  checked.value = next;
}

/* ------------------------------------------------------------ 接单 */

async function doAccept(orderNo: string): Promise<void> {
  try {
    await mapi.accept(orderNo);
    toast('已接单');
    await list.reload();
  } catch (e) {
    toast(e instanceof Error ? e.message : '接单没有完成，请重试');
  }
}

/* ------------------------------------------------------------ 送达（延迟提交 + 撤销） */

/**
 * AC-08：勾选送达是**可逆操作**，立即生效 + 给撤销，不弹确认。
 *
 * 这里原本弹过确认框（"标记 N 单已送达？…确认后 5 秒内可以撤销"），
 * 那是冗余的第二道闸门：既然已经能撤销，再问一遍"确定吗"只是让商户多点一次，
 * 而且会暗示这一步很危险 —— 实际误标了撤销一下就回来了。
 * 确认框该用在**不可逆**的事上（AC-09），比如停用楼栋，不是这里。
 */
function onDeliver(): void {
  if (!checkedCount.value) return;
  scheduleDeliver(checkedList.value.map((i) => i.orderNo));
}

function scheduleDeliver(orderNos: string[]): void {
  clearTimers();
  pendingBatch.value = orderNos;
  // 乐观：立刻把行标成已送达并折叠，商户的手感必须是"点了就成了"
  const next = new Set(delivered.value);
  for (const n of orderNos) next.add(n);
  delivered.value = next;
  checked.value = new Set();

  undoLeft.value = 5;
  countdown = setInterval(() => {
    undoLeft.value -= 1;
    if (undoLeft.value <= 0 && countdown) {
      clearInterval(countdown);
      countdown = null;
    }
  }, 1000);

  submitTimer = setTimeout(() => void commitDeliver(orderNos), 5000);
}

async function commitDeliver(orderNos: string[]): Promise<void> {
  clearTimers();
  try {
    const r = await mapi.deliverBatch(orderNos);
    const failed = r.failed?.length ?? 0;
    toast(failed ? `已送达 ${r.done.length} 单，${failed} 单需确认` : `已送达 ${r.done.length} 单`);
  } catch (e) {
    // 提交失败 → 撤销乐观标记，让这些行回到待送状态（不能"看起来送了其实没送"）
    const next = new Set(delivered.value);
    for (const n of orderNos) next.delete(n);
    delivered.value = next;
    toast(e instanceof Error ? e.message : '送达没有提交成功，请重试');
  }
  await list.reload();
  delivered.value = new Set();
}

function undoDeliver(): void {
  clearTimers();
  const next = new Set(delivered.value);
  for (const n of pendingBatch.value) next.delete(n);
  delivered.value = next;
  pendingBatch.value = [];
  toast('已撤销，这些单仍在待送');
}

function clearTimers(): void {
  if (submitTimer) {
    clearTimeout(submitTimer);
    submitTimer = null;
  }
  if (countdown) {
    clearInterval(countdown);
    countdown = null;
  }
  undoLeft.value = 0;
}

/* ------------------------------------------------------------ 其它 */

function goDetail(orderNo: string): void {
  uni.navigateTo({ url: `/pages-merchant/order/detail?orderNo=${orderNo}` });
}

/** 不是店主的唯一出口：回学生端。不给"换个身份试试"这种假出口（D10 单管理员） */
function goStudent(): void {
  uni.switchTab({ url: '/pages/shop/home' });
}

/**
 * 「送完了」空态的唯一动作：主动刷新。
 *
 * 为什么不是设计稿里的"查看今日订单"：
 *   商户端小程序在 v1 里**没有已送达的历史列表页**（只有配送/库存/我的三个 Tab），
 *   历史订单在网页后台 W-07。这里放一个跳向不存在页面的按钮，
 *   比不放按钮更糟 —— 用户点下去什么都不会发生，然后他会认为整个页面坏了。
 *   待办里"补齐商户端已送达复盘视图"是独立需求，不在 S7 范围内。
 *
 * 所以给的是**当下真能用**的一件事：等新单的时候刷新一下。
 * 按钮文字直接说清它会做什么，不用"确定""好的"这类不承载信息的词。
 */
async function refreshDelivery(): Promise<void> {
  await list.reload();
}
</script>

<template>
  <view class="md" :style="theme.themeStyle">
    <SnNavBar title="配送清单" :show-back="false" />

    <!-- 合计条：商户上楼前一眼知道自己还要跑多少（数字等宽，AC-07） -->
    <view v-if="totalPending > 0" class="md__sum">
      <text class="md__sumtext">待送 {{ totalPending }} 单 · 共 {{ totalItems }} 件</text>
    </view>

    <scroll-view scroll-y class="md__scroll">
      <SnStateBlock
        v-if="needLogin"
        tone="off"
        glyph="—"
        :title="merchant.lastFail?.notMerchant ? '当前仅店主可登录' : '需要店主身份'"
        :desc="
          merchant.lastFail?.notMerchant
            ? '这个微信还没有被设为店主。请联系平台运营为你的微信绑定店主身份后再进入。'
            : (merchant.lastFail?.message ?? '请重新进入一次以完成店主登录。')
        "
        :primary-text="merchant.lastFail?.notMerchant ? '' : '重试登录'"
        secondary-text="返回点单"
        @primary="boot"
        @secondary="goStudent"
      />

      <!-- 骨架：楼栋牌 36 · 楼层头 19 · 配送行 ×3（**含 26px 勾选圈**）。
           漏掉勾选圈，房间号列会横向位移 37px。 -->
      <SnPageSkeleton v-else-if="list.phase.value === 'loading'" preset="delivery" :rows="3" />

      <SnStateBlock
        v-else-if="list.phase.value === 'error'"
        tone="danger"
        glyph="!"
        title="清单没加载出来"
        :desc="list.error.value?.message ?? '网络不太顺，这次没取到数据。点「重新加载」再试一次'"
        primary-text="重新加载"
        @primary="list.reload()"
      />

      <!-- 空态（12 类之⑦）：全产品**唯一用 ok 色**的空状态。
           "没有待送订单"是好事，不是问题 —— 所以不能只用一句"没有订单"打发，
           要给正向反馈（今天送了几单、收了多少钱）与一个下一步。 -->
      <SnStateBlock
        v-else-if="list.isEmpty.value || totalPending === 0"
        tone="ok"
        glyph="✓"
        title="这一趟送完了"
        :desc="
          today.deliveredCount > 0
            ? `今天 ${today.deliveredCount} 单已全部送达，营收 ${formatAmount(today.deliveredCents)}。新订单进来会自动出现在这里。`
            : '当前没有待接单或配送中的订单。新订单进来会自动出现在这里。'
        "
        primary-text="刷新看有没有新单"
        @primary="refreshDelivery"
      />

      <view v-else class="md__groups">
        <view v-for="g in groups" :key="g.buildingId" class="md__group">
          <!-- 楼栋牌：整栋一键全选 —— 商户最常见的动作就是"这栋我全送完了" -->
          <view class="md__bldg" @click="toggleGroup(g)">
            <text class="md__bldgname">{{ g.buildingName }}</text>
            <text class="md__bldgcount">{{ g.alive.length }} 单</text>
          </view>

          <!-- 整栋送完 → 折叠成一行，不清空（看得见自己刚才干了什么） -->
          <view v-if="g.allDone" class="md__alldone">
            <text class="md__alldonetext">已全部送达</text>
          </view>

          <view v-for="fl in g.floors" :key="fl.floor || '_'" class="md__floor">
            <view class="md__floorhead">
              <text class="md__floortext">{{ fl.floor ? `${fl.floor} 层` : '未填楼层' }}</text>
            </view>

            <view
              v-for="it in fl.items"
              :key="it.orderNo"
              class="md__row"
              @click="toggle(it.orderNo)"
            >
              <view class="md__rowmain">
                <view class="md__line1">
                  <text class="md__room">{{ it.room }}</text>
                  <SnTag :tone="it.tone === 'off' ? 'off' : it.tone" :label="it.statusText" />
                  <text v-if="it.hasRemark" class="md__remark">有备注</text>
                </view>
                <text class="md__goods">{{ it.itemSummary }}</text>
                <text v-if="it.hasRemark" class="md__remarktext">{{ it.remark }}</text>
              </view>

              <view class="md__rowside">
                <text class="md__qty">{{ it.itemCount }} 件</text>
                <SnButton
                  v-if="it.status === 'pending_accept'"
                  size="sm"
                  type="pri"
                  @click.stop="doAccept(it.orderNo)"
                >
                  接单
                </SnButton>
              </view>

              <view class="md__check" @click.stop="toggle(it.orderNo)">
                <SnCheckbox :model-value="checked.has(it.orderNo)" @update:model-value="toggle(it.orderNo)" />
              </view>
            </view>
          </view>
        </view>
        <view class="md__pad" />
      </view>
    </scroll-view>

    <!-- 撤销条：5 秒窗口内可以反悔。文案必须说"还没提交"，不能让人以为已生效 -->
    <view v-if="undoLeft > 0" class="md__undo">
      <text class="md__undotext">{{ undoLeft }} 秒后提交 · {{ pendingBatch.length }} 单</text>
      <text class="md__undobtn" @click="undoDeliver">撤销</text>
    </view>

    <SnStickyBar v-if="checkedCount > 0">
      <view class="md__bulk">
        <text class="md__bulktext">已选 {{ checkedCount }} 单</text>
        <SnButton size="sm" type="tex" @click="clearChecked">取消</SnButton>
        <SnButton size="sm" type="pri" @click="onDeliver">标记送达</SnButton>
      </view>
    </SnStickyBar>

    <SnMerchantTab current="delivery" />
  </view>
</template>

<style>
.md {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  background: var(--paper);
}
.md__sum {
  flex: none;
  padding: var(--sp-3) var(--page-x);
  background: var(--surface);
  border-bottom: 1rpx solid var(--line-200);
}
.md__sumtext {
  font-size: var(--fs-sub);
  font-weight: var(--fw-semibold);
  color: var(--ink-700);
}
.md__scroll {
  flex: 1;
  min-height: 0;
}
.md__skel {
  padding: var(--sp-5) var(--page-x);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.md__groups {
  padding: var(--sp-3) var(--page-x);
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.md__bldg {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-2) var(--sp-3);
  background: var(--dark-surface);
  border-radius: var(--r-md);
}
.md__bldgname {
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}
.md__bldgcount {
  font-size: var(--fs-tag);
  color: var(--ink-500);
}
.md__alldone {
  margin-top: var(--sp-2);
  padding: var(--sp-3);
  background: var(--ok-bg);
  border-radius: var(--r-md);
}
.md__alldonetext {
  font-size: var(--fs-sub);
  color: var(--ok);
  font-weight: var(--fw-semibold);
}
.md__floor {
  margin-top: var(--sp-2);
}
.md__floorhead {
  padding: var(--sp-2) var(--sp-2) var(--sp-1);
}
.md__floortext {
  font-size: var(--fs-tag);
  color: var(--ink-400);
}
.md__row {
  display: flex;
  align-items: flex-start;
  padding: var(--sp-3);
  background: var(--surface);
  border-radius: var(--r-md);
  margin-bottom: var(--sp-2);
}
.md__rowmain {
  flex: 1;
  min-width: 0;
}
.md__line1 {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.md__room {
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}
.md__remark {
  font-size: var(--fs-tag);
  color: var(--warn);
}
.md__goods {
  margin-top: var(--sp-1);
  font-size: var(--fs-sub);
  color: var(--ink-700);
}
.md__remarktext {
  margin-top: var(--sp-1);
  font-size: var(--fs-tag);
  color: var(--ink-500);
}
.md__rowside {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--sp-2);
  margin-left: var(--sp-2);
}
.md__qty {
  font-size: var(--fs-tag);
  color: var(--ink-500);
}
.md__check {
  margin-left: var(--sp-3);
  padding: var(--sp-2);
}
.md__undo {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-3) var(--page-x);
  background: var(--warn-bg);
}
.md__undotext {
  font-size: var(--fs-sub);
  color: var(--warn);
}
.md__undobtn {
  font-size: var(--fs-sub);
  font-weight: var(--fw-semibold);
  color: var(--warn);
}
.md__bulk {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sp-3);
}
.md__bulktext {
  flex: 1;
  font-size: var(--fs-sub);
  color: var(--ink-700);
}
.md__pad {
  height: var(--sp-5);
}
</style>
