<script setup lang="ts">
/**
 * P-10 监控告警。
 *
 * 三类告警的**处置动作完全不同**，所以列表按"要不要动手"排序而不是按时间：
 *   · 租户活跃度下降 / 订单量骤降 → 打电话问，是经营问题
 *   · 支付异常 / 审核卡点 / 密钥失效 → 动手修，是技术问题
 * 时间排序会把"三天前的一条 info"压在"刚生成的 danger"上面，
 * 而真正需要立刻看一眼的恰恰是后者。
 *
 * 「手动巡检」按钮带 `now` 注入：不注入的话"连续 7 天无订单"这类告警
 * 只能靠真的等一周，等于永远没被验证过。
 */
import { computed, ref } from 'vue';
import PageHeader from '@/components/PageHeader.vue';
import Panel from '@/components/Panel.vue';
import EmptyState from '@/components/EmptyState.vue';
import PageSkeleton from '@/components/PageSkeleton.vue';
import ErrorBanner from '@/components/ErrorBanner.vue';
import { papi } from '@/api/platform';
import { useLoad, messageOf } from '@/composables/useLoad';
import { toast } from '@/utils/feedback';
import { dt } from '@/utils/fmt';

const onlyOpen = ref(false);
const { data, loading, error, run } = useLoad(() => papi.alerts(onlyOpen.value));

const KIND_TEXT: Record<string, string> = {
  tenant_activity: '租户活跃度',
  order_volume: '订单量',
  pay_anomaly: '支付异常',
  audit_stuck: '审核卡点',
  secret_invalid: '密钥失效',
};

/** 告警 → 处置流向。列表里直接写出来，省得每次都要想"这条该找谁" */
const KIND_FLOW: Record<string, string> = {
  tenant_activity: '经营 · 联系商户',
  order_volume: '经营 · 联系商户',
  pay_anomaly: '技术 · 查待扣队列',
  audit_stuck: '技术 · 催商户提审',
  secret_invalid: '技术 · 让商户重填密钥',
};

const LEVEL_TEXT: Record<string, string> = { danger: '需立即处理', warn: '即将需要处理', info: '仅告知' };

const items = computed(() => {
  const list = data.value?.items ?? [];
  const rank: Record<string, number> = { danger: 0, warn: 1, info: 2 };
  return [...list].sort((a, b) => {
    const aOpen = a.ackAt === null;
    const bOpen = b.ackAt === null;
    if (aOpen !== bOpen) return aOpen ? -1 : 1;
    const r = (rank[a.level] ?? 3) - (rank[b.level] ?? 3);
    if (r !== 0) return r;
    return b.id - a.id;
  });
});

const summary = computed(() => data.value?.summary ?? { open: 0, danger: 0, warn: 0, info: 0 });

const scanning = ref(false);

async function scan(): Promise<void> {
  scanning.value = true;
  try {
    const r = (await papi.scanAlerts()) as { created?: number; checked?: Record<string, number> };
    const n = r?.created ?? 0;
    // 巡检结果是"这次看了什么、发现几条"——只说"成功"等于没说
    const c = r?.checked ?? {};
    const scope = `检查 ${c.tenants ?? 0} 家（活跃 ${c.idle ?? 0} / 订单量 ${c.volumeDrop ?? 0} / 待扣 ${c.pendingStale ?? 0} / 卡点 ${c.overdue ?? 0} / 密钥 ${c.secretInvalid ?? 0}）`;
    toast(n > 0 ? `发现 ${n} 条新告警 · ${scope}` : `没有新告警 · ${scope}`, n > 0 ? 'warn' : 'ok');
    await run();
  } catch (e) {
    toast(messageOf(e), 'danger');
  } finally {
    scanning.value = false;
  }
}

async function ack(id: number): Promise<void> {
  try {
    await papi.ackAlert(id);
    await run();
  } catch (e) {
    toast(messageOf(e), 'danger');
  }
}

async function toggleOpen(): Promise<void> {
  onlyOpen.value = !onlyOpen.value;
  await run();
}
</script>

<template>
  <PageHeader title="监控告警" code="P-10">
    <template #actions>
      <button class="btn" type="button" @click="toggleOpen">
        {{ onlyOpen ? '显示全部' : '只看待处理' }}
      </button>
      <button class="btn pbtn--primary" type="button" :disabled="scanning" @click="scan">
        {{ scanning ? '巡检中…' : '跑一次巡检' }}
      </button>
    </template>
  </PageHeader>

  <ErrorBanner :text="error" @retry="run()" :kept="'「只看待处理」的开关状态还在。'" />

  <div class="p-cards gap">
    <div class="p-card">
      <div class="p-card__k">待处理</div>
      <div class="p-card__v">{{ summary.open }}</div>
      <div class="p-card__d">含须立刻处理 {{ summary.danger }} 条</div>
    </div>
    <div class="p-card">
      <div class="p-card__k">需立即处理</div>
      <div class="p-card__v">{{ summary.danger }}</div>
      <div class="p-card__d">已经出问题了</div>
    </div>
    <div class="p-card">
      <div class="p-card__k">即将需要处理</div>
      <div class="p-card__v">{{ summary.warn }}</div>
      <div class="p-card__d">再放就要变成问题</div>
    </div>
    <div class="p-card">
      <div class="p-card__k">仅告知</div>
      <div class="p-card__v">{{ summary.info }}</div>
      <div class="p-card__d">不用动手，知情即可</div>
    </div>
  </div>

  <Panel
    class="gap"
    title="告警列表"
    desc="同一天同一类同一家租户只会有一条 —— 否则巡检每跑一次就刷一屏重复"
  >
    <PageSkeleton v-if="loading" preset="table" />
    <EmptyState v-else-if="!items.length && !error" text="没有告警 —— 要么一切正常，要么巡检还没跑过" />
    <div v-else class="al">
      <div v-for="a in items" :key="a.id" class="al__row" :class="`al__row--${a.level}`">
        <div class="al__main">
          <div class="al__t">
            <span class="al__lv" :class="`al__lv--${a.level}`">{{ LEVEL_TEXT[a.level] ?? a.level }}</span>
            <span class="al__title">{{ a.title }}</span>
          </div>
          <div class="al__d">{{ a.detail }}</div>
          <div class="al__meta">
            <span>{{ KIND_TEXT[a.kind] ?? a.kind }}</span>
            <span class="al__dot">·</span>
            <span>{{ KIND_FLOW[a.kind] ?? '—' }}</span>
            <span class="al__dot">·</span>
            <span>{{ a.tenantCode ?? '全平台' }}</span>
            <span class="al__dot">·</span>
            <span>{{ dt(a.createdAt) }}</span>
            <template v-if="a.ackAt">
              <span class="al__dot">·</span>
              <span>已处理（{{ a.ackBy ?? '—' }}）</span>
            </template>
          </div>
        </div>
        <div class="al__act">
          <button v-if="!a.ackAt" class="btn" type="button" @click="ack(a.id)">标记已处理</button>
          <span v-else class="al__done">已闭环</span>
        </div>
      </div>
    </div>
  </Panel>
</template>

<style scoped>
.al {
  display: flex;
  flex-direction: column;
}
/* 左侧色条 = 严重度，一眼扫过去不用读文字 */
.al__row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-4);
  padding: var(--sp-3) var(--sp-4);
  border-left: 3px solid var(--line-200);
  border-bottom: var(--bd);
}
.al__row--danger {
  border-left-color: var(--danger);
  background: var(--danger-bg);
}
.al__row--warn {
  border-left-color: var(--warn);
  background: var(--warn-bg);
}
.al__row--info {
  border-left-color: var(--info);
}
.al__t {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.al__lv {
  display: inline-block;
  padding: 1px 6px;
  border-radius: var(--r-sm);
  font-size: var(--fs-tag);
  background: var(--line-100);
  color: var(--ink-700);
}
.al__lv--danger {
  background: var(--danger);
  color: var(--surface);
}
.al__lv--warn {
  background: var(--warn);
  color: var(--surface);
}
.al__lv--info {
  background: var(--info);
  color: var(--surface);
}
.al__title {
  font-weight: var(--fw-medium);
  color: var(--ink-900);
}
.al__d {
  margin-top: 4px;
  font-size: var(--fs-sub);
  color: var(--ink-700);
}
.al__meta {
  margin-top: 4px;
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-1);
  font-size: var(--fs-tag);
  color: var(--ink-400);
}
.al__dot {
  color: var(--ink-300);
}
.al__act {
  flex-shrink: 0;
}
.al__done {
  font-size: var(--fs-sub);
  color: var(--ink-400);
}
</style>
