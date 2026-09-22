<script setup lang="ts">
/**
 * P-07 批量推送（灰度）。
 *
 * 三步走，与服务端的硬拦一一对应：
 *   ① 选版本 —— 只能推已存在的版本号（版本号是推送上唯一能对账的凭据）
 *   ② 选租户 —— 默认带出排除名单提示；已停用 / 未走到 12 阶段的会被服务端跳过并说明原因
 *   ③ 灰度确认 —— 灰度最多 2 家。**这不是提示，是硬拦**：
 *      做成确认框的话，第三次点击它就变成肌肉记忆了，等于没有。
 *
 * 批量推送前服务端还会要求"该版本已有成功的灰度"。
 * 看板上 20 家全绿、实际一家没推上去，是这类系统最贵的一种错误。
 */
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import PageHeader from '@/components/PageHeader.vue';
import Panel from '@/components/Panel.vue';
import EmptyState from '@/components/EmptyState.vue';
import ToneTag from '@/components/ToneTag.vue';
import Modal from '@/components/Modal.vue';
import { papi } from '@/api/platform';
import type { PushBatch, PushResult } from '@/api/platform-types';
import { useLoad, messageOf } from '@/composables/useLoad';
import { toast } from '@/utils/feedback';
import { dt } from '@/utils/fmt';

const router = useRouter();
const { data: versions, run: reloadVersions } = useLoad(() => papi.versions());
const { data: board, run: reloadBoard } = useLoad(() => papi.deployBoard('all'));
const { data: batches, run: reloadBatches } = useLoad(() => papi.batches());

const versionId = ref<number | null>(null);
const picked = ref<string[]>([]);
const excluded = ref<string[]>([]);
const confirmedGray = ref(false);
const busy = ref(false);
const result = ref<PushResult | null>(null);
const progress = ref<string>('');

const candidates = computed(() =>
  (board.value?.items ?? []).filter((i) => i.category !== 'on_latest' || !i.published),
);

const grayState = ref<{ passed: boolean; reason: string } | null>(null);

async function chooseVersion(): Promise<void> {
  if (!versionId.value) return;
  try {
    grayState.value = await papi.grayState(versionId.value);
  } catch {
    grayState.value = null;
  }
}

function toggle(code: string): void {
  const i = picked.value.indexOf(code);
  if (i >= 0) picked.value.splice(i, 1);
  else picked.value.push(code);
}

function toggleExclude(code: string): void {
  const i = excluded.value.indexOf(code);
  if (i >= 0) excluded.value.splice(i, 1);
  else excluded.value.push(code);
}

const targets = computed(() => picked.value.filter((c) => !excluded.value.includes(c)));

async function push(kind: 'gray' | 'batch'): Promise<void> {
  if (!versionId.value) {
    toast('先选一个版本', 'warn');
    return;
  }
  if (!targets.value.length) {
    toast('至少要选一个租户（被排除的不算）', 'warn');
    return;
  }
  busy.value = true;
  progress.value = `正在向 ${targets.value.length} 家推送…`;
  try {
    const r = await papi.push({
      versionId: versionId.value,
      tenantCodes: picked.value,
      exclude: excluded.value,
      kind,
      confirmedGrayPassed: confirmedGray.value,
    });
    result.value = r;
    toast(
      `推送完成：成功 ${r.batch.succeeded} 家、失败 ${r.batch.failed} 家${r.skipped.length ? `、跳过 ${r.skipped.length} 家` : ''}`,
      r.batch.failed ? 'warn' : 'ok',
    );
    await Promise.all([reloadBoard(), reloadBatches()]);
  } catch (e) {
    toast(messageOf(e), 'danger');
  } finally {
    busy.value = false;
    progress.value = '';
  }
}

async function rollback(b: PushBatch): Promise<void> {
  const prev = (versions.value?.items ?? []).find((v) => v.version !== b.version);
  if (!prev) {
    toast('没有可回滚到的版本（至少要有两个版本号）', 'warn');
    return;
  }
  if (!window.confirm(`把批次 #${b.id}（${b.version}）里成功推送过的租户，重新推 ${prev.version}？\n\n注意：微信侧做不到"退回旧版本"，回滚只是"把旧版本再推一次"。`)) return;
  busy.value = true;
  try {
    await papi.rollback(b.id, prev.id);
    toast(`已回滚到 ${prev.version}，并单独记了一批`, 'ok');
    await Promise.all([reloadBatches(), reloadBoard()]);
  } catch (e) {
    toast(messageOf(e), 'danger');
  } finally {
    busy.value = false;
  }
}

async function createVersion(): Promise<void> {
  const v = window.prompt('新版本号（x.y.z）：')?.trim() ?? '';
  if (!v) return;
  const note = window.prompt('这个版本的一句话说明（灰度推送时给商户看）：')?.trim() ?? '';
  try {
    const made = await papi.createVersion(v, note);
    versionId.value = made.id;
    toast(`版本 ${made.version} 已登记为草稿`, 'ok');
    await reloadVersions();
  } catch (e) {
    toast(messageOf(e), 'danger');
  }
}
</script>

<template>
  <div>
    <PageHeader title="批量推送（灰度）" code="P-07" desc="先 1–2 家 → 验证 → 批量 · 支持排除名单">
      <template #actions>
        <button class="btn" type="button" @click="reloadBoard()">刷新</button>
        <button class="btn" type="button" @click="createVersion()">登记新版本</button>
      </template>
    </PageHeader>

    <!-- 第一步 -->
    <Panel title="① 选版本" class="gap">
      <div class="row row--wrap">
        <select v-model="versionId" class="select" style="max-width: 320px" @change="chooseVersion()">
          <option :value="null">请选择要推送的版本…</option>
          <option v-for="v in versions?.items ?? []" :key="v.id" :value="v.id">
            {{ v.version }} · {{ v.status }} · 已推 {{ v.pushedCount }} 家
            {{ v.note ? `· ${v.note}` : '' }}
          </option>
        </select>
        <span v-if="grayState" class="p-note" :class="grayState.passed ? 'p-note--ok' : 'p-note--warn'">
          灰度状态：{{ grayState.reason }}
        </span>
      </div>
    </Panel>

    <!-- 第二步 -->
    <Panel
      title="② 选租户"
      :desc="`已选 ${picked.length} 家 · 排除 ${excluded.length} 家 · 实际目标 ${targets.length} 家`"
      flush
      class="gap"
    >
      <EmptyState
        v-if="!candidates.length"
        text="没有需要推送的租户"
        hint="全部租户都已发布最新版，或还没有走到第 12 阶段"
      />
      <div v-else class="tbl-wrap max">
        <table class="tbl">
          <thead>
            <tr>
              <th style="width: 36px" />
              <th>租户</th>
              <th>AppID</th>
              <th>当前版本</th>
              <th>状态</th>
              <th style="width: 90px">排除</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in candidates" :key="t.tenantCode">
              <td><input type="checkbox" :checked="picked.includes(t.tenantCode)" @change="toggle(t.tenantCode)" /></td>
              <td>
                {{ t.shopName }}
                <span class="num sub muted block">{{ t.tenantCode }}</span>
              </td>
              <td class="num sub">{{ t.appid ?? '未绑定' }}</td>
              <td class="num">{{ t.currentVersion ?? '—' }}</td>
              <td>
                <ToneTag
                  :tone="t.category === 'failed' ? 'danger' : t.category === 'unsubmitted' ? 'info' : 'warn'"
                  :text="t.category"
                />
              </td>
              <td>
                <label class="ex">
                  <input type="checkbox" :checked="excluded.includes(t.tenantCode)" @change="toggleExclude(t.tenantCode)" />
                  <span class="sub">排除</span>
                </label>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="pad2 sub muted">
        被排除的租户既不算成功也不算失败 —— 它会出现在「跳过原因」里。
        灰度验证未过的、商户主动要求暂停的，都该放进这里。
      </div>
    </Panel>

    <!-- 第三步 -->
    <Panel title="③ 推送" class="gap">
      <p class="p-note p-note--info">
        灰度推送最多 2 家（服务端硬拦）。批量推送前必须有**该版本**的成功灰度记录 ——
        一个 bug 不能让 N 家同时挂，所以这条纪律不做成可选。
      </p>

      <label class="confirm">
        <input v-model="confirmedGray" type="checkbox" />
        <span>灰度已验证通过（批量推送勾选后可直接放行）</span>
      </label>

      <div class="row row--wrap mt">
        <button class="btn" type="button" :disabled="busy || !targets.length" @click="push('gray')">
          灰度推送（最多 2 家）
        </button>
        <button class="btn pbtn--primary" type="button" :disabled="busy || !targets.length" @click="push('batch')">
          批量推送（{{ targets.length }} 家）
        </button>
        <span v-if="progress" class="sub">{{ progress }}</span>
      </div>
    </Panel>

    <!-- 推送结果 -->
    <Modal v-if="result" :open="true" title="推送结果" :width="680" @close="result = null">
      <div class="p-cards">
        <div class="p-card">
          <p class="p-card__k">目标</p>
          <p class="p-card__v">{{ result.batch.totalTargets }}</p>
        </div>
        <div class="p-card">
          <p class="p-card__k">成功</p>
          <p class="p-card__v">{{ result.batch.succeeded }}</p>
        </div>
        <div class="p-card">
          <p class="p-card__k">失败</p>
          <p class="p-card__v">{{ result.batch.failed }}</p>
        </div>
        <div class="p-card">
          <p class="p-card__k">跳过</p>
          <p class="p-card__v">{{ result.skipped.length }}</p>
        </div>
      </div>

      <p v-if="result.skipped.length" class="p-note p-note--warn mt">
        跳过原因：{{ result.skipped.join('；') }}
      </p>

      <div v-if="result.targets.filter((t) => !t.ok).length" class="mt">
        <p class="field__label">失败明细</p>
        <ul class="fails">
          <li v-for="t in result.targets.filter((x) => !x.ok)" :key="t.id">
            <b>{{ t.tenantCode }}</b> — {{ t.error }}
          </li>
        </ul>
      </div>

      <template #footer>
        <button class="btn pbtn--primary" type="button" @click="result = null">知道了</button>
      </template>
    </Modal>

    <!-- 批次历史 -->
    <Panel title="推送批次" desc="回滚不会撤销推送过的版本，只是把旧版本再推一次" flush class="gap">
      <EmptyState v-if="!(batches?.items ?? []).length" text="还没有推送记录" />
      <div v-else class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th class="num">#</th>
              <th>版本</th>
              <th>类型</th>
              <th class="num">目标</th>
              <th class="num">成功</th>
              <th class="num">失败</th>
              <th>状态</th>
              <th>时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="b in batches?.items ?? []" :key="b.id">
              <td class="num">{{ b.id }}</td>
              <td class="num">{{ b.version }}</td>
              <td>
                <ToneTag
                  :tone="b.kind === 'rollback' ? 'warn' : b.kind === 'gray' ? 'info' : 'off'"
                  :text="b.kind === 'rollback' ? '回滚' : b.kind === 'gray' ? '灰度' : '批量'"
                />
              </td>
              <td class="num">{{ b.totalTargets }}</td>
              <td class="num">{{ b.succeeded }}</td>
              <td class="num">
                <span :class="{ bad: b.failed > 0 }">{{ b.failed }}</span>
              </td>
              <td>
                <ToneTag
                  :tone="b.status === 'done' ? 'ok' : b.status === 'rolled_back' ? 'warn' : 'danger'"
                  :text="b.status"
                />
              </td>
              <td class="sub">{{ dt(b.createdAt) }}</td>
              <td>
                <button
                  v-if="b.status === 'done' && b.succeeded > 0 && b.kind !== 'rollback'"
                  class="btn btn--sm btn--danger"
                  type="button"
                  :disabled="busy"
                  @click="rollback(b)"
                >
                  回滚
                </button>
                <span v-else class="sub muted">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </Panel>
  </div>
</template>

<style scoped>
.gap {
  margin-top: var(--sp-4);
}
.max {
  max-height: 420px;
  overflow: auto;
}
.pad2 {
  padding: var(--sp-3) var(--sp-4);
  border-top: var(--bd);
}
.ex {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
}
.confirm {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-top: var(--sp-3);
  font-size: var(--fs-sub);
  color: var(--ink-700);
}
.mt {
  margin-top: var(--sp-3);
}
.fails {
  margin: var(--sp-2) 0 0;
  padding-left: var(--sp-4);
  font-size: var(--fs-sub);
}
.bad {
  color: var(--danger);
}
.block {
  display: block;
}
</style>
