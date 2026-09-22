<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad, onShow } from '@dcloudio/uni-app';
import SnNavBar from '../../components/SnNavBar.vue';
import SnAmount from '../../components/SnAmount.vue';
import SnInput from '../../components/SnInput.vue';
import SnKeyValue from '../../components/SnKeyValue.vue';
import SnDivider from '../../components/SnDivider.vue';
import SnStateBlock from '../../components/SnStateBlock.vue';
import SnSkeleton from '../../components/SnSkeleton.vue';
import SnButton from '../../components/SnButton.vue';
import { useSessionStore } from '../../stores/session';
import { useThemeStore } from '../../stores/theme';
import { useShop } from '../../composables/useShop';
import { useAsync } from '../../composables/useAsync';
import { api, newClientKey, type Address } from '../../utils/api';
import { formatAmount } from '../../utils/amount';
import { toast, switchTab, TAB } from '../../utils/ui';
import { takePickedAddress } from '../../utils/pick';

/**
 * S-10 结算页。
 *
 * 这一页是"钱和货一起定下来"的地方，所以有四条不能省：
 *
 * ① **楼栋不可改**（§4.5）。楼栋决定库存与配送动线，改它等于换一单。
 *    所以这里只显示楼栋牌，不给切换入口；要换请回首页（并且会清空购物车）。
 *
 * ② **跨楼栋拦截**（CS-10）。地址的楼栋必须与订单楼栋一致。
 *    这是整个系统里最贵的一类错误 —— 货送到学生不在的那栋楼。
 *    前端先拦一次（给明确引导），服务端再拦一次（前端拦不住的请求仍被拒）。
 *
 * ③ **截单提醒前置**。不能等点提交才说"已截单"：那时候学生已经挑好东西、
 *    填好备注，一次失败挫败感很强。进页面就把时间窗口状态摆出来。
 *
 * ④ **幂等键在进入页面时生成一次**。它代表"这一次提交意图"。
 *    网络超时后重试必须复用同一个 key（否则下出两单）；
 *    但下单成功后要重新生成（否则下一单会被当成重复提交而拿回旧单）。
 */
const theme = useThemeStore();
const session = useSessionStore();
const shop = useShop();

/** 本次提交意图的幂等键 —— 见上文 ④ */
let clientKey = newClientKey();

const remark = ref('');
const submitting = ref(false);
const needLogin = ref(false);
const loginHint = ref('');
const pickedId = ref<number | null>(null);

const addrs = useAsync<{ items: Address[] }>(() => api.addresses());

onLoad(() => {
  void bootstrap();
});

onShow(() => {
  const fromList = takePickedAddress();
  if (fromList !== null) pickedId.value = fromList;
});

/**
 * 单独抽出来而不是把逻辑写进 onLoad 回调：
 * 页面上「重试登录」按钮要能重新跑一遍同一套流程。
 * 写在 onLoad 里就只能靠 uni.reLaunch 自己重进页面，会闪一下白屏。
 */
async function bootstrap(): Promise<void> {
  needLogin.value = false;
  const ok = await session.ensureResolved();
  if (!ok) return;
  shop.bindCart();
  await shop.loadGate();

  // 下单必须登录（浏览可以匿名）。放在这一步而不是"进页面就弹授权"：
  // 到结算这一步学生已经明确要买了，此时弹登录不突兀。
  const logged = await session.ensureLogin();
  if (!logged) {
    needLogin.value = true;
    loginHint.value =
      session.lastError?.code === 'WECHAT_NOT_CONFIGURED'
        ? '服务端还没配置小程序登录（WECHAT_APPID / WECHAT_APPSECRET），暂时无法下单。'
        : '微信登录没有完成，请重试。';
    return;
  }
  await addrs.load();
  // 默认选第一条地址；如果它不在当前楼栋，跨楼栋提示会立刻显示出来
  pickedId.value = defaultAddress.value?.id ?? null;
}

function gotoHome(): void {
  switchTab(TAB.home);
}

/* ------------------------------------------------------------- 计算 */

const addressList = computed(() => addrs.data.value?.items ?? []);

const defaultAddress = computed<Address | null>(
  () => addressList.value.find((a) => a.isDefault) ?? addressList.value[0] ?? null,
);

const pickedAddress = computed<Address | null>(
  () => addressList.value.find((a) => a.id === pickedId.value) ?? defaultAddress.value,
);

/** 跨楼栋：地址楼栋 ≠ 订单楼栋。这一条必须显式拦下来（CS-10） */
const crossBuilding = computed(
  () => !!pickedAddress.value && pickedAddress.value.buildingId !== shop.buildingId.value,
);

const addressBuildingName = computed(() => {
  const b = session.buildings.find((x) => x.buildingId === pickedAddress.value?.buildingId);
  return b?.buildingName ?? `楼栋 ${pickedAddress.value?.buildingId ?? ''}`;
});

const amountCents = computed(() => shop.cart.totalCents);
const deliveryFeeCents = computed(() => session.currentBuilding?.deliveryFeeCents ?? 0);
const totalCents = computed(() => amountCents.value + deliveryFeeCents.value);
const minAmountCents = computed(() => session.currentBuilding?.minAmountCents ?? 0);

/** 起送差额：本地先算，给即时反馈；服务端还会再算一次（它是权威） */
const shortCents = computed(() => Math.max(0, minAmountCents.value - amountCents.value));

/** 提交前的可解释阻塞原因 —— 空字符串表示可以提交 */
const blockReason = computed(() => {
  if (needLogin.value) return loginHint.value;
  if (shop.cart.isEmpty) return '购物车是空的';
  if (shop.cart.hasInvalid) return `「${shop.cart.invalidNames.join('、')}」在本栋已售完，请先回购物车移出`;
  if (!pickedAddress.value) return '请先添加收货地址';
  if (crossBuilding.value) return `地址在「${addressBuildingName.value}」，与当前「${shop.buildingName.value}」不是同一栋，请重新选择`;
  if (!shop.orderable.value) return shop.gate.value?.message ?? '当前不可下单';
  if (shortCents.value > 0) return `还差 ${formatAmount(shortCents.value)} 起送`;
  return '';
});

const canSubmit = computed(() => !blockReason.value && !submitting.value);

/* ------------------------------------------------------------- 操作 */

function gotoAddressList(): void {
  uni.navigateTo({ url: '/pages/address/list?select=1' });
}

function gotoAddAddress(): void {
  uni.navigateTo({ url: '/pages/address/edit' });
}

async function submit(): Promise<void> {
  if (!canSubmit.value) return;
  submitting.value = true;
  try {
    const r = await api.placeOrder({
      buildingId: shop.buildingId.value,
      addressId: pickedAddress.value!.id,
      items: shop.cart.toOrderItems(),
      remark: remark.value.trim() || null,
      clientKey,
    });
    // 下单成功后购物车必须清空，并换一个新的幂等键：
    // 不然下一次下单会带着同一个 key，被服务端当成重复提交而返回这一单
    shop.cart.clear();
    clientKey = newClientKey();
    uni.redirectTo({ url: `/pages/order/pay-result?orderNo=${r.order.orderNo}` });
  } catch (e) {
    // 失败时**不换 key**：这一次提交意图还没成功，重试要能命中幂等
    const msg = e instanceof Error ? e.message : '提交没有成功，请重试';
    toast(msg);
    // 库存 / 闸门类失败：刷新一次闸门与地址，避免界面上还显示"可以下单"
    await shop.loadGate();
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <view class="ck" :style="theme.themeStyle">
    <SnNavBar title="确认订单" />

    <scroll-view scroll-y class="ck__scroll">
      <!-- 未登录 / 无法下单：先把原因说清楚，而不是给一堆点不动的控件 -->
      <SnStateBlock
        v-if="needLogin"
        tone="off"
        glyph="—"
        title="需要先登录才能下单"
        :desc="loginHint"
        primary-text="重试登录"
        @primary="bootstrap"
      />

      <view v-else-if="shop.cart.isEmpty" class="ck__pad">
        <SnStateBlock
          tone="off"
          glyph="—"
          title="购物车是空的"
          desc="回首页挑几件商品再来结算。"
          primary-text="去逛逛"
          @primary="gotoHome"
        />
      </view>

      <SnSkeleton v-else-if="addrs.phase.value === 'loading'" variant="text" />

      <template v-else>
        <!-- ① 地址卡 -->
        <view class="ck__block">
          <view class="ck__card" :class="{ 'is-bad': crossBuilding }" @click="gotoAddressList()">
            <template v-if="pickedAddress">
              <view class="ck__addrhead">
                <text class="ck__addrroom num">{{ pickedAddress.room }}</text>
                <text v-if="pickedAddress.tag" class="ck__addrtag">{{ pickedAddress.tag }}</text>
              </view>
              <text class="ck__addrline">
                {{ addressBuildingName }}
                <text v-if="pickedAddress.floor"> · {{ pickedAddress.floor }} 层</text>
                <text v-if="pickedAddress.contact"> · {{ pickedAddress.contact }}</text>
              </text>
              <text v-if="crossBuilding" class="ck__addrbad">
                这栋不是当前浏览的 {{ shop.buildingName.value }}，换个地址或换栋下单
              </text>
            </template>
            <template v-else>
              <text class="ck__addrempty">还没有收货地址，点这里添加</text>
            </template>
            <view class="ck__chev"><text>›</text></view>
          </view>

          <view v-if="addressList.length === 0" class="ck__addnew" @click="gotoAddAddress">
            <text>+ 新增收货地址</text>
          </view>
        </view>

        <!-- ② 楼栋（不可切换，只显示） -->
        <view class="ck__block">
          <view class="ck__brow">
            <text class="ck__blabel">配送楼栋</text>
            <view class="ck__bchip">
              <text class="ck__bchiptext">{{ shop.buildingName.value || '未选择' }}</text>
            </view>
          </view>
          <text class="ck__bnote">
            楼栋决定库存与配送路线，所以不能在这一页改。
            要换请
            <text class="ck__blink" @click="gotoHome">回首页切换</text>
            （会清空购物车）。
          </text>
        </view>

        <!-- ③ 截单 / 闸门提醒（前置，不等提交才说） -->
        <view v-if="shop.gateTip.value" class="ck__gate" :class="`is-${shop.gateTip.value.tone}`">
          <text class="ck__gatetext">{{ shop.gateTip.value.text }}</text>
          <text v-if="shop.cutoffSeconds.value !== null" class="ck__gatetimer num">
            剩余 {{ shop.cutoffText.value }}
          </text>
        </view>

        <!-- ④ 小票 -->
        <view class="ck__block">
          <view class="ck__receipt">
            <text class="ck__shopname">{{ session.shopName }}</text>
            <SnDivider dashed space="sm" />

            <view v-for="l in shop.cart.lines" :key="l.productId" class="ck__line">
              <text class="ck__linename">{{ l.name }}</text>
              <text class="ck__lineqty num">×{{ l.qty }}</text>
              <SnAmount :fen="l.priceCents * l.qty" size="sm" />
            </view>

            <SnDivider dashed space="sm" />

            <view class="ck__kv"><text class="ck__k">商品小计</text><SnAmount :fen="amountCents" size="sm" /></view>
            <view class="ck__kv">
              <text class="ck__k">配送费</text>
              <SnAmount :fen="deliveryFeeCents" size="sm" :muted="deliveryFeeCents === 0" />
            </view>
            <view class="ck__kv ck__kv--total">
              <text class="ck__k ck__ktotal">合计</text>
              <SnAmount :fen="totalCents" size="lg" />
            </view>
            <text class="ck__note">最终金额以下单时服务端计算为准</text>
          </view>
        </view>

        <!-- ⑤ 备注 -->
        <view class="ck__block">
          <SnInput
            v-model="remark"
            label="备注"
            type="textarea"
            placeholder="比如「放门口」「到了打电话」"
            hint="可留空"
            :maxlength="100"
          />
        </view>

        <!-- 配送方式：v1 只支持送到房间，写出来是为了以后加"楼下自取"时不用改结构 -->
        <view class="ck__block">
          <SnKeyValue label="配送方式" value="送到宿舍房间" />
          <SnKeyValue label="预计送达" value="店家接单后尽快送达" last />
        </view>

        <view class="ck__pad" />
      </template>
    </scroll-view>

    <!-- 吸底合计 + 提交 -->
    <view class="ck__foot">
      <view class="ck__footsum">
        <text class="ck__footlabel">合计</text>
        <SnAmount :fen="totalCents" size="md" />
        <text v-if="shortCents > 0" class="ck__footshort">还差 {{ formatAmount(shortCents) }} 起送</text>
      </view>
      <view class="ck__footbtn">
        <SnButton
          type="pri"
          size="lg"
          :disabled="!canSubmit"
          :disabled-reason="blockReason"
          :loading="submitting"
          loading-text="提交中"
          @click="submit"
        >
          提交订单
        </SnButton>
      </view>
    </view>
  </view>
</template>

<style>
.ck {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  background: var(--paper);
}
.ck__scroll {
  flex: 1;
  min-height: 0;
}
.ck__block {
  padding: var(--sp-3) var(--page-x) 0;
}
.ck__pad {
  height: 96px;
}
.ck__card {
  position: relative;
  background: var(--surface);
  border: var(--bd);
  border-radius: var(--r-md);
  padding: var(--sp-4);
  padding-right: var(--sp-8);
}
/* 跨楼栋是"必须立刻处理"的问题，用 danger 是正确的（AC-02 的判据） */
.ck__card.is-bad {
  border-color: var(--danger);
  background: var(--danger-bg);
}
.ck__addrhead {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
}
.ck__addrroom {
  font-size: var(--fs-card);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}
.ck__addrtag {
  font-size: var(--fs-tag);
  color: var(--ink-500);
}
.ck__addrline {
  display: block;
  margin-top: var(--sp-1);
  font-size: var(--fs-sub);
  color: var(--ink-500);
}
.ck__addrbad {
  display: block;
  margin-top: var(--sp-2);
  font-size: var(--fs-sub);
  color: var(--danger);
  line-height: var(--lh-sub);
}
.ck__addrempty {
  font-size: var(--fs-body);
  color: var(--ink-500);
}
.ck__chev {
  position: absolute;
  top: 50%;
  right: var(--sp-3);
  transform: translateY(-50%);
  color: var(--ink-300);
  font-size: 20px;
}
.ck__addnew {
  margin-top: var(--sp-2);
  height: 40px;
  border-radius: var(--r-md);
  border: var(--bw) dashed var(--line-200);
  display: flex;
  align-items: center;
  justify-content: center;
}
.ck__addnew text {
  font-size: var(--fs-sub);
  color: var(--brand-700);
}
.ck__brow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
}
.ck__blabel {
  font-size: var(--fs-body);
  color: var(--ink-700);
}
.ck__bchip {
  height: 32px;
  padding: 0 var(--sp-3);
  border-radius: var(--r-sm);
  background: var(--building-chip-bg);
  display: flex;
  align-items: center;
}
.ck__bchiptext {
  font-size: var(--fs-sub);
  font-weight: var(--fw-semibold);
  color: var(--building-chip-fg);
}
.ck__bnote {
  display: block;
  margin-top: var(--sp-2);
  font-size: var(--fs-tag);
  color: var(--ink-500);
  line-height: var(--lh-tag);
}
.ck__blink {
  color: var(--brand-700);
  font-weight: var(--fw-medium);
}
.ck__gate {
  margin: var(--sp-3) var(--page-x) 0;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}
.ck__gate.is-ok {
  background: var(--ok-bg);
}
.ck__gate.is-ok .ck__gatetext {
  color: var(--ok);
}
.ck__gate.is-warn {
  background: var(--warn-bg);
}
.ck__gate.is-warn .ck__gatetext {
  color: var(--warn);
}
.ck__gate.is-off {
  background: var(--off-bg);
}
.ck__gate.is-off .ck__gatetext {
  color: var(--off);
}
.ck__gate.is-danger {
  background: var(--danger-bg);
}
.ck__gate.is-danger .ck__gatetext {
  color: var(--danger);
}
.ck__gatetext {
  flex: 1;
  font-size: var(--fs-sub);
  line-height: var(--lh-sub);
}
.ck__gatetimer {
  flex: none;
  font-size: var(--fs-sub);
  font-weight: var(--fw-semibold);
}
.ck__receipt {
  background: var(--surface);
  border: var(--bd);
  border-radius: var(--r-md);
  padding: var(--sp-4);
}
.ck__shopname {
  display: block;
  font-size: var(--fs-card);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}
.ck__line {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-1) 0;
}
.ck__linename {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-body);
  color: var(--ink-700);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.ck__lineqty {
  flex: none;
  font-size: var(--fs-sub);
  color: var(--ink-500);
}
.ck__kv {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-1) 0;
}
.ck__kv--total {
  padding-top: var(--sp-2);
}
.ck__k {
  font-size: var(--fs-body);
  color: var(--ink-700);
}
.ck__ktotal {
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}
.ck__note {
  display: block;
  margin-top: var(--sp-1);
  font-size: var(--fs-tag);
  color: var(--ink-400);
}
.ck__foot {
  flex: none;
  padding: var(--sp-3) var(--page-x);
  padding-bottom: calc(var(--sp-3) + env(safe-area-inset-bottom));
  background: var(--surface);
  box-shadow: var(--sup);
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  z-index: var(--z-absorb);
}
.ck__footsum {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.ck__footlabel {
  font-size: var(--fs-tag);
  color: var(--ink-500);
}
.ck__footshort {
  font-size: var(--fs-tag);
  color: var(--warn);
}
.ck__footbtn {
  flex: none;
  width: 140px;
}
</style>
