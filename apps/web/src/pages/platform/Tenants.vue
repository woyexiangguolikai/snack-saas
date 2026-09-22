<script setup lang="ts">
/**
 * P-01 租户管理。
 *
 * 这一页有三件事必须做对，否则平台后台就是"好看的表格"：
 *   ① **隐私护栏卡常驻顶部**：房间号只在租户库，平台侧看不到 —— 写出来比不说好，
 *      因为它同时约束了后来改这页的人（AC-13）；
 *   ② **两个账本同屏**：订阅剩余与余额必须并列。只看余额会让"订阅早过期了"隐形，
 *      而 100 个租户里谁要被停单，只有这两个数字摆在一起才看得出来（§3.4）；
 *   ③ 筛选里有「闸门」一项：默认视图是"全部"，但真正每天要看的只有"快停单的那几家"。
 */
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import PageHeader from '@/components/PageHeader.vue';
import Panel from '@/components/Panel.vue';
import EmptyState from '@/components/EmptyState.vue';
import PageSkeleton from '@/components/PageSkeleton.vue';
import ErrorBanner from '@/components/ErrorBanner.vue';
import ToneTag from '@/components/ToneTag.vue';
import Money from '@/components/Money.vue';
import { papi } from '@/api/platform';
import type { PlatformTenantRow } from '@/api/platform-types';
import { useLoad, messageOf } from '@/composables/useLoad';
import { toast } from '@/utils/feedback';
import { daysText, d10 } from '@/utils/fmt';

const router = useRouter();
const { data, loading, error, run } = useLoad(() => papi.tenants());

const q = ref('');
const statusFilter = ref<'all' | 'active' | 'pipeline' | 'suspended'>('all');
const gateFilter = ref<'all' | 'blocked' | 'expiring'>('all');

const rows = computed<PlatformTenantRow[]>(() => data.value?.items ?? []);

const filtered = computed(() =>
  rows.value.filter((t) => {
    if (statusFilter.value !== 'all' && t.status !== statusFilter.value) return false;
    if (gateFilter.value === 'blocked' && t.gates.balanceTone !== 'danger') return false;
    if (gateFilter.value === 'expiring') {
      const d = t.gates.subscriptionDaysLeft;
      // "即将到期"= 剩余 ≤7 天或已过期。null（从没开通过订阅）也算 —— 那更需要处理
      if (!(d === null || d <= 7)) return false;
    }
    if (q.value.trim()) {
      const k = q.value.trim().toLowerCase();
      if (
        !t.tenantCode.toLowerCase().includes(k) &&
        !t.shopName.toLowerCase().includes(k) &&
        !(t.appid ?? '').toLowerCase().includes(k)
      ) {
        return false;
      }
    }
    return true;
  }),
);

const counts = computed(() => ({
  all: rows.value.length,
  blocked: rows.value.filter((t) => t.gates.balanceTone === 'danger').length,
  expiring: rows.value.filter((t) => t.gates.subscriptionDaysLeft === null || t.gates.subscriptionDaysLeft <= 7).length,
  suspended: rows.value.filter((t) => t.status === 'suspended').length,
}));

/* -------------------------------------------------- 批量操作 */

const picked = ref<string[]>([]);

function toggle(code: string): void {
  const i = picked.value.indexOf(code);
  if (i >= 0) picked.value.splice(i, 1);
  else picked.value.push(code);
}

const allPicked = computed(() => filtered.value.length > 0 && picked.value.length === filtered.value.length);

function toggleAll(): void {
  picked.value = allPicked.value ? [] : filtered.value.map((t) => t.tenantCode);
}

async function bulk(action: 'suspend' | 'recover'): Promise<void> {
  const codes = [...picked.value];
  if (!codes.length) return;
  // 停用要先问原因 —— 批量停用更要说清为什么，否则恢复时没人记得
  let reason = '';
  if (action === 'suspend') {
    reason = window.prompt(`将停用 ${codes.length} 个租户，请填写原因（会写入每家的审计）:`)?.trim() ?? '';
    if (!reason) return;
  }
  let ok = 0;
  const failed: string[] = [];
  for (const code of codes) {
    try {
      await papi.setTenantStatus(code, action, reason || undefined);
      ok += 1;
    } catch (e) {
      failed.push(`${code}：${messageOf(e)}`);
    }
  }
  toast(
    failed.length
      ? `成功 ${ok} 家，${failed.length} 家失败：${failed.slice(0, 2).join('；')}`
      : `已处理 ${ok} 家`,
    failed.length ? 'warn' : 'ok',
  );
  picked.value = [];
  await run();
}

const STATUS_TEXT: Record<string, string> = {
  draft: '草稿',
  pipeline: '上线中',
  active: '营业中',
  suspended: '已停用',
  expired: '已过期',
};
const STATUS_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'off' | 'info'> = {
  draft: 'off',
  pipeline: 'info',
  active: 'ok',
  suspended: 'danger',
  expired: 'warn',
};
</script>

<template>
  <div>
    <PageHeader title="租户管理" code="P-01" desc="两个账本状态同屏 —— 谁要被停单一眼可见">
      <template #actions>
        <button class="btn" type="button" @click="run()">刷新</button>
        <button class="btn pbtn--primary" type="button" @click="router.push({ name: 'P-03' })">
          创建租户
        </button>
      </template>
    </PageHeader>

    <ErrorBanner :text="error" @retry="run()" :kept="'已勾选的租户和当前筛选都还在。'" />

    <!-- 隐私护栏卡：常驻，不可关闭（AC-13） -->
    <div class="p-guard grade">
      <span class="p-guard__mark">隐私护栏</span>
      <div>
        <p class="p-guard__t">平台侧看不到房间号与楼层</p>
        <p class="p-guard__d">
          房间号只存在于租户库。平台后台的页面与接口响应中都不含该字段 ——
          这不是"界面隐藏"，是数据访问层根本不返回：不读，就没有泄漏的可能。
          冒烟里有专门一条抓包用例，逐个平台接口检查响应文本。
        </p>
      </div>
    </div>

    <Panel title="筛选" class="gap">
      <div class="row row--wrap">
        <input v-model="q" class="input" style="max-width: 240px" placeholder="搜租户号 / 店铺名 / AppID" />
        <select v-model="statusFilter" class="select" style="max-width: 150px">
          <option value="all">全部状态</option>
          <option value="active">营业中</option>
          <option value="pipeline">上线中</option>
          <option value="suspended">已停用</option>
        </select>
        <button
          class="p-chip"
          :class="{ 'p-chip--on': gateFilter === 'all' }"
          type="button"
          @click="gateFilter = 'all'"
        >
          全部 {{ counts.all }}
        </button>
        <button
          class="p-chip"
          :class="{ 'p-chip--on': gateFilter === 'blocked' }"
          type="button"
          @click="gateFilter = 'blocked'"
        >
          余额待处理 {{ counts.blocked }}
        </button>
        <button
          class="p-chip"
          :class="{ 'p-chip--on': gateFilter === 'expiring' }"
          type="button"
          @click="gateFilter = 'expiring'"
        >
          订阅即将到期 {{ counts.expiring }}
        </button>
      </div>
    </Panel>

    <div v-if="picked.length" class="bar">
      <span>已选 {{ picked.length }} 家</span>
      <div class="spacer" />
      <button class="btn btn--sm" type="button" @click="bulk('recover')">批量恢复</button>
      <button class="btn btn--sm btn--danger" type="button" @click="bulk('suspend')">批量停用</button>
      <button class="btn btn--sm" type="button" @click="picked = []">取消</button>
    </div>

    <Panel title="租户" :desc="`共 ${filtered.length} 家`" flush class="gap">
      <div v-if="loading" class="pad"><PageSkeleton preset="tenantList" /></div>
      <!-- 空态（12 类之⑪）：首次使用 vs 筛选没结果，两句话完全不同。
           首次使用这一句要**说明这一页的作用**——它是平台侧唯一的全量视图，
           新人进来如果不理解它，就不知道从哪下手开第一户。 -->
      <EmptyState
        v-else-if="!filtered.length && !error"
        :text="rows.length ? '没有符合条件的租户' : '还没有租户'"
        :hint="
          rows.length
            ? '放宽筛选条件，或清空筛选看看全部租户'
            : '创建第一个租户后，这里会显示它的订阅与余额状态。平台侧的全部信息都在这一页。'
        "
      >
        <button class="btn btn--sm pbtn--primary" type="button" @click="router.push({ name: 'P-03' })">
          创建租户
        </button>
      </EmptyState>
      <div v-else class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th style="width: 36px">
                <input type="checkbox" :checked="allPicked" @change="toggleAll()" />
              </th>
              <th>租户号</th>
              <th>店铺</th>
              <th>AppID</th>
              <th class="num">楼栋</th>
              <th>订阅</th>
              <th>余额</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in filtered" :key="t.tenantCode">
              <td><input type="checkbox" :checked="picked.includes(t.tenantCode)" @change="toggle(t.tenantCode)" /></td>
              <td class="num">{{ t.tenantCode }}</td>
              <td>
                <RouterLink :to="{ name: 'P-02', params: { tenantCode: t.tenantCode } }">
                  {{ t.shopName }}
                </RouterLink>
              </td>
              <td class="num sub">{{ t.appid ?? '—' }}</td>
              <td class="num">{{ t.buildingCount }}</td>
              <td>
                <ToneTag :tone="t.gates.subscriptionTone" :text="daysText(t.gates.subscriptionDaysLeft)" />
                <span class="sub muted block">{{ d10(t.gates.subscriptionEndsAt) }}</span>
              </td>
              <td>
                <ToneTag
                  :tone="t.gates.balanceTone"
                  :text="t.gates.balanceCents < 0 ? '已透支' : '正常'"
                />
                <span class="block"><Money :cents="t.gates.balanceCents" /></span>
              </td>
              <td>
                <ToneTag :tone="STATUS_TONE[t.status] ?? 'off'" :text="STATUS_TEXT[t.status] ?? t.status" />
              </td>
              <td>
                <RouterLink class="link" :to="{ name: 'P-02', params: { tenantCode: t.tenantCode } }">
                  详情
                </RouterLink>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </Panel>
  </div>
</template>

<style scoped>
.grade {
  margin-bottom: var(--sp-4);
}
.gap + .gap,
.p-guard + .gap {
  margin-top: var(--sp-4);
}
.p-guard__mark {
  flex-shrink: 0;
  padding: 2px var(--sp-2);
  border-radius: var(--r-sm);
  background: var(--info-bg);
  color: var(--ink-900);
  font-size: var(--fs-tag);
  white-space: nowrap;
}
.bar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-top: var(--sp-4);
  padding: var(--sp-2) var(--sp-4);
  border: var(--bd);
  border-radius: var(--r-md);
  background: var(--surface);
  font-size: var(--fs-sub);
}
.pad {
  padding: var(--sp-6);
  color: var(--ink-500);
}
.block {
  display: block;
}
.link {
  color: var(--ink-700);
  text-decoration: underline;
}
</style>
