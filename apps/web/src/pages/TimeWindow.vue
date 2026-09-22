<script setup lang="ts">
/**
 * W-03 时间窗配置（CW-06）。
 *
 * 这一页的**核心纪律**：截单时间是**算出来的，不可直填**。
 * 允许直填就等于允许"下了单送不到"，一条这样的订单够学生在群里说一晚。
 *
 * 三层嵌套关系必须在界面上一眼可见：
 *   门禁时间（学生能进楼的时间）⊃ 营业时间（店铺开门的时间）⊃ 可下单区间（到截单为止）
 * 营业时间若超出门禁会自动收窄，界面要说"已帮你收窄"，而不是"你填错了"。
 */
import { computed, ref, watch } from 'vue';
import { api } from '@/api';
import { useLoad, messageOf } from '@/composables/useLoad';
import { toast } from '@/utils/feedback';
import { centsToYuan, sanitizeYuan, yuanToCents } from '@/utils/money';
import Panel from '@/components/Panel.vue';
import PageHeader from '@/components/PageHeader.vue';

const config = useLoad(() => api.config());

const from = ref('06:30');
const to = ref('22:30');
const lead = ref(30);
const preview = useLoad(
  () => api.timeWindowPreview({ accessibleFrom: from.value, accessibleTo: to.value, leadMinutes: lead.value }),
  { immediate: false },
);

/** 一键配置里跟着一起下发的起送价 / 配送费 / 公告 */
const minAmount = ref('');
const deliveryFee = ref('');
const notice = ref('');
const applying = ref(false);
/** 是否清空各栋的单独覆盖 —— 勾了才是真正的"统一" */
const clearOverride = ref(false);

watch(
  () => config.data.value,
  (c) => {
    if (!c) return;
    from.value = c.shop.accessibleFrom ?? '06:30';
    to.value = c.shop.accessibleTo ?? '22:30';
    lead.value = c.shop.cutoffLeadMinutes ?? 30;
    minAmount.value = centsToYuan(c.shop.minAmountCents);
    deliveryFee.value = centsToYuan(c.shop.deliveryFeeCents);
    void preview.run();
  },
);

const pv = computed(() => preview.data.value);

async function applyAll(): Promise<void> {
  applying.value = true;
  try {
    const r = await api.timeWindowBulk({
      accessibleFrom: from.value,
      accessibleTo: to.value,
      minAmountCents: yuanToCents(minAmount.value),
      deliveryFeeCents: yuanToCents(deliveryFee.value),
      notice: notice.value.trim() || null,
      // 勾上才清空各栋覆盖 —— 默认不清空，免得把某栋的特殊配置抹掉
      clearOverrideKeys: clearOverride.value
        ? ['minAmountCents', 'deliveryFeeCents', 'accessibleFrom', 'accessibleTo', 'notice']
        : [],
    });
    toast(`已应用到 ${r.affected} 栋`, 'ok');
    await config.run();
  } catch (e) {
    toast(messageOf(e), 'danger');
  } finally {
    applying.value = false;
  }
}

function bar(range: { from: string; to: string }): string {
  // 把 HH:mm 映射成 0–100 的百分比宽度，用于三层嵌套的可视化
  const p = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return ((h * 60 + (m || 0)) / 1440) * 100;
  };
  const a = p(range.from);
  const b = p(range.to);
  return `left:${a.toFixed(2)}%;width:${Math.max(0.5, b - a).toFixed(2)}%`;
}
</script>

<template>
  <div>
    <PageHeader
      code="W-03"
      title="时间窗配置"
      desc="设门禁时间与在途预留，截单时间由系统算出。可一键应用到所有在配送的楼栋。"
    />

    <Panel title="门禁时间窗">
      <div class="grid3">
        <div class="field">
          <label class="field__label">门禁开始</label>
          <input v-model="from" class="input num" placeholder="06:30" @change="preview.run()" />
          <span class="field__hint">学生能进楼的最早时间</span>
        </div>
        <div class="field">
          <label class="field__label">门禁结束</label>
          <input v-model="to" class="input num" placeholder="22:30" @change="preview.run()" />
          <span class="field__hint">之后不再接新单</span>
        </div>
        <div class="field">
          <label class="field__label">在途预留（分钟）</label>
          <input v-model.number="lead" class="input num" type="number" min="0" max="240" @change="preview.run()" />
          <span class="field__hint">从下单到送到的时间</span>
        </div>
      </div>

      <div v-if="preview.error.value" class="sub err">{{ preview.error.value }}</div>

      <div v-if="pv" class="result">
        <div class="cutoff">
          <span class="cutoff__label">截单时间</span>
          <span class="cutoff__value num">{{ pv.cutoffTime }}</span>
          <span class="cutoff__hint">由「门禁结束 − 在途预留」算出，不可直接填</span>
        </div>

        <div class="layers">
          <div class="layer">
            <span class="layer__name">门禁</span>
            <div class="track"><i class="fill fill--gate" :style="bar(pv.layers.gate)" /></div>
            <span class="layer__val num">{{ pv.layers.gate.from }}–{{ pv.layers.gate.to }}</span>
          </div>
          <div class="layer">
            <span class="layer__name">营业</span>
            <div class="track"><i class="fill fill--business" :style="bar(pv.layers.business)" /></div>
            <span class="layer__val num">{{ pv.layers.business.from }}–{{ pv.layers.business.to }}</span>
          </div>
          <div class="layer">
            <span class="layer__name">可下单</span>
            <div class="track"><i class="fill fill--order" :style="bar(pv.layers.orderable)" /></div>
            <span class="layer__val num">{{ pv.layers.orderable.from }}–{{ pv.layers.orderable.to }}</span>
          </div>
        </div>

        <p v-if="pv.narrowedNotice" class="notice">{{ pv.narrowedNotice }}</p>

        <p class="sub muted">
          此刻是否可下单：
          <b>{{ pv.currentGate?.allowed ? '可以' : '暂不可下单' }}</b>
          <span v-if="pv.currentGate?.message"> · {{ pv.currentGate.message }}</span>
        </p>
      </div>
    </Panel>

    <Panel title="一键应用到所有楼栋" desc="一次填完覆盖全部在配送的楼栋，只在需要差异时单独改某一栋。">
      <div class="grid3">
        <div class="field">
          <label class="field__label">起送价（元）</label>
          <input v-model="minAmount" class="input num" @input="minAmount = sanitizeYuan(minAmount)" />
        </div>
        <div class="field">
          <label class="field__label">配送费（元）</label>
          <input v-model="deliveryFee" class="input num" @input="deliveryFee = sanitizeYuan(deliveryFee)" />
        </div>
        <div class="field">
          <label class="field__label">统一公告</label>
          <input v-model="notice" class="input" placeholder="可留空表示不改" />
        </div>
      </div>

      <label class="check">
        <input v-model="clearOverride" type="checkbox" />
        <span>同时清除各栋的单独覆盖（不勾则只改没有单独设置过的楼栋）</span>
      </label>

      <div class="row">
        <div class="spacer" />
        <button class="btn btn--primary" type="button" :disabled="applying" @click="applyAll()">
          {{ applying ? '正在应用…' : '应用到全部楼栋' }}
        </button>
      </div>
    </Panel>
  </div>
</template>

<style scoped>
.grid3 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: var(--sp-3);
}
.result {
  margin-top: var(--sp-4);
  padding-top: var(--sp-4);
  border-top: var(--bd);
}
.cutoff {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  margin-bottom: var(--sp-4);
}
.cutoff__label {
  font-size: var(--fs-sub);
  color: var(--ink-500);
}
.cutoff__value {
  font-size: var(--fs-title);
  font-weight: var(--fw-semibold);
  color: var(--brand-700);
}
.cutoff__hint {
  font-size: var(--fs-tag);
  color: var(--ink-400);
}
.layers {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.layer {
  display: grid;
  grid-template-columns: 56px 1fr 130px;
  align-items: center;
  gap: var(--sp-3);
}
.layer__name {
  font-size: var(--fs-sub);
  color: var(--ink-500);
}
.layer__val {
  font-size: var(--fs-sub);
  color: var(--ink-700);
  text-align: right;
}
.track {
  position: relative;
  height: 10px;
  background: var(--line-100);
  border-radius: var(--r-full);
  overflow: hidden;
}
.fill {
  position: absolute;
  top: 0;
  bottom: 0;
  border-radius: var(--r-full);
}
.fill--gate {
  background: var(--brand-200);
}
.fill--business {
  background: var(--brand-400);
}
.fill--order {
  background: var(--brand-600);
}
.notice {
  margin: var(--sp-3) 0 0;
  padding: var(--sp-2) var(--sp-3);
  background: var(--warn-bg);
  color: var(--warn);
  border-radius: var(--r-md);
  font-size: var(--fs-sub);
}
.check {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin: var(--sp-3) 0;
  font-size: var(--fs-sub);
  color: var(--ink-700);
}
.err {
  color: var(--danger);
  margin-top: var(--sp-2);
}
</style>
