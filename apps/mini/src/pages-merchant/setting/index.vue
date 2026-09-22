<script setup lang="ts">
import { ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import SnNavBar from '../../components/SnNavBar.vue';
import SnInput from '../../components/SnInput.vue';
import SnButton from '../../components/SnButton.vue';
import SnStateBlock from '../../components/SnStateBlock.vue';
import SnSkeleton from '../../components/SnSkeleton.vue';
import { useThemeStore } from '../../stores/theme';
import { useMerchantStore } from '../../stores/merchant';
import { mapi } from '../../utils/mapi';
import { toast } from '../../utils/ui';
import SnNetBanner from '../../components/SnNetBanner.vue';

/**
 * M-10 店铺设置。
 *
 * 全部走**配置下发**，改完不需要发版（§2.3）—— 这是"商户日常运营 100% 不用等我们"
 * 的落点。所以这里也**不提供**任何需要改代码才能生效的项。
 *
 * 两处"帮商户改了"必须回显，不能静默：
 *   ① 营业时间超出门禁窗口 → 服务端自动收窄，保存后回显的就是收窄后的值；
 *   ② 主题色对比度不足 4.5:1 → 服务端自动加深，并把 `themeNotice` 回给前端显示。
 * 静默接受非法值或静默改掉用户输入，都会让商户以为"我填的没生效"。
 */
const theme = useThemeStore();
const merchant = useMerchantStore();

const loading = ref(true);
const saving = ref(false);
const themeNotice = ref<string | null>(null);

const shopName = ref('');
const announcement = ref('');
const contactPhone = ref('');
const openTime = ref('');
const closeTime = ref('');
const minYuan = ref('');
const feeYuan = ref('');
const themeColor = ref('');

onLoad(() => void boot());

async function boot(): Promise<void> {
  const ok = await merchant.ensure();
  if (!ok) {
    loading.value = false;
    return;
  }
  await load();
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const c = await mapi.config();
    const s = c.shop;
    shopName.value = s.shopName;
    announcement.value = s.announcement ?? '';
    contactPhone.value = s.contactPhone ?? '';
    openTime.value = s.openTime ?? '';
    closeTime.value = s.closeTime ?? '';
    minYuan.value = (s.minAmountCents / 100).toFixed(2);
    feeYuan.value = (s.deliveryFeeCents / 100).toFixed(2);
    themeNotice.value = s.themeNotice ?? null;
  } catch (e) {
    toast(e instanceof Error ? e.message : '设置没有加载出来，请重试');
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  if (saving.value) return;
  const min = Math.round(Number(minYuan.value) * 100);
  const fee = Math.round(Number(feeYuan.value) * 100);
  if (!shopName.value.trim()) {
    toast('店铺名称不能为空');
    return;
  }
  if (!Number.isFinite(min) || min < 0 || !Number.isFinite(fee) || fee < 0) {
    toast('起送价与配送费必须是数字');
    return;
  }
  saving.value = true;
  try {
    await mapi.saveConfig({
      shopName: shopName.value.trim(),
      announcement: announcement.value.trim() || null,
      contactPhone: contactPhone.value.trim() || null,
      openTime: openTime.value || null,
      closeTime: closeTime.value || null,
      minAmountCents: min,
      deliveryFeeCents: fee,
      ...(themeColor.value.trim() ? { themeColor: themeColor.value.trim() } : {}),
    });
    themeColor.value = '';
    await load();
    toast('已保存，学生端立即生效');
  } catch (e) {
    toast(e instanceof Error ? e.message : '保存没有完成，请重试');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <view class="st" :style="theme.themeStyle">
    <SnNavBar title="店铺设置" />
    <!-- 网络横幅（§5.2：任何情况下可见）—— 导航栏正下方，不遮挡操作 -->
    <SnNetBanner />

    <scroll-view scroll-y class="st__scroll">
      <view v-if="loading" class="st__skel">
        <SnSkeleton variant="text" />
        <SnSkeleton variant="text" />
        <SnSkeleton variant="text" />
      </view>

      <template v-else>
        <view class="st__card">
          <SnInput v-model="shopName" label="店铺名称" placeholder="如 张姐零食铺" />
          <SnInput v-model="contactPhone" label="客服电话" type="text" placeholder="如 13800000000" hint="可留空" />
          <SnInput v-model="announcement" label="店铺公告" type="textarea" placeholder="如 今晚 21:30 截单" hint="可留空" />
        </view>

        <view class="st__card">
          <text class="st__title">营业时间</text>
          <SnInput v-model="openTime" label="开始" placeholder="如 09:00" />
          <SnInput v-model="closeTime" label="结束" placeholder="如 22:00" />
          <text class="st__tip">
            营业时间必须落在宿舍可进入的时间窗内，超出部分系统会自动收窄，保存后回显的是生效值。
          </text>
        </view>

        <view class="st__card">
          <text class="st__title">配送规则</text>
          <SnInput v-model="minYuan" label="起送价" type="digit" placeholder="如 15.00" hint="单位：元" />
          <SnInput v-model="feeYuan" label="配送费" type="digit" placeholder="如 1.00" hint="单位：元" />
        </view>

        <view class="st__card">
          <text class="st__title">主题色</text>
          <!-- 占位示例刻意不写具体色值：色值一律走 Token，示例里出现裸色值
               会同时破坏 AC-04 扫描，也会让人照抄一个不是本店色的值 -->
          <SnInput v-model="themeColor" label="品牌色" placeholder="如 六位十六进制色值" hint="可留空表示不改" />
          <text v-if="themeNotice" class="st__notice">{{ themeNotice }}</text>
          <text class="st__tip">
            颜色对比度不足时系统会自动加深以保证文字可读，结果会在这里提示。
          </text>
        </view>

        <view class="st__save">
          <SnButton block size="md" type="pri" :loading="saving" @click="save">保存</SnButton>
          <text class="st__savetip">保存后学生端立即生效，不需要重新发布小程序。</text>
        </view>
        <view class="st__pad" />
      </template>
    </scroll-view>
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
.st__scroll {
  flex: 1;
  min-height: 0;
}
.st__skel {
  padding: var(--sp-5) var(--page-x);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.st__card {
  margin: var(--sp-3) var(--page-x);
  padding: var(--sp-3) var(--sp-4);
  background: var(--surface);
  border-radius: var(--r-md);
}
.st__title {
  display: block;
  font-size: var(--fs-sub);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
  margin-bottom: var(--sp-2);
}
.st__tip {
  display: block;
  margin-top: var(--sp-2);
  font-size: var(--fs-tag);
  color: var(--ink-400);
  line-height: var(--lh-body);
}
.st__notice {
  display: block;
  margin-top: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  background: var(--info-bg);
  border-radius: var(--r-sm);
  font-size: var(--fs-tag);
  color: var(--ink-700);
}
.st__save {
  padding: var(--sp-3) var(--page-x);
}
.st__savetip {
  display: block;
  margin-top: var(--sp-2);
  font-size: var(--fs-tag);
  color: var(--ink-400);
  text-align: center;
}
.st__pad {
  height: var(--sp-6);
}
</style>
