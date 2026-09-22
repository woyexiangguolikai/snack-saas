<script setup lang="ts">
/**
 * P-11 工单。
 *
 * 按**接单人**分两栏（我方 / 合伙人），不按状态分栏。理由是这张表要回答的问题
 * 只有一个：「现在压在你手上的有几条」。按状态分（待处理/处理中/已关闭）之后，
 * "我方待办"要人肉在三个列里各数一遍，而"经营类工单该转给合伙人"这件事
 * 在界面上根本看不出来 —— 分类决定流向，界面就得把流向画出来。
 *
 * 分类一旦落库就不许改：改分类等于换责任人，那是一次转派，
 * 该留一条记录而不是悄悄改一个字段。
 */
import { computed, ref } from 'vue';
import PageHeader from '@/components/PageHeader.vue';
import Panel from '@/components/Panel.vue';
import EmptyState from '@/components/EmptyState.vue';
import PageSkeleton from '@/components/PageSkeleton.vue';
import ErrorBanner from '@/components/ErrorBanner.vue';
import Modal from '@/components/Modal.vue';
import { papi } from '@/api/platform';
import { useLoad, messageOf } from '@/composables/useLoad';
import { toast } from '@/utils/feedback';
import { dt, ago } from '@/utils/fmt';

const statusFilter = ref<'all' | 'open' | 'doing' | 'closed'>('all');
const { data, loading, error, run } = useLoad(() =>
  papi.tickets(statusFilter.value === 'all' ? undefined : statusFilter.value),
);

type Ticket = {
  id: number;
  tenantCode: string | null;
  shopName: string | null;
  title: string;
  category: string;
  assignee: 'platform' | 'partner';
  status: 'open' | 'doing' | 'closed';
  createdBy: string;
  createdAt: string;
  closedAt: string | null;
  logs: Array<{ at: string; by: string; text: string }>;
};

const items = computed<Ticket[]>(() => (data.value?.items ?? []) as Ticket[]);
const summary = computed(() => data.value?.summary ?? {});

const CATEGORY: Record<string, string> = {
  tech: '技术',
  operation: '经营',
  billing: '账务',
  other: '其他',
};

/** 接单人 → 该谁看。技术归我方，经营/账务归合伙人（账务要人去跟商户对，不是改代码） */
function assigneeOf(category: string): 'platform' | 'partner' {
  return category === 'tech' || category === 'other' ? 'platform' : 'partner';
}

const mine = computed(() => items.value.filter((t) => t.assignee === 'platform' && t.status !== 'closed'));
const partners = computed(() => items.value.filter((t) => t.assignee === 'partner' && t.status !== 'closed'));
const closed = computed(() => items.value.filter((t) => t.status === 'closed'));

const STATUS: Record<string, string> = { open: '待处理', doing: '处理中', closed: '已关闭' };
const STATUS_TONE: Record<string, string> = { open: 'warn', doing: 'info', closed: 'off' };

/* ------------------------------------------------------------ 新建工单 */

const creating = ref(false);
const form = ref({ tenantCode: '', title: '', category: 'tech', detail: '' });
const busy = ref(false);

function openCreate(): void {
  form.value = { tenantCode: '', title: '', category: 'tech', detail: '' };
  creating.value = true;
}

async function submitCreate(): Promise<void> {
  if (!form.value.title.trim()) {
    toast('工单标题不能为空', 'warn');
    return;
  }
  busy.value = true;
  try {
    await papi.createTicket({
      tenantCode: form.value.tenantCode.trim() || null,
      title: form.value.title.trim(),
      category: form.value.category,
      detail: form.value.detail.trim() || undefined,
    });
    toast('工单已建，分类决定它落到谁手上', 'ok');
    creating.value = false;
    await run();
  } catch (e) {
    toast(messageOf(e), 'danger');
  } finally {
    busy.value = false;
  }
}

/* ------------------------------------------------------------ 处理记录 */

const opened = ref<Ticket | null>(null);
const note = ref('');

/** 详情按 id 重新拉：列表里的 logs 可能是几分钟前的（别人刚追加过） */
async function openTicket(t: Ticket): Promise<void> {
  note.value = '';
  opened.value = t;
  try {
    const r = await papi.tickets(undefined);
    const fresh = (r.items as Ticket[]).find((x) => x.id === t.id);
    if (fresh) opened.value = fresh;
  } catch {
    // 拉不到就用列表里那份 —— 有内容总比弹个空面板强
  }
}

async function append(status?: 'doing' | 'closed'): Promise<void> {
  const t = opened.value;
  if (!t) return;
  if (!note.value.trim() && !status) {
    toast('请先写一条处理记录', 'warn');
    return;
  }
  busy.value = true;
  try {
    await papi.appendTicket(t.id, { text: note.value.trim() || (status === 'closed' ? '已处理完毕' : '处理中'), status });
    toast(status === 'closed' ? '已关闭' : '已记录', 'ok');
    note.value = '';
    const r = await papi.tickets(undefined);
    const fresh = (r.items as Ticket[]).find((x) => x.id === t.id);
    opened.value = fresh ?? null;
    await run();
  } catch (e) {
    toast(messageOf(e), 'danger');
  } finally {
    busy.value = false;
  }
}

function rowOf(label: string, list: Ticket[]): { label: string; list: Ticket[] } {
  return { label, list };
}
const columns = computed(() => [rowOf('我方待办', mine.value), rowOf('合伙人待办', partners.value)]);
</script>

<template>
  <PageHeader title="工单" code="P-11">
    <template #actions>
      <select v-model="statusFilter" class="select" @change="run()">
        <option value="all">全部状态</option>
        <option value="open">待处理</option>
        <option value="doing">处理中</option>
        <option value="closed">已关闭</option>
      </select>
      <button class="btn pbtn--primary" type="button" @click="openCreate">新建工单</button>
    </template>
  </PageHeader>

  <ErrorBanner :text="error" @retry="run()" :kept="'当前状态筛选还在。'" />

  <div class="p-cards gap">
    <div class="p-card">
      <div class="p-card__k">待处理</div>
      <div class="p-card__v">{{ summary.open ?? 0 }}</div>
      <div class="p-card__d">还没人接手</div>
    </div>
    <div class="p-card">
      <div class="p-card__k">处理中</div>
      <div class="p-card__v">{{ summary.doing ?? 0 }}</div>
      <div class="p-card__d">有人在跟</div>
    </div>
    <div class="p-card">
      <div class="p-card__k">合伙人手上</div>
      <div class="p-card__v">{{ summary.partner ?? 0 }}</div>
      <div class="p-card__d">经营 / 账务类未关闭</div>
    </div>
    <div class="p-card">
      <div class="p-card__k">已关闭</div>
      <div class="p-card__v">{{ summary.closed ?? 0 }}</div>
      <div class="p-card__d">含历史累计</div>
    </div>
  </div>

  <PageSkeleton v-if="loading" preset="table" />
  <template v-else>
    <div class="tk__cols gap">
      <Panel
        v-for="col in columns"
        :key="col.label"
        :title="col.label"
        :desc="col.label === '我方待办' ? '技术 / 其他 —— 改代码、查配置' : '经营 / 账务 —— 谈合作、对账'"
      >
        <EmptyState v-if="!col.list.length" text="没有未关闭的工单" />
        <div v-else class="tk">
          <button v-for="t in col.list" :key="t.id" class="tk__card" type="button" @click="openTicket(t)">
            <div class="tk__top">
              <span class="tk__cat" :class="`tk__cat--${t.category}`">{{ CATEGORY[t.category] ?? t.category }}</span>
              <span class="tk__st" :class="`tk__st--${t.status}`">{{ STATUS[t.status] }}</span>
            </div>
            <div class="tk__title">{{ t.title }}</div>
            <div class="tk__meta">
              <span>{{ t.shopName ?? '全平台' }}</span>
              <span class="tk__dot">·</span>
              <span>{{ ago(t.createdAt) }}</span>
              <span class="tk__dot">·</span>
              <span>{{ t.logs.length }} 条记录</span>
            </div>
          </button>
        </div>
      </Panel>
    </div>

    <Panel class="gap" title="已关闭" desc="保留可查 —— 「这事当时怎么处理的」只能在这里找到答案">
      <EmptyState v-if="!closed.length" text="还没有关闭的工单" />
      <div v-else class="tk">
        <button v-for="t in closed" :key="t.id" class="tk__card tk__card--flat" type="button" @click="openTicket(t)">
          <div class="tk__title">{{ t.title }}</div>
          <div class="tk__meta">
            <span>{{ CATEGORY[t.category] ?? t.category }}</span>
            <span class="tk__dot">·</span>
            <span>{{ t.assignee === 'platform' ? '我方' : '合伙人' }}</span>
            <span class="tk__dot">·</span>
            <span>{{ t.shopName ?? '全平台' }}</span>
            <span class="tk__dot">·</span>
            <span>关闭于 {{ dt(t.closedAt) }}</span>
          </div>
        </button>
      </div>
    </Panel>
  </template>

  <!-- 新建 -->
  <Modal :open="creating" title="新建工单" :width="520" @close="creating = false">
    <div class="f">
      <label class="f__row">
        <span class="f__k">标题</span>
        <input v-model="form.title" class="input" placeholder="一句话说清是什么问题" />
      </label>
      <label class="f__row">
        <span class="f__k">分类</span>
        <select v-model="form.category" class="select">
          <option value="tech">技术 —— 归我方</option>
          <option value="operation">经营 —— 归合伙人</option>
          <option value="billing">账务 —— 归合伙人</option>
          <option value="other">其他 —— 归我方</option>
        </select>
      </label>
      <p class="f__hint">
        分类**决定接单人**：选技术会落到我方，选经营 / 账务会落到合伙人。
        落库后不给改 —— 换分类等于换责任人，那该走一次转派而不是改字段。
      </p>
      <label class="f__row">
        <span class="f__k">店铺编号</span>
        <input v-model="form.tenantCode" class="input" placeholder="可留空（全平台级问题）" />
      </label>
      <label class="f__row">
        <span class="f__k">详情</span>
        <textarea v-model="form.detail" class="input" rows="3" placeholder="现象、复现步骤、已试过什么" />
      </label>
    </div>
    <template #footer>
      <button class="btn" type="button" @click="creating = false">取消</button>
      <button class="btn pbtn--primary" type="button" :disabled="busy" @click="submitCreate">
        {{ busy ? '提交中…' : '建单' }}
      </button>
    </template>
  </Modal>

  <!-- 处理 -->
  <Modal :open="!!opened" :title="opened?.title ?? ''" :width="560" @close="opened = null">
    <template v-if="opened">
      <div class="tk__opened">
        <span class="tk__cat" :class="`tk__cat--${opened.category}`">
          {{ CATEGORY[opened.category] ?? opened.category }}
        </span>
        <span class="tk__st" :class="`tk__st--${opened.status}`">{{ STATUS[opened.status] }}</span>
        <span class="tk__dot">·</span>
        <span>{{ opened.shopName ?? '全平台' }}</span>
        <span class="tk__dot">·</span>
        <span>由 {{ opened.createdBy }} 建</span>
      </div>

      <div class="tk__logs">
        <div v-if="!opened.logs.length" class="tk__empty">还没有处理记录</div>
        <div v-for="(l, i) in opened.logs" :key="i" class="tk__log">
          <div class="tk__loghead">
            <span class="tk__logby">{{ l.by }}</span>
            <span class="tk__dot">·</span>
            <span>{{ dt(l.at) }}</span>
          </div>
          <div class="tk__logtext">{{ l.text }}</div>
        </div>
      </div>

      <textarea v-model="note" class="input" rows="3" placeholder="写一条处理记录（追加式，不会覆盖历史）" />
    </template>
    <template #footer>
      <button class="btn" type="button" @click="opened = null">关闭面板</button>
      <button
        v-if="opened && opened.status !== 'closed'"
        class="btn"
        type="button"
        :disabled="busy"
        @click="append('doing')"
      >
        记为处理中
      </button>
      <button
        v-if="opened && opened.status !== 'closed'"
        class="btn pbtn--primary"
        type="button"
        :disabled="busy"
        @click="append('closed')"
      >
        关闭工单
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.tk__cols {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
}
.tk {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.tk__card {
  display: block;
  width: 100%;
  text-align: left;
  padding: var(--sp-3);
  border: var(--bd);
  border-radius: var(--r-md);
  background: var(--surface);
}
.tk__card:hover {
  background: var(--line-100);
}
.tk__card--flat {
  opacity: 0.75;
}
.tk__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}
.tk__cat,
.tk__st {
  display: inline-block;
  padding: 1px 6px;
  border-radius: var(--r-sm);
  font-size: var(--fs-tag);
}
/* 分类色只区分"归谁"，不是严重度 —— 所以用中性 + 一个信息色，不用红黄绿 */
.tk__cat {
  background: var(--line-100);
  color: var(--ink-700);
}
.tk__cat--tech {
  background: var(--info-bg);
  color: var(--info);
}
.tk__cat--operation,
.tk__cat--billing {
  background: var(--warn-bg);
  color: var(--warn);
}
.tk__st {
  background: var(--line-100);
  color: var(--ink-500);
}
.tk__st--open {
  background: var(--warn-bg);
  color: var(--warn);
}
.tk__st--doing {
  background: var(--info-bg);
  color: var(--info);
}
.tk__title {
  margin-top: var(--sp-2);
  font-weight: var(--fw-medium);
  color: var(--ink-900);
}
.tk__meta {
  margin-top: 4px;
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-1);
  font-size: var(--fs-tag);
  color: var(--ink-400);
}
.tk__dot {
  color: var(--ink-300);
}

.tk__opened {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-1);
  font-size: var(--fs-sub);
  color: var(--ink-500);
  padding-bottom: var(--sp-3);
  border-bottom: var(--bd);
}
.tk__logs {
  max-height: 260px;
  overflow: auto;
  padding: var(--sp-3) 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.tk__empty {
  padding: var(--sp-2) 0;
  font-size: var(--fs-sub);
  color: var(--ink-400);
}
.tk__log {
  border-left: 2px solid var(--line-200);
  padding-left: var(--sp-3);
}
.tk__loghead {
  display: flex;
  gap: var(--sp-1);
  font-size: var(--fs-tag);
  color: var(--ink-400);
}
.tk__logby {
  color: var(--ink-700);
  font-weight: var(--fw-medium);
}
.tk__logtext {
  margin-top: 2px;
  font-size: var(--fs-sub);
  color: var(--ink-900);
  white-space: pre-wrap;
}

.f {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.f__row {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.f__k {
  font-size: var(--fs-sub);
  color: var(--ink-500);
}
.f__hint {
  margin: 0;
  font-size: var(--fs-tag);
  color: var(--ink-500);
  background: var(--info-bg);
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
}
</style>
