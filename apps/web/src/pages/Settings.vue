<script setup lang="ts">
/**
 * W-09 店铺设置。
 *
 * 两处必须"说清后果"而不是只给一个开关：
 *   ① 关店：学生仍能看到商品但下不了单 —— 这个区别要写出来，
 *      否则商户以为关店=店铺消失，或以为关店了学生还能下单。
 *   ② 主题色：服务端有护栏（AC-06），太浅的颜色会被自动调整以保证对比度。
 *      调整了要**回显提示**，不能默默改掉让人以为提交失败。
 */
import { ref, watch } from 'vue';
import { api } from '@/api';
import { useLoad, messageOf } from '@/composables/useLoad';
import { toast } from '@/utils/feedback';
import { centsToYuan, sanitizeYuan, yuanToCents } from '@/utils/money';
import Modal from '@/components/Modal.vue';
import Panel from '@/components/Panel.vue';
import PageHeader from '@/components/PageHeader.vue';
import ErrorBanner from '@/components/ErrorBanner.vue';

const config = useLoad(() => api.config());

const form = ref({
  shopName: '',
  announcement: '',
  contactPhone: '',
  openTime: '',
  closeTime: '',
  minAmount: '',
  deliveryFee: '',
  accessibleFrom: '',
  accessibleTo: '',
  cutoffLeadMinutes: 30,
  themeColor: '',
});

watch(
  () => config.data.value,
  (c) => {
    if (!c) return;
    const s = c.shop;
    form.value = {
      shopName: s.shopName ?? '',
      announcement: s.announcement ?? '',
      contactPhone: s.contactPhone ?? '',
      openTime: s.openTime ?? '',
      closeTime: s.closeTime ?? '',
      minAmount: centsToYuan(s.minAmountCents ?? 0),
      deliveryFee: centsToYuan(s.deliveryFeeCents ?? 0),
      accessibleFrom: s.accessibleFrom ?? '',
      accessibleTo: s.accessibleTo ?? '',
      cutoffLeadMinutes: s.cutoffLeadMinutes ?? 30,
      // 主题色不留默认值：留空表示不改。写死一个默认色等于把品牌色复制了一份
      themeColor: '',
    };
  },
);

const saving = ref(false);
const confirmClose = ref(false);

async function save(patch: Record<string, unknown> = {}): Promise<void> {
  saving.value = true;
  try {
    const body: Record<string, unknown> = {
      shopName: form.value.shopName.trim(),
      announcement: form.value.announcement.trim() || null,
      contactPhone: form.value.contactPhone.trim() || null,
      openTime: form.value.openTime || null,
      closeTime: form.value.closeTime || null,
      minAmountCents: yuanToCents(form.value.minAmount),
      deliveryFeeCents: yuanToCents(form.value.deliveryFee),
      accessibleFrom: form.value.accessibleFrom || null,
      accessibleTo: form.value.accessibleTo || null,
      cutoffLeadMinutes: Number(form.value.cutoffLeadMinutes) || 0,
      ...patch,
    };
    // 只有真的填了才提交主题色 —— 空字符串会被当成"要改成空"
    if (form.value.themeColor.trim()) body.themeColor = form.value.themeColor.trim();

    await api.saveConfig(body);
    await config.run();
    const notice = config.data.value?.shop.themeNotice;
    toast(notice ?? '已保存', notice ? 'warn' : 'ok');
  } catch (e) {
    toast(messageOf(e), 'danger');
  } finally {
    saving.value = false;
  }
}

async function setShopOpen(open: boolean): Promise<void> {
  confirmClose.value = false;
  await save({ shopOpen: open });
  toast(open ? '已开店，可以接单了' : '已打烊，学生可以看到商品但下不了单', 'ok');
}

const shopOpen = () => config.data.value?.shop.shopOpen ?? false;
</script>

<template>
  <div>
    <PageHeader code="W-09" title="店铺设置" desc="改完立即生效，不用发版。营业时间超出门禁会自动收窄。" />

    <ErrorBanner :text="config.error.value" @retry="config.run()" />

    <Panel title="营业状态">
      <div class="row">
        <span class="state" :class="shopOpen() ? 'state--on' : 'state--off'">
          {{ shopOpen() ? '营业中' : '已打烊' }}
        </span>
        <span class="sub muted">打烊后学生仍可浏览商品，但不能下单。</span>
        <div class="spacer" />
        <button
          class="btn"
          :class="shopOpen() ? 'btn--danger' : 'btn--primary'"
          type="button"
          :disabled="saving"
          @click="shopOpen() ? (confirmClose = true) : setShopOpen(true)"
        >
          {{ shopOpen() ? '打烊' : '开店' }}
        </button>
      </div>
    </Panel>

    <Panel title="基础信息">
      <div class="grid2">
        <div class="field">
          <label class="field__label">店铺名称</label>
          <input v-model="form.shopName" class="input" />
        </div>
        <div class="field">
          <label class="field__label">联系电话</label>
          <input v-model="form.contactPhone" class="input num" placeholder="学生下单后可看到" />
        </div>
      </div>
      <div class="field">
        <label class="field__label">店铺公告</label>
        <textarea v-model="form.announcement" class="input" placeholder="如 今晚只送到 21:00" />
      </div>
    </Panel>

    <Panel title="价格与时间">
      <div class="grid2">
        <div class="field">
          <label class="field__label">起送价（元）</label>
          <input v-model="form.minAmount" class="input num" @input="form.minAmount = sanitizeYuan(form.minAmount)" />
        </div>
        <div class="field">
          <label class="field__label">配送费（元）</label>
          <input v-model="form.deliveryFee" class="input num" @input="form.deliveryFee = sanitizeYuan(form.deliveryFee)" />
        </div>
      </div>
      <div class="grid4">
        <div class="field">
          <label class="field__label">开门</label>
          <input v-model="form.openTime" class="input num" placeholder="09:00" />
        </div>
        <div class="field">
          <label class="field__label">关门</label>
          <input v-model="form.closeTime" class="input num" placeholder="22:00" />
        </div>
        <div class="field">
          <label class="field__label">门禁开始</label>
          <input v-model="form.accessibleFrom" class="input num" placeholder="06:30" />
        </div>
        <div class="field">
          <label class="field__label">门禁结束</label>
          <input v-model="form.accessibleTo" class="input num" placeholder="22:30" />
        </div>
      </div>
      <div class="field" style="max-width: 240px">
        <label class="field__label">在途预留（分钟）</label>
        <input v-model.number="form.cutoffLeadMinutes" class="input num" type="number" min="0" max="240" />
        <span class="field__hint">截单时间 = 门禁结束 − 在途预留，由系统算出</span>
      </div>
    </Panel>

    <Panel title="品牌色">
      <div class="field" style="max-width: 260px">
        <label class="field__label">主题色</label>
        <input v-model="form.themeColor" class="input" placeholder="留空表示不改" />
        <span class="field__hint">过浅的颜色会被自动加深以保证文字可读，结果会提示给你</span>
      </div>
      <p v-if="config.data.value?.shop.themeNotice" class="hint">{{ config.data.value.shop.themeNotice }}</p>
    </Panel>

    <div class="row foot">
      <div class="spacer" />
      <button class="btn" type="button" :disabled="!config.data.value" @click="config.run()">放弃修改</button>
      <button class="btn btn--primary" type="button" :disabled="saving || !config.data.value" @click="save()">保存</button>
    </div>

    <Modal :open="confirmClose" title="确认打烊" @close="confirmClose = false">
      <ul class="note">
        <li>学生仍能看到商品和价格，但下不了单</li>
        <li>已下单的订单不受影响，继续正常配送</li>
        <li>库存与商品配置全部保留，重新开店即可恢复</li>
      </ul>
      <template #footer>
        <button class="btn" type="button" @click="confirmClose = false">再想想</button>
        <button class="btn btn--danger" type="button" @click="setShopOpen(false)">确认打烊</button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-3);
  margin-bottom: var(--sp-3);
}
.grid4 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: var(--sp-3);
  margin-bottom: var(--sp-3);
}
.state {
  padding: 2px var(--sp-2);
  border-radius: var(--r-sm);
  font-size: var(--fs-sub);
  font-weight: var(--fw-medium);
}
.state--on {
  background: var(--ok-bg);
  color: var(--ok);
}
.state--off {
  background: var(--off-bg);
  color: var(--off);
}
.note {
  margin: 0;
  padding-left: var(--sp-5);
  font-size: var(--fs-sub);
  line-height: var(--lh-sub);
  color: var(--ink-700);
}
.hint {
  margin: var(--sp-2) 0 0;
  padding: var(--sp-2) var(--sp-3);
  background: var(--warn-bg);
  color: var(--warn);
  border-radius: var(--r-md);
  font-size: var(--fs-sub);
}
.foot {
  margin-top: var(--sp-4);
}
</style>
