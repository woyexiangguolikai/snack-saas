<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad, onShow } from '@dcloudio/uni-app';
import SnNavBar from '../../components/SnNavBar.vue';
import SnSwitch from '../../components/SnSwitch.vue';
import SnAmount from '../../components/SnAmount.vue';
import SnTag from '../../components/SnTag.vue';
import SnListRow from '../../components/SnListRow.vue';
import SnStateBlock from '../../components/SnStateBlock.vue';
import SnSkeleton from '../../components/SnSkeleton.vue';
import SnMerchantTab from '../../components/SnMerchantTab.vue';
import { useThemeStore } from '../../stores/theme';
import { useMerchantStore } from '../../stores/merchant';
import { useAsync } from '../../composables/useAsync';
import { mapi, type BillingView } from '../../utils/mapi';
import { toast, confirm } from '../../utils/ui';
import SnNetBanner from '../../components/SnNetBanner.vue';

/**
 * M-05 我的（商户端工作台）。
 *
 * 开关店是这一页唯一的"危险动作"，两件事必须做对：
 *   ① **关店要二次确认，且确认框里要写影响范围** —— 已有 3 单在配送中仍会继续送，
 *      这句话不写，店主会以为点了关店就把客人扔在半路了。
 *   ② 关店 ≠ 下架：库存、商品、价格全部保留，只是学生端此刻不能下单。
 */
const theme = useThemeStore();
const merchant = useMerchantStore();

const billing = useAsync<BillingView>(() => mapi.billing(20));
const pending = ref(0);
const shopOpen = ref(true);
const toggling = ref(false);

onLoad(() => void boot());
onShow(() => {
  if (merchant.ready) {
    void billing.reload();
    void loadPending();
  }
});

async function boot(): Promise<void> {
  const ok = await merchant.ensure();
  if (!ok) return;
  await Promise.all([billing.load(), loadConfig(), loadPending()]);
}

async function loadConfig(): Promise<void> {
  try {
    const c = await mapi.config();
    shopOpen.value = c.shop.shopOpen;
  } catch {
    // 配置拿不到不阻断这一页 —— 开关会以"未知"呈现，比整页报错好
  }
}

async function loadPending(): Promise<void> {
  try {
    const d = await mapi.delivery();
    pending.value = d.totalPending;
  } catch {
    pending.value = 0;
  }
}

const wallet = computed(() => billing.data.value?.wallet ?? null);
const sub = computed(() => billing.data.value?.subscription ?? null);

async function onToggleOpen(next: boolean): Promise<void> {
  if (toggling.value) return;
  if (!next && pending.value > 0) {
    const yes = await confirm(
      '确认关店？',
      `还有 ${pending.value} 单在配送中，关店后这些单仍会继续配送；新的订单学生暂时下不了。库存与商品都会保留。`,
      '确认关店',
    );
    if (!yes) return;
  }
  toggling.value = true;
  try {
    await mapi.saveConfig({ shopOpen: next });
    shopOpen.value = next;
    toast(next ? '已开始营业' : '已设为休息中');
  } catch (e) {
    toast(e instanceof Error ? e.message : '设置没有生效，请重试');
  } finally {
    toggling.value = false;
  }
}

function go(path: string): void {
  uni.navigateTo({ url: path });
}

/**
 * 生成网页后台登录码。
 *
 * 码必须**显示出来且可复制** —— 只弹一句"已生成"是没用的：
 * 码在手机上、后台在电脑上，人得自己把这 6 位数字敲过去。
 * 过期时间也一并显示，否则店主不知道该赶紧敲还是可以先做完手上的事。
 */
const loginCode = ref('');
const codeExpiry = ref('');
const codeBusy = ref(false);

async function makeLoginCode(): Promise<void> {
  if (codeBusy.value) return;
  codeBusy.value = true;
  try {
    const r = await mapi.webLoginCode();
    loginCode.value = r.code;
    codeExpiry.value = r.expiresAt.slice(11, 16);
    uni.setClipboardData({ data: r.code });
    toast('登录码已生成并复制');
  } catch (e) {
    toast(e instanceof Error ? e.message : '生成失败，请重试');
  } finally {
    codeBusy.value = false;
  }
}

function logout(): void {
  merchant.logout();
  uni.switchTab({ url: '/pages/shop/home' });
}
</script>

<template>
  <view class="mm" :style="theme.themeStyle">
    <SnNavBar title="我的店铺" :show-back="false" />
    <!-- 网络横幅（§5.2：任何情况下可见）—— 导航栏正下方，不遮挡操作 -->
    <SnNetBanner />

    <scroll-view scroll-y class="mm__scroll">
      <view v-if="billing.phase.value === 'loading'" class="mm__skel">
        <SnSkeleton variant="text" />
        <SnSkeleton variant="text" />
      </view>

      <SnStateBlock
        v-else-if="billing.phase.value === 'error'"
        tone="danger"
        glyph="!"
        title="账户信息没加载出来"
        :desc="billing.error.value?.message ?? '网络不太顺，这次没取到数据。点「重新加载」再试一次'"
        primary-text="重新加载"
        @primary="billing.reload()"
      />

      <template v-else>
        <!-- 店铺卡 + 开关店 -->
        <view class="mm__card">
          <view class="mm__shop">
            <text class="mm__shopname">{{ merchant.shopName || '本店' }}</text>
            <SnTag :tone="shopOpen ? 'ok' : 'off'" :label="shopOpen ? '营业中' : '休息中'" />
          </view>
          <SnSwitch
            :model-value="shopOpen"
            tone="brand"
            label="接单开关"
            :description="shopOpen ? '学生现在可以下单' : '学生暂时不能下单，已接的单不受影响'"
            @change="onToggleOpen"
          />
        </view>

        <!-- 余额卡：预警/触底的语义色与文案都由服务端给（AC-11 / D5 中性文案） -->
        <view v-if="wallet" class="mm__card" @click="go('/pages-merchant/mine/balance')">
          <view class="mm__cardhead">
            <text class="mm__cardtitle">{{ wallet.walletName }}</text>
            <SnTag :tone="wallet.tone === 'danger' ? 'danger' : wallet.tone === 'warn' ? 'warn' : 'ok'" :label="wallet.noticeTitle" />
          </view>
          <SnAmount :fen="wallet.balanceCents" size="lg" />
          <text class="mm__carddesc">{{ wallet.noticeBody }}</text>
        </view>

        <view v-if="sub" class="mm__card" @click="go('/pages-merchant/mine/subscription')">
          <view class="mm__cardhead">
            <text class="mm__cardtitle">{{ sub.noticeTitle || sub.subscriptionName }}</text>
            <text v-if="sub.daysLeft !== null && sub.daysLeft > 0" class="mm__days">剩 {{ sub.daysLeft }} 天</text>
          </view>
          <text class="mm__carddesc">{{ sub.notice }}</text>
        </view>

        <view class="mm__menu">
          <SnListRow clickable @click="go('/pages-merchant/building/list')">
            <text class="mm__menutext">楼栋与配送</text>
            <template #tail><text class="mm__chev">›</text></template>
          </SnListRow>
          <SnListRow clickable @click="go('/pages-merchant/goods/list')">
            <text class="mm__menutext">商品</text>
            <template #tail><text class="mm__chev">›</text></template>
          </SnListRow>
          <SnListRow clickable @click="go('/pages-merchant/setting/index')">
            <text class="mm__menutext">店铺设置</text>
            <template #tail><text class="mm__chev">›</text></template>
          </SnListRow>
          <SnListRow clickable @click="makeLoginCode()">
            <text class="mm__menutext">网页后台登录码</text>
            <template #tail>
              <text v-if="loginCode" class="mm__code num">{{ loginCode }}</text>
              <text v-else class="mm__chev">›</text>
            </template>
          </SnListRow>
          <text v-if="loginCode" class="mm__codehint">
            已复制到剪贴板，{{ codeExpiry }} 前有效，用一次即失效。在电脑浏览器打开后台页面填入即可。
          </text>
          <SnListRow last @click="logout">
            <text class="mm__menutext mm__menutext--muted">退出店主身份</text>
          </SnListRow>
        </view>

        <view class="mm__pad" />
      </template>
    </scroll-view>

    <SnMerchantTab current="mine" />
  </view>
</template>

<style>
.mm {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  background: var(--paper);
}
.mm__scroll {
  flex: 1;
  min-height: 0;
}
.mm__skel {
  padding: var(--sp-5) var(--page-x);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.mm__card {
  margin: var(--sp-3) var(--page-x);
  padding: var(--sp-4);
  background: var(--surface);
  border-radius: var(--r-md);
}
.mm__shop {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--sp-3);
}
.mm__shopname {
  font-size: var(--fs-card);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}
.mm__cardhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--sp-2);
}
.mm__cardtitle {
  font-size: var(--fs-sub);
  color: var(--ink-500);
}
.mm__days {
  font-size: var(--fs-sub);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}
.mm__carddesc {
  margin-top: var(--sp-2);
  font-size: var(--fs-tag);
  color: var(--ink-400);
  line-height: var(--lh-body);
}
.mm__menu {
  margin: var(--sp-3) var(--page-x);
  background: var(--surface);
  border-radius: var(--r-md);
}
.mm__menutext {
  font-size: var(--fs-body);
  color: var(--ink-900);
}
.mm__menutext--muted {
  color: var(--ink-400);
}
.mm__chev {
  font-size: var(--fs-body);
  color: var(--ink-300);
}
.mm__code {
  font-size: var(--fs-card);
  font-weight: var(--fw-semibold);
  color: var(--brand-700);
  letter-spacing: 2px;
}
.mm__codehint {
  padding: var(--sp-2) var(--sp-4) var(--sp-3);
  font-size: var(--fs-tag);
  color: var(--ink-400);
  line-height: var(--lh-body);
}
.mm__pad {
  height: var(--sp-6);
}
</style>
