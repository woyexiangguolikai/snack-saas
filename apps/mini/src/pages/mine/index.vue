<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad, onShow } from '@dcloudio/uni-app';
import SnNavBar from '../../components/SnNavBar.vue';
import SnAvatar from '../../components/SnAvatar.vue';
import SnListRow from '../../components/SnListRow.vue';
import SnTag from '../../components/SnTag.vue';
import SnButton from '../../components/SnButton.vue';
import { useSessionStore } from '../../stores/session';
import { useCartStore } from '../../stores/cart';
import { useThemeStore } from '../../stores/theme';
import { api } from '../../utils/api';
import { confirm, toast, switchTab, goBackOrHome, TAB } from '../../utils/ui';
import SnNetBanner from '../../components/SnNetBanner.vue';

/**
 * S-16 我的。
 *
 * 一条重要的**不做**：楼栋切换器不放在这里（原型明确写了）。
 *   楼栋是"浏览上下文"，不是"设置项"。放在这里会造成一个很隐蔽的问题：
 *   学生在这里切了楼栋，却不知道购物车被清空了 —— 因为他的注意力在"设置"上，
 *   而清空发生在购物车里。放首页就对了：切楼栋时购物车就在同一屏，一目了然。
 *
 * 商户入口藏在底部小字里：学生几乎不需要它，但店主自己要用这个小程序接单。
 * 放在显眼位置会让学生误点，藏起来但可达是正解。
 */
const session = useSessionStore();
const cart = useCartStore();
const theme = useThemeStore();

const busy = ref(false);

onLoad(async () => {
  await session.ensureResolved();
  // 不主动弹登录：这一页大部分内容（关于本店、隐私）不需要身份。
  // 只有在点"我的订单""地址簿"时才要求登录。
  void refreshUnread();
});

/**
 * 每次回到这一页都校准一次未读数。
 *
 * TabBar 页只在第一次创建时 onLoad，之后来回切只走 onShow ——
 * 只认 onLoad 的红点会"永远停在第一次看到的值"。
 */
onShow(() => {
  void refreshUnread();
});

async function refreshUnread(): Promise<void> {
  if (!session.loggedIn) {
    session.setUnread(0);
    return;
  }
  try {
    session.setUnread((await api.unreadCount()).unread);
  } catch {
    // 红点失败就保持原样：它是"有没有新消息"的提示，不是"能不能用"的前提
  }
}

const loggedIn = computed(() => session.loggedIn);
const nickname = computed(() => session.user?.nickname || '微信用户');
const avatar = computed(() => session.user?.avatar ?? '');

const buildingsText = computed(() =>
  session.buildings.length ? session.buildings.map((b) => b.buildingName).join('、') : '未配置',
);

const hoursText = computed(() => {
  const b = session.currentBuilding;
  if (!b) return '未配置';
  return `每日 ${b.accessibleFrom}–${b.accessibleTo}（${b.cutoffTime} 截单）`;
});

async function ensureLoginThen(go: () => void): Promise<void> {
  if (session.loggedIn) {
    go();
    return;
  }
  busy.value = true;
  const ok = await session.ensureLogin();
  busy.value = false;
  if (!ok) {
    toast(
      session.lastError?.code === 'WECHAT_NOT_CONFIGURED'
        ? '服务端还没配置小程序登录，暂时无法使用'
        : '登录没有完成，请重试',
    );
    return;
  }
  go();
}

function gotoOrders(): void {
  // 订单是我的 TabBar 邻居页，切过去即可 —— 那里自己会处理登录
  switchTab(TAB.orders);
}

function gotoAddress(): void {
  void ensureLoginThen(() => uni.navigateTo({ url: '/pages/address/list' }));
}

function gotoNotice(): void {
  void ensureLoginThen(() => uni.navigateTo({ url: '/pages/mine/notice' }));
}

function gotoAbout(): void {
  uni.navigateTo({ url: '/pages/mine/about' });
}

async function doLogout(): Promise<void> {
  const yes = await confirm('退出登录？', '退出后浏览商品不受影响，下单需要重新登录。', '退出');
  if (!yes) return;
  session.logout();
  cart.clear();
  toast('已退出登录');
}

/**
 * 进商户端（CM-01）。
 *
 * 这里**不做身份判断** —— 判断在商户页里做：那一页会用同一个 wx.login 的
 * 微信身份去换店主令牌，不是店主就得到 403 NOT_MERCHANT 和一句明确的话。
 * 若在这里先判断一次，就要把"我是不是店主"的答案存两份，而它随时可能在后台被改掉。
 */
function gotoMerchant(): void {
  uni.navigateTo({ url: '/pages-merchant/delivery/index' });
}

function onBack(): void {
  goBackOrHome();
}
</script>

<template>
  <view class="me" :style="theme.themeStyle">
    <SnNavBar title="我的" :show-back="false" />
    <!-- 网络横幅（§5.2：任何情况下可见）—— 导航栏正下方，不遮挡操作 -->
    <SnNetBanner />

    <scroll-view scroll-y class="me__scroll">
      <!-- 用户卡 -->
      <view class="me__block">
        <view class="me__user">
          <SnAvatar :name="nickname" :src="avatar" :size="52" shape="circle" />
          <view class="me__usermain">
            <text class="me__nick">{{ loggedIn ? nickname : '未登录' }}</text>
            <text class="me__sub">
              {{ loggedIn ? '已登录，可下单与查看订单' : '浏览商品不需要登录，下单时需要' }}
            </text>
          </view>
          <SnTag v-if="loggedIn" tone="ok" label="已登录" />
        </view>
      </view>

      <!-- 入口 -->
      <view class="me__block">
        <view class="me__card">
          <SnListRow clickable @click="gotoOrders">
            <text class="me__rowtitle">我的订单</text>
            <template #tail><text class="me__rowtail">进行中 / 已结束</text></template>
          </SnListRow>
          <SnListRow clickable @click="gotoNotice">
            <text class="me__rowtitle">消息</text>
            <template #tail>
              <view class="me__tailwrap">
                <text v-if="session.unread > 0" class="me__badge num">
                  {{ session.unread > 99 ? '99+' : session.unread }}
                </text>
                <text class="me__rowtail">订单进展在这里</text>
              </view>
            </template>
          </SnListRow>
          <SnListRow clickable @click="gotoAddress">
            <text class="me__rowtitle">地址簿</text>
            <template #tail><text class="me__rowtail">宿舍楼 + 房间号</text></template>
          </SnListRow>
          <SnListRow clickable last @click="gotoAbout">
            <text class="me__rowtitle">关于本店与隐私</text>
            <template #tail><text class="me__rowtail">房间号怎么用</text></template>
          </SnListRow>
        </view>
      </view>

      <!-- 关于本店（不依赖登录） -->
      <view class="me__block">
        <view class="me__card">
          <view class="me__kv">
            <text class="me__k">店铺</text>
            <text class="me__v">{{ session.shopName || '—' }}</text>
          </view>
          <view class="me__kv">
            <text class="me__k">覆盖楼栋</text>
            <text class="me__v">{{ buildingsText }}</text>
          </view>
          <view class="me__kv">
            <text class="me__k">营业时间</text>
            <text class="me__v">{{ hoursText }}</text>
          </view>
        </view>
      </view>

      <view v-if="loggedIn" class="me__block">
        <SnButton type="sec" block :loading="busy" @click="doLogout">退出登录</SnButton>
      </view>

      <view class="me__pad" />
    </scroll-view>

    <!-- 商户入口：学生几乎不需要，藏底部小字，但可达 -->
    <view class="me__merchant">
      <text class="me__merchanttext" @click="gotoMerchant">我是店主，进入商户端</text>
    </view>
  </view>
</template>

<style>
.me {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  background: var(--paper);
}
.me__scroll {
  flex: 1;
  min-height: 0;
}
.me__block {
  padding: var(--sp-3) var(--page-x) 0;
}
.me__user {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-4);
  background: var(--surface);
  border: var(--bd);
  border-radius: var(--r-md);
}
.me__usermain {
  flex: 1;
  min-width: 0;
}
.me__nick {
  display: block;
  font-size: var(--fs-card);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}
.me__sub {
  display: block;
  margin-top: 2px;
  font-size: var(--fs-tag);
  color: var(--ink-500);
}
.me__card {
  background: var(--surface);
  border: var(--bd);
  border-radius: var(--r-md);
  padding: var(--sp-2) var(--sp-4);
}
.me__rowtitle {
  font-size: var(--fs-body);
  color: var(--ink-900);
}
.me__rowtail {
  font-size: var(--fs-tag);
  color: var(--ink-500);
}
.me__tailwrap {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.me__badge {
  min-width: 32rpx;
  height: 32rpx;
  padding: 0 8rpx;
  border-radius: var(--r-full);
  background: var(--brand-500);
  color: var(--on-brand);
  font-size: 20rpx;
  line-height: 32rpx;
  text-align: center;
}
.me__kv {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: var(--sp-3) 0;
  border-bottom: var(--bd);
}
.me__kv:last-child {
  border-bottom: none;
}
.me__k {
  flex: none;
  font-size: var(--fs-sub);
  color: var(--ink-500);
}
.me__v {
  flex: 1;
  text-align: right;
  font-size: var(--fs-sub);
  color: var(--ink-900);
  line-height: var(--lh-sub);
}
.me__pad {
  height: var(--sp-6);
}
.me__merchant {
  flex: none;
  padding: var(--sp-3) var(--page-x);
  padding-bottom: calc(var(--sp-3) + env(safe-area-inset-bottom));
  display: flex;
  justify-content: center;
}
.me__merchanttext {
  font-size: var(--fs-tag);
  color: var(--ink-400);
}
</style>
