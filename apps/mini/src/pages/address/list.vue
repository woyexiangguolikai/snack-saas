<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad, onShow } from '@dcloudio/uni-app';
import SnNavBar from '../../components/SnNavBar.vue';
import SnStateBlock from '../../components/SnStateBlock.vue';
import SnSkeleton from '../../components/SnSkeleton.vue';
import SnTag from '../../components/SnTag.vue';
import SnButton from '../../components/SnButton.vue';
import { useSessionStore } from '../../stores/session';
import { useThemeStore } from '../../stores/theme';
import { useAsync } from '../../composables/useAsync';
import { api, type Address } from '../../utils/api';
import { toast, confirm, switchTab, TAB } from '../../utils/ui';
import { setPickedAddress } from '../../utils/pick';
import SnNetBanner from '../../components/SnNetBanner.vue';

/**
 * S-11a 地址簿。
 *
 * 两种进入方式，用 `select=1` 区分：
 *   · 管理（从「我的」进）—— 点地址卡 → 编辑
 *   · 选择（从结算页进）—— 点地址卡 → 选中并返回
 * 用一个页面而不是两个，是因为两者展示的是同一份数据、同一套排序，
 * 拆开之后"默认地址标记"这类规则必然要写两遍。
 *
 * 默认地址用 brand 强调：它是下单时被自动选中的那条，
 * 学生最需要一眼确认"系统会送到哪儿"。
 */
const theme = useThemeStore();
const session = useSessionStore();

const selectMode = ref(false);
const addrs = useAsync<{ items: Address[] }>(() => api.addresses());

onLoad(async (query) => {
  selectMode.value = String((query as Record<string, string>)?.select ?? '') === '1';
  await session.ensureResolved();
  await addrs.load();
});

onShow(() => {
  // 从新增/编辑页返回时必须重读：否则刚加的地址不出现，学生会以为没保存上
  if (addrs.data.value) void addrs.reload();
});

const items = computed(() => addrs.data.value?.items ?? []);

/** 默认地址排最前，其余保持服务端顺序（服务端已按创建时间排） */
const sorted = computed(() => {
  const def = items.value.filter((a) => a.isDefault);
  const rest = items.value.filter((a) => !a.isDefault);
  return [...def, ...rest];
});

function buildingNameOf(id: number): string {
  return session.buildings.find((b) => b.buildingId === id)?.buildingName ?? `楼栋 ${id}`;
}

function onTap(a: Address): void {
  if (selectMode.value) {
    setPickedAddress(a.id);
    uni.navigateBack();
    return;
  }
  uni.navigateTo({ url: `/pages/address/edit?id=${a.id}` });
}

async function setDefault(a: Address): Promise<void> {
  try {
    await api.updateAddress(a.id, { isDefault: true });
    toast('已设为默认地址');
    await addrs.reload();
  } catch (e) {
    toast(e instanceof Error ? e.message : '设置没有成功');
  }
}

async function remove(a: Address): Promise<void> {
  const yes = await confirm('删除这条地址？', `${buildingNameOf(a.buildingId)} ${a.room}`, '删除');
  if (!yes) return;
  try {
    await api.deleteAddress(a.id);
    toast('地址已删除');
    await addrs.reload();
  } catch (e) {
    toast(e instanceof Error ? e.message : '删除没有成功');
  }
}

function editOne(a: Address): void {
  uni.navigateTo({ url: `/pages/address/edit?id=${a.id}` });
}

function addNew(): void {
  const buildingId = session.currentBuilding?.buildingId ?? 0;
  uni.navigateTo({ url: `/pages/address/edit?buildingId=${buildingId}` });
}

function onBack(): void {
  const pages = getCurrentPages();
  if (pages.length > 1) uni.navigateBack();
  else switchTab(TAB.mine);
}
</script>

<template>
  <view class="al" :style="theme.themeStyle">
    <SnNavBar :title="selectMode ? '选择收货地址' : '地址簿'" @back="onBack" />
    <!-- 网络横幅（§5.2：任何情况下可见）—— 导航栏正下方，不遮挡操作 -->
    <SnNetBanner />

    <scroll-view scroll-y class="al__scroll">
      <view v-if="addrs.phase.value === 'loading'" class="al__skel">
        <SnSkeleton variant="text" />
        <SnSkeleton variant="text" />
      </view>

      <SnStateBlock
        v-else-if="addrs.phase.value === 'error'"
        tone="danger"
        glyph="!"
        title="地址没加载出来"
        :desc="addrs.error.value?.message ?? '网络不太顺，这次没取到数据。点「重新加载」再试一次'"
        primary-text="重新加载"
        @primary="addrs.reload()"
      />

      <SnStateBlock
        v-else-if="!items.length"
        tone="off"
        glyph="—"
        title="还没有收货地址"
        desc="添加一次，之后下单就不用再填了。房间号只有店家能看到。"
        primary-text="添加地址"
        @primary="addNew"
      />

      <view v-else class="al__list">
        <view
          v-for="a in sorted"
          :key="a.id"
          class="al__card"
          :class="{ 'is-default': a.isDefault }"
          @click="onTap(a)"
        >
          <view class="al__head">
            <text class="al__room num">{{ a.room }}</text>
            <SnTag v-if="a.isDefault" tone="brand" label="默认" />
            <text v-if="a.tag" class="al__tag">{{ a.tag }}</text>
          </view>
          <text class="al__line">
            {{ buildingNameOf(a.buildingId) }}
            <text v-if="a.floor"> · {{ a.floor }} 层</text>
            <text v-if="a.contact"> · {{ a.contact }}</text>
            <text v-if="a.phone"> · {{ a.phone }}</text>
          </text>

          <view class="al__acts">
            <text v-if="!a.isDefault" class="al__act" @click.stop="setDefault(a)">设为默认</text>
            <text class="al__act" @click.stop="editOne(a)">编辑</text>
            <text class="al__act is-danger" @click.stop="remove(a)">删除</text>
          </view>
        </view>
      </view>

      <!-- 底部楼栋说明：地址的楼栋只用于校验收货位置，不决定订单楼栋 -->
      <view v-if="items.length" class="al__note">
        <text class="al__notetitle">关于楼栋</text>
        <text class="al__notetext">
          地址上的楼栋是用来核对"你人在哪一栋"的。
          下单时的楼栋以你在首页选的为准 —— 两者不一致会拦下来，
          免得货送到你不在的楼里。
        </text>
      </view>

      <view class="al__pad" />
    </scroll-view>

    <view v-if="items.length" class="al__foot">
      <SnButton type="pri" size="lg" block @click="addNew">新增地址</SnButton>
    </view>
  </view>
</template>

<style>
.al {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  background: var(--paper);
}
.al__scroll {
  flex: 1;
  min-height: 0;
}
.al__skel {
  padding: var(--sp-5) var(--page-x);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.al__list {
  padding: var(--sp-3) var(--page-x) 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.al__card {
  background: var(--surface);
  border: var(--bd);
  border-radius: var(--r-md);
  padding: var(--sp-4);
}
/* 默认地址用品牌色描边强调 —— 它是下单时会被自动选中的那条 */
.al__card.is-default {
  border-color: var(--brand-500);
  background: var(--brand-50);
}
.al__head {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
}
.al__room {
  font-size: var(--fs-card);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}
.al__tag {
  font-size: var(--fs-tag);
  color: var(--ink-500);
}
.al__line {
  display: block;
  margin-top: var(--sp-2);
  font-size: var(--fs-sub);
  color: var(--ink-500);
  line-height: var(--lh-sub);
}
.al__acts {
  margin-top: var(--sp-3);
  padding-top: var(--sp-2);
  border-top: var(--bd);
  display: flex;
  align-items: center;
  gap: var(--sp-5);
}
.al__act {
  font-size: var(--fs-sub);
  color: var(--ink-700);
}
.al__act.is-danger {
  color: var(--danger);
}
.al__note {
  margin: var(--sp-5) var(--page-x) 0;
  padding: var(--sp-3);
  border-radius: var(--r-md);
  background: var(--line-100);
}
.al__notetitle {
  display: block;
  font-size: var(--fs-sub);
  font-weight: var(--fw-semibold);
  color: var(--ink-700);
}
.al__notetext {
  display: block;
  margin-top: var(--sp-1);
  font-size: var(--fs-tag);
  color: var(--ink-500);
  line-height: var(--lh-tag);
}
.al__pad {
  height: 96px;
}
.al__foot {
  flex: none;
  padding: var(--sp-3) var(--page-x);
  padding-bottom: calc(var(--sp-3) + env(safe-area-inset-bottom));
  background: var(--surface);
  box-shadow: var(--sup);
}
</style>
