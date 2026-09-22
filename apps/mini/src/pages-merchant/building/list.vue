<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad, onPullDownRefresh } from '@dcloudio/uni-app';
import SnNavBar from '../../components/SnNavBar.vue';
import SnSwitch from '../../components/SnSwitch.vue';
import SnButton from '../../components/SnButton.vue';
import SnSheet from '../../components/SnSheet.vue';
import SnInput from '../../components/SnInput.vue';
import SnStateBlock from '../../components/SnStateBlock.vue';
import SnSkeleton from '../../components/SnSkeleton.vue';
import { useThemeStore } from '../../stores/theme';
import { useMerchantStore } from '../../stores/merchant';
import { useAsync } from '../../composables/useAsync';
import { mapi, type MerchantBuilding } from '../../utils/mapi';
import { toast, confirm, pullRefresh } from '../../utils/ui';
import SnNetBanner from '../../components/SnNetBanner.vue';

/**
 * M-08 楼栋与配送（CM-06）。
 *
 * 两个动作必须分开，因为它们的**代价完全不同**：
 *   · **今日停送**（可逆、轻确认）：库存数值原样保留，学生端显示"今日已停送"；
 *   · **停用**（不可逆、二次确认）：有历史订单引用，所以只能停用不能删除（§4.8）。
 *
 * 界面上必须写明"停用后库存保留不清零" —— 否则商户会以为关停等于清货，
 * 然后在恢复时对着空货架发懵。
 */
const theme = useThemeStore();
const merchant = useMerchantStore();

const list = useAsync<{ buildings: MerchantBuilding[]; singleBuildingMode: boolean }>(() => mapi.buildings());
const adding = ref(false);
const newName = ref('');
const busyId = ref<number | null>(null);

onLoad(() => void boot());
onPullDownRefresh(() =>
  pullRefresh(async () => {
    await list.reload();
  }),
);

async function boot(): Promise<void> {
  const ok = await merchant.ensure();
  if (!ok) return;
  await list.load();
}

const buildings = computed(() => list.data.value?.buildings ?? []);

function money(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`;
}

async function toggleDelivery(b: MerchantBuilding, next: boolean): Promise<void> {
  busyId.value = b.id;
  try {
    await mapi.updateBuilding(b.id, { deliveryEnabled: next });
    toast(next ? '已恢复配送' : '今日已停送，库存保留');
    await list.reload();
  } catch (e) {
    toast(e instanceof Error ? e.message : '设置没有生效，请重试');
  } finally {
    busyId.value = null;
  }
}

async function disable(b: MerchantBuilding): Promise<void> {
  const yes = await confirm(
    `停用「${b.name}」？`,
    '停用后学生在小程序里选不到这栋楼，历史订单完整保留，各栋库存数值也保留。停用在后台不可撤销，需要恢复请联系平台。',
    '确认停用',
  );
  if (!yes) return;
  busyId.value = b.id;
  try {
    await mapi.disableBuilding(b.id);
    toast('已停用');
    await list.reload();
  } catch (e) {
    toast(e instanceof Error ? e.message : '停用没有完成，请重试');
  } finally {
    busyId.value = null;
  }
}

async function create(): Promise<void> {
  const name = newName.value.trim();
  if (!name) {
    toast('请填写楼栋名称');
    return;
  }
  try {
    await mapi.createBuilding(name);
    newName.value = '';
    adding.value = false;
    toast('已新增楼栋');
    await list.reload();
  } catch (e) {
    toast(e instanceof Error ? e.message : '新增没有完成，请重试');
  }
}
</script>

<template>
  <view class="bl" :style="theme.themeStyle">
    <SnNavBar title="楼栋与配送" />
    <!-- 网络横幅（§5.2：任何情况下可见）—— 导航栏正下方，不遮挡操作 -->
    <SnNetBanner />

    <scroll-view scroll-y class="bl__scroll">
      <view v-if="list.phase.value === 'loading'" class="bl__skel">
        <SnSkeleton variant="text" />
        <SnSkeleton variant="text" />
      </view>

      <SnStateBlock
        v-else-if="list.phase.value === 'error'"
        tone="danger"
        glyph="!"
        title="楼栋没加载出来"
        :desc="list.error.value?.message ?? '网络不太顺，这次没取到数据。点「重新加载」再试一次'"
        primary-text="重新加载"
        @primary="list.reload()"
      />

      <template v-else>
        <view class="bl__note">
          <text class="bl__notetext">
            今日停送只影响今天，库存数值保留；停用后学生选不到该楼栋，历史订单与库存同样保留。
          </text>
        </view>

        <view v-for="b in buildings" :key="b.id" class="bl__row">
          <view class="bl__head">
            <text class="bl__name">{{ b.name }}</text>
            <text v-if="b.status === 'disabled'" class="bl__off">已停用</text>
          </view>
          <text class="bl__meta">
            起送 {{ money(b.resolved.minAmountCents) }} · 配送费 {{ money(b.resolved.deliveryFeeCents) }}
            · 截单 {{ b.resolved.cutoffTime }}
          </text>
          <view class="bl__ops">
            <SnSwitch
              :model-value="b.resolved.deliveryEnabled"
              :disabled="b.status === 'disabled' || busyId === b.id"
              :disabled-reason="b.status === 'disabled' ? '已停用' : ''"
              label="今日配送"
              description="关掉后学生看到「今日已停送」，库存保留"
              @change="(v: boolean) => toggleDelivery(b, v)"
            />
            <SnButton
              v-if="b.status === 'active'"
              size="sm"
              type="dan"
              :disabled="busyId === b.id"
              @click="disable(b)"
            >
              停用
            </SnButton>
          </view>
        </view>

        <view class="bl__add">
          <SnButton block size="md" type="sec" @click="adding = true">新增楼栋</SnButton>
        </view>
        <view class="bl__pad" />
      </template>
    </scroll-view>

    <SnSheet :model-value="adding" title="新增楼栋" @update:model-value="adding = false">
      <view class="bl__sheet">
        <SnInput v-model="newName" label="楼栋名称" placeholder="如 3 号楼" />
        <SnButton block size="md" type="pri" @click="create">确认新增</SnButton>
        <text class="bl__sheettip">
          新增后默认同步店铺的起送价与配送费，需要单独调整可在电脑端改。
        </text>
      </view>
    </SnSheet>
  </view>
</template>

<style>
.bl {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  background: var(--paper);
}
.bl__scroll {
  flex: 1;
  min-height: 0;
}
.bl__skel {
  padding: var(--sp-5) var(--page-x);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.bl__note {
  margin: var(--sp-3) var(--page-x);
  padding: var(--sp-3);
  background: var(--info-bg);
  border-radius: var(--r-md);
}
.bl__notetext {
  font-size: var(--fs-tag);
  color: var(--ink-700);
  line-height: var(--lh-body);
}
.bl__row {
  margin: 0 var(--page-x) var(--sp-3);
  padding: var(--sp-4);
  background: var(--surface);
  border-radius: var(--r-md);
}
.bl__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.bl__name {
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}
.bl__off {
  font-size: var(--fs-tag);
  color: var(--ink-400);
}
.bl__meta {
  margin-top: var(--sp-1);
  font-size: var(--fs-tag);
  color: var(--ink-500);
}
.bl__ops {
  margin-top: var(--sp-3);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
}
.bl__add {
  padding: var(--sp-3) var(--page-x);
}
.bl__sheet {
  padding: var(--sp-4) var(--page-x);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.bl__sheettip {
  font-size: var(--fs-tag);
  color: var(--ink-400);
  line-height: var(--lh-body);
}
.bl__pad {
  height: var(--sp-6);
}
</style>
