<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import SnNavBar from '../../components/SnNavBar.vue';
import SnInput from '../../components/SnInput.vue';
import SnSwitch from '../../components/SnSwitch.vue';
import SnButton from '../../components/SnButton.vue';
import SnChip from '../../components/SnChip.vue';
import SnBuildingSheet from '../../components/SnBuildingSheet.vue';
import { useSessionStore } from '../../stores/session';
import { useThemeStore } from '../../stores/theme';
import { api } from '../../utils/api';
import { toast } from '../../utils/ui';

/**
 * S-11b 地址新增 / 编辑。
 *
 * 三条与"房间号"有关的纪律（§4.13 隐私硬要求）：
 *  ① 房间号**不进平台库、不进日志**。所以这一页提交时只发到租户接口，
 *     不附带任何平台维度的字段。
 *  ② 房间号**不做正则强校验**。各校写法不一（302 / 3-302 / A302），
 *     强校验只会把真实存在的写法挡在外面，逼学生乱填一个能过的值。
 *     只校验"非空 + 长度合理"。
 *  ③ 隐私说明就在这一页里明说：房间号会提供给店家用于配送。
 *     这条必须让学生**在填写时**看到，而不是藏在"我的-隐私政策"里。
 */
const theme = useThemeStore();
const session = useSessionStore();

const editingId = ref<number | null>(null);
const showBuilding = ref(false);
const submitting = ref(false);

const form = ref({
  buildingId: 0,
  floor: '',
  room: '',
  contact: '',
  phone: '',
  tag: '',
  isDefault: false,
});

const TAGS = ['我自己', '帮同学带', '放门口'];

onLoad(async (query) => {
  const q = (query ?? {}) as Record<string, string>;
  const id = Number(q.id ?? 0);
  await session.ensureResolved();

  // 默认楼栋 = 当前浏览的楼栋（学生几乎总是给同一栋下单）
  form.value.buildingId = Number(q.buildingId ?? 0) || session.currentBuilding?.buildingId || 0;

  if (id) {
    editingId.value = id;
    try {
      const { items } = await api.addresses();
      const a = items.find((x) => x.id === id);
      if (a) {
        form.value = {
          buildingId: a.buildingId,
          floor: a.floor ?? '',
          room: a.room,
          contact: a.contact ?? '',
          phone: a.phone ?? '',
          tag: a.tag ?? '',
          isDefault: a.isDefault,
        };
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : '地址没读到');
    }
  }
});

const buildingName = computed(
  () => session.buildings.find((b) => b.buildingId === form.value.buildingId)?.buildingName ?? '请选择楼栋',
);

const roomError = computed(() => {
  const r = form.value.room.trim();
  if (!r) return '请填写房间号，店家靠它找到你';
  if (r.length > 32) return '房间号太长了，最多 32 个字';
  return '';
});

/** 电话：只校验"填了的话得像手机号/短号"，不强制填 */
const phoneError = computed(() => {
  const p = form.value.phone.trim();
  if (!p) return '';
  if (!/^[\d\-+ ]{5,20}$/.test(p)) return '电话号码格式看起来不对';
  return '';
});

const canSubmit = computed(
  () => !roomError.value && !phoneError.value && form.value.buildingId > 0 && !submitting.value,
);

function pickBuilding(id: number): void {
  form.value.buildingId = id;
}

async function submit(): Promise<void> {
  if (!canSubmit.value) return;
  submitting.value = true;
  try {
    const payload = {
      buildingId: form.value.buildingId,
      floor: form.value.floor.trim() || null,
      room: form.value.room.trim(),
      contact: form.value.contact.trim() || null,
      phone: form.value.phone.trim() || null,
      tag: form.value.tag.trim() || null,
      isDefault: form.value.isDefault,
    };
    if (editingId.value) await api.updateAddress(editingId.value, payload);
    else await api.createAddress(payload);
    toast(editingId.value ? '地址已保存' : '地址已添加');
    setTimeout(() => uni.navigateBack(), 400);
  } catch (e) {
    toast(e instanceof Error ? e.message : '保存没有成功，请重试');
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <view class="ae" :style="theme.themeStyle">
    <SnNavBar :title="editingId ? '编辑地址' : '新增地址'" />

    <scroll-view scroll-y class="ae__scroll">
      <view class="ae__block">
        <text class="ae__label">宿舍楼</text>
        <view class="ae__bchip" @click="showBuilding = true">
          <text class="ae__bname">{{ buildingName }}</text>
          <text class="ae__bchev">⌄</text>
        </view>
        <text class="ae__hint">地址的楼栋必须与下单的楼栋一致，否则下单会被拦下来</text>
      </view>

      <view class="ae__block">
        <SnInput
          v-model="form.floor"
          label="楼层"
          placeholder="3 层"
          hint="可留空"
          :maxlength="10"
        />
      </view>

      <view class="ae__block">
        <SnInput
          v-model="form.room"
          label="房间号"
          required
          placeholder="302 室"
          :error="roomError"
          helper="各校写法不一，按你们宿舍的实际写法填即可"
          :maxlength="32"
        />
      </view>

      <view class="ae__block">
        <SnInput
          v-model="form.contact"
          label="联系人"
          placeholder="你的名字或称呼"
          hint="可留空"
          :maxlength="16"
        />
      </view>

      <view class="ae__block">
        <SnInput
          v-model="form.phone"
          label="联系电话"
          type="number"
          placeholder="送到时联系的号码"
          hint="可留空"
          :error="phoneError"
          :maxlength="20"
        />
      </view>

      <view class="ae__block">
        <text class="ae__label">标签</text>
        <view class="ae__chips">
          <SnChip
            v-for="t in TAGS"
            :key="t"
            :label="t"
            :selected="form.tag === t"
            @click="form.tag = form.tag === t ? '' : t"
          />
        </view>
        <text class="ae__hint">方便你在订单里区分是哪一条地址</text>
      </view>

      <view class="ae__block">
        <SnSwitch
          v-model="form.isDefault"
          label="设为默认地址"
          description="下单时自动选它，省一次点击"
        />
      </view>

      <!-- 房间号隐私披露：必须让学生**在填写时**看到（§4.13.4） -->
      <view class="ae__block">
        <view class="ae__privacy">
          <text class="ae__privacytitle">关于房间号</text>
          <text class="ae__privacytext">
            房间号只提供给这家店的店主，用于把货送到你手上；
            它不会进入平台的数据报表，也不会出现在任何你能搜到的地方。
            其他同学看不到你的房间号。
          </text>
        </view>
      </view>

      <view class="ae__pad" />
    </scroll-view>

    <view class="ae__foot">
      <SnButton
        type="pri"
        size="lg"
        block
        :disabled="!canSubmit"
        :disabled-reason="roomError || phoneError || (form.buildingId ? '' : '请先选择宿舍楼')"
        :loading="submitting"
        loading-text="保存中"
        @click="submit"
      >
        {{ editingId ? '保存修改' : '添加地址' }}
      </SnButton>
    </view>

    <SnBuildingSheet
      v-model="showBuilding"
      :buildings="session.buildings"
      :current-id="form.buildingId"
      :locked="false"
      :allow-paused="true"
      @pick="pickBuilding"
    />
  </view>
</template>

<style>
.ae {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  background: var(--paper);
}
.ae__scroll {
  flex: 1;
  min-height: 0;
}
.ae__block {
  padding: var(--sp-3) var(--page-x) 0;
}
.ae__label {
  display: block;
  margin-bottom: var(--sp-1);
  font-size: var(--fs-sub);
  font-weight: var(--fw-medium);
  color: var(--ink-700);
}
.ae__bchip {
  height: 46px;
  padding: 0 var(--sp-3);
  border-radius: var(--r-md);
  background: var(--building-chip-bg);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
}
.ae__bname {
  font-size: var(--fs-card);
  font-weight: var(--fw-semibold);
  color: var(--building-chip-fg);
}
.ae__bchev {
  font-size: var(--fs-card);
  color: var(--building-chip-fg);
}
.ae__hint {
  display: block;
  margin-top: var(--sp-1);
  font-size: var(--fs-tag);
  color: var(--ink-500);
  line-height: var(--lh-tag);
}
.ae__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}
.ae__privacy {
  padding: var(--sp-3);
  border-radius: var(--r-md);
  background: var(--brand-50);
}
.ae__privacytitle {
  display: block;
  font-size: var(--fs-sub);
  font-weight: var(--fw-semibold);
  color: var(--brand-700);
}
.ae__privacytext {
  display: block;
  margin-top: var(--sp-1);
  font-size: var(--fs-tag);
  color: var(--ink-700);
  line-height: var(--lh-tag);
}
.ae__pad {
  height: 96px;
}
.ae__foot {
  flex: none;
  padding: var(--sp-3) var(--page-x);
  padding-bottom: calc(var(--sp-3) + env(safe-area-inset-bottom));
  background: var(--surface);
  box-shadow: var(--sup);
}
</style>
