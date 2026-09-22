<script setup lang="ts">
import { computed } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import SnNavBar from '../../components/SnNavBar.vue';
import { useSessionStore } from '../../stores/session';
import { useThemeStore } from '../../stores/theme';
import { currentAppId } from '../../utils/appid';
import { formatAmount } from '../../utils/amount';
import { switchTab, TAB } from '../../utils/ui';

/**
 * 关于本店 + 隐私说明。
 *
 * 为什么隐私说明必须单独成页、且必须写"房间号提供给谁"：
 *   房间号是学生最敏感的一条信息（比手机号还敏感 —— 手机号别人也能拿到，
 *   房间号等于"我住哪"）。而它又是这个业务**必须**收的：不填就送不到。
 *   唯一的正确做法是如实披露：收什么、给谁、不给谁、学生能怎么删。
 *   藏在长条款里的隐私政策等于没披露，所以这里用短句、分点、说人话。
 */
const theme = useThemeStore();
const session = useSessionStore();

const appid = computed(() => currentAppId());

onLoad(async () => {
  await session.ensureResolved();
});

function copyAppId(): void {
  if (!appid.value) return;
  uni.setClipboardData({ data: appid.value });
}

function onBack(): void {
  const pages = getCurrentPages();
  if (pages.length > 1) uni.navigateBack();
  else switchTab(TAB.mine);
}
</script>

<template>
  <view class="ab" :style="theme.themeStyle">
    <SnNavBar title="关于本店与隐私" @back="onBack" />

    <scroll-view scroll-y class="ab__scroll">
      <view class="ab__block">
        <text class="ab__h1">{{ session.shopName || '本店' }}</text>
        <text class="ab__sub">校园零食配送 · 由本店独立经营</text>
      </view>

      <view class="ab__block">
        <text class="ab__h2">覆盖楼栋</text>
        <view class="ab__card">
          <view v-for="b in session.buildings" :key="b.buildingId" class="ab__kv">
            <text class="ab__k">{{ b.buildingName }}</text>
            <text class="ab__v">
              起送 {{ formatAmount(b.minAmountCents) }} · {{ b.cutoffTime }} 截单
            </text>
          </view>
          <text v-if="!session.buildings.length" class="ab__empty">未配置楼栋</text>
        </view>
      </view>

      <view class="ab__block">
        <text class="ab__h2">隐私说明</text>
        <view class="ab__card">
          <view class="ab__point">
            <text class="ab__ptitle">我们收什么</text>
            <text class="ab__ptext">
              下单需要的收货信息：宿舍楼、楼层（可选）、房间号、联系人（可选）、电话（可选）。
              微信登录只会拿到你的微信标识，用于把你的订单归到你名下。
            </text>
          </view>

          <view class="ab__point">
            <text class="ab__ptitle">房间号给谁看</text>
            <text class="ab__ptext">
              只给这家店的店主，用途只有一个：把货送到你手上。
              其他学生看不到你的房间号；平台的后台数据里也不包含房间号，
              所以平台运营人员同样看不到。
            </text>
          </view>

          <view class="ab__point">
            <text class="ab__ptitle">电话什么时候给</text>
            <text class="ab__ptext">
              只在你填了电话、并且有一笔正在配送的订单时，提供给配送的店主。
              不填也能正常下单。
            </text>
          </view>

          <view class="ab__point">
            <text class="ab__ptitle">你能怎么处理</text>
            <text class="ab__ptext">
              地址可以随时在「地址簿」里修改或删除。删除后不会再用于新的订单；
              已完成的订单会保留必要记录，用于对账与售后。
            </text>
          </view>
        </view>
      </view>

      <view class="ab__block">
        <text class="ab__h2">遇到问题</text>
        <view class="ab__card">
          <text class="ab__ptext">
            订单相关的问题请直接在店内找店家沟通，处理最快。
            如果是小程序本身打不开、页面报错，请把下面的 AppID 提供给我们。
          </text>
          <view class="ab__appid" @click="copyAppId">
            <text class="ab__appidtext num">{{ appid || '未取到 AppID' }}</text>
            <text class="ab__appidcopy">点击复制</text>
          </view>
        </view>
      </view>

      <view class="ab__pad" />
    </scroll-view>
  </view>
</template>

<style>
.ab {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  background: var(--paper);
}
.ab__scroll {
  flex: 1;
  min-height: 0;
}
.ab__block {
  padding: var(--sp-4) var(--page-x) 0;
}
.ab__h1 {
  display: block;
  font-size: var(--fs-title);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}
.ab__sub {
  display: block;
  margin-top: var(--sp-1);
  font-size: var(--fs-sub);
  color: var(--ink-500);
}
.ab__h2 {
  display: block;
  margin-bottom: var(--sp-2);
  font-size: var(--fs-section);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}
.ab__card {
  background: var(--surface);
  border: var(--bd);
  border-radius: var(--r-md);
  padding: var(--sp-4);
}
.ab__kv {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: var(--sp-2) 0;
}
.ab__k {
  font-size: var(--fs-body);
  color: var(--ink-900);
}
.ab__v {
  font-size: var(--fs-sub);
  color: var(--ink-500);
}
.ab__empty {
  font-size: var(--fs-sub);
  color: var(--ink-400);
}
.ab__point {
  padding-bottom: var(--sp-4);
}
.ab__point:last-child {
  padding-bottom: 0;
}
.ab__ptitle {
  display: block;
  font-size: var(--fs-card);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}
.ab__ptext {
  display: block;
  margin-top: var(--sp-1);
  font-size: var(--fs-sub);
  color: var(--ink-700);
  line-height: var(--lh-sub);
}
.ab__appid {
  margin-top: var(--sp-3);
  padding-top: var(--sp-3);
  border-top: var(--bd);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}
.ab__appidtext {
  flex: 1;
  font-size: var(--fs-tag);
  color: var(--ink-500);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.ab__appidcopy {
  flex: none;
  font-size: var(--fs-tag);
  color: var(--brand-700);
}
.ab__pad {
  height: var(--sp-6);
}
</style>
