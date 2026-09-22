<script setup lang="ts">
/**
 * P-06 版本与发布看板。
 *
 * 这一页的全部价值在于**分类**：平台对版本只有三种可做的事 ——
 *   · 停在旧版本 → 该推
 *   · 推了没提审   → 该催（推动权在商户手上，平台只能催，催不动就只能等）
 *   · 推送失败     → 该修
 * 所以筛选 Chip 不是"方便筛选"，是把这三件事摆出来。
 *
 * 「已推送未提审」这一类的存在感最弱但最重要：它是最容易烂尾的一类 ——
 * 代码明明推上去了，商户忘了提审，然后所有人都以为在等微信审核。
 */
import { computed, ref } from 'vue';
import PageHeader from '@/components/PageHeader.vue';
import Panel from '@/components/Panel.vue';
import EmptyState from '@/components/EmptyState.vue';
import PageSkeleton from '@/components/PageSkeleton.vue';
import ErrorBanner from '@/components/ErrorBanner.vue';
import ToneTag from '@/components/ToneTag.vue';
import { papi } from '@/api/platform';
import type { VersionBoardRow } from '@/api/platform-types';
import { useLoad, messageOf } from '@/composables/useLoad';
import { toast } from '@/utils/feedback';
import { dt, ago } from '@/utils/fmt';

const filter = ref<'all' | 'stale' | 'unsubmitted' | 'failed'>('all');
const { data, loading, error, run } = useLoad(() => papi.deployBoard(filter.value));

const items = computed(() => data.value?.items ?? []);

const CATEGORY: Record<string, { text: string; tone: 'ok' | 'warn' | 'danger' | 'off' | 'info' }> = {
  on_latest: { text: '最新版', tone: 'ok' },
  stale: { text: '停在旧版本', tone: 'warn' },
  never_pushed: { text: '从没推过', tone: 'warn' },
  unsubmitted: { text: '已推送未提审', tone: 'info' },
  failed: { text: '推送失败', tone: 'danger' },
};

async function switchFilter(f: typeof filter.value): Promise<void> {
  filter.value = f;
  await run();
}

async function mark(row: VersionBoardRow, kind: 'submitted' | 'published'): Promise<void> {
  if (!row.currentVersion) return;
  try {
    if (kind === 'submitted') await papi.markSubmitted(row.tenantCode, row.currentVersion);
    else await papi.markPublished(row.tenantCode, row.currentVersion);
    toast(`已回填 ${row.shopName} 的${kind === 'submitted' ? '提审' : '发布'}状态`, 'ok');
    await run();
  } catch (e) {
    toast(messageOf(e), 'danger');
  }
}

const PUSHABLE = ['stale', 'never_pushed', 'failed', 'unsubmitted'];
</script>

<template>
  <div>
    <PageHeader title="版本与发布" code="P-06" :desc="`推送通道：${data?.provider ?? '—'} · 最新版本 ${data?.latestVersion ?? '无'}`">
      <template #actions>
        <button class="btn" type="button" @click="run()">刷新</button>
        <button class="btn pbtn--primary" type="button" @click="$router.push({ name: 'P-07' })">
          去批量推送
        </button>
      </template>
    </PageHeader>

    <ErrorBanner :text="error" @retry="run()" :kept="'当前分类筛选还在。'" />

    <div v-if="loading" class="pad"><PageSkeleton preset="table" /></div>

    <template v-else-if="data">
      <div class="p-cards">
        <div class="p-card">
          <p class="p-card__k">租户总数</p>
          <p class="p-card__v">{{ data.stats.total }}</p>
        </div>
        <div class="p-card">
          <p class="p-card__k">已发布最新版</p>
          <p class="p-card__v">{{ data.stats.onLatest }}</p>
        </div>
        <div class="p-card">
          <p class="p-card__k">停在旧版本</p>
          <p class="p-card__v">{{ data.stats.stale }}</p>
          <p class="p-card__d">其中从没推过 {{ data.stats.neverPushed }} 家</p>
        </div>
        <div class="p-card">
          <p class="p-card__k">已推送未提审</p>
          <p class="p-card__v">{{ data.stats.unsubmitted }}</p>
          <p class="p-card__d">最容易被以为"在等审核"的一类</p>
        </div>
        <div class="p-card">
          <p class="p-card__k">推送失败</p>
          <p class="p-card__v">{{ data.stats.failed }}</p>
        </div>
      </div>

      <div class="row row--wrap filters">
        <button class="p-chip" :class="{ 'p-chip--on': filter === 'all' }" type="button" @click="switchFilter('all')">
          全部 {{ data.filters.all }}
        </button>
        <button class="p-chip" :class="{ 'p-chip--on': filter === 'stale' }" type="button" @click="switchFilter('stale')">
          还停在旧版本 {{ data.filters.stale }}
        </button>
        <button class="p-chip" :class="{ 'p-chip--on': filter === 'unsubmitted' }" type="button" @click="switchFilter('unsubmitted')">
          已推送未提审 {{ data.filters.unsubmitted }}
        </button>
        <button class="p-chip" :class="{ 'p-chip--on': filter === 'failed' }" type="button" @click="switchFilter('failed')">
          推送失败 {{ data.filters.failed }}
        </button>
      </div>

      <Panel title="发布状态" :desc="`${items.length} 家`" flush class="gap">
        <EmptyState
          v-if="!items.length"
          text="这一类里没有租户"
          hint="换个筛选看看 —— 全部为 0 说明版本收敛完成"
        />
        <div v-else class="tbl-wrap">
          <table class="tbl">
            <thead>
              <tr>
                <th>租户</th>
                <th>AppID</th>
                <th>当前版本</th>
                <th>最新版本</th>
                <th>推送时间</th>
                <th>提审 / 发布</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in items" :key="r.tenantCode">
                <td>
                  <RouterLink :to="{ name: 'P-02', params: { tenantCode: r.tenantCode } }">
                    {{ r.shopName }}
                  </RouterLink>
                  <span class="num sub muted block">{{ r.tenantCode }}</span>
                </td>
                <td class="num sub">{{ r.appid ?? '未绑定' }}</td>
                <td class="num">{{ r.currentVersion ?? '—' }}</td>
                <td class="num muted">{{ r.latestVersion ?? '—' }}</td>
                <td class="sub">{{ r.pushedAt ? `${dt(r.pushedAt)}（${ago(r.pushedAt)}）` : '—' }}</td>
                <td>
                  <ToneTag :tone="r.submitted ? 'ok' : 'off'" :text="r.submitted ? '已提审' : '未提审'" />
                  <ToneTag :tone="r.published ? 'ok' : 'off'" :text="r.published ? '已发布' : '未发布'" />
                </td>
                <td>
                  <ToneTag :tone="CATEGORY[r.category]?.tone ?? 'off'" :text="CATEGORY[r.category]?.text ?? r.category" />
                </td>
                <td class="ops">
                  <button
                    v-if="r.currentVersion && !r.submitted"
                    class="btn btn--sm"
                    type="button"
                    @click="mark(r, 'submitted')"
                  >
                    回填提审
                  </button>
                  <button
                    v-if="r.currentVersion && r.submitted && !r.published"
                    class="btn btn--sm"
                    type="button"
                    @click="mark(r, 'published')"
                  >
                    回填发布
                  </button>
                  <span v-if="!PUSHABLE.includes(r.category)" class="sub muted">已收敛</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="失败原因" desc="带可操作信息 —— 只说失败，等于没说" class="gap">
        <EmptyState
          v-if="!items.filter((i) => i.failed).length"
          text="当前没有推送失败"
          hint="有失败时这里会列出原因与对应租户"
        />
        <ul v-else class="fails">
          <li v-for="r in items.filter((i) => i.failed)" :key="r.tenantCode">
            <b>{{ r.shopName }}</b>
            <span class="num sub">{{ r.tenantCode }}</span>
            <p class="p-note p-note--danger">{{ r.error ?? '未给出原因' }}</p>
          </li>
        </ul>
      </Panel>
    </template>
  </div>
</template>

<style scoped>
.gap {
  margin-top: var(--sp-4);
}
.pad {
  padding: var(--sp-6);
  color: var(--ink-500);
}
.filters {
  margin-top: var(--sp-4);
}
.ops {
  white-space: nowrap;
}
.fails {
  margin: 0;
  padding: 0;
  list-style: none;
}
.fails li + li {
  margin-top: var(--sp-4);
}
.fails b {
  margin-right: var(--sp-2);
}
.block {
  display: block;
}
</style>
