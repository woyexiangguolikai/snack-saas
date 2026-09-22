<script setup lang="ts">
/**
 * P-02 租户详情。
 *
 * 这一页的结构就是"一个人接手一个陌生租户时，需要依次看什么"：
 *   基本信息 → 两道闸门（能不能收单）→ 楼栋（只到楼栋级）→ 订单汇总（无房间号）
 *   → 版本发布状态 → 操作审计
 *
 * **楼栋只到楼栋级、订单汇总只存钱不存人**，这不是排版选择：
 * 房间号属于租户库，平台侧不需要也不该看到（AC-13）。
 */
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import PageHeader from '@/components/PageHeader.vue';
import Panel from '@/components/Panel.vue';
import EmptyState from '@/components/EmptyState.vue';
import PageSkeleton from '@/components/PageSkeleton.vue';
import ErrorBanner from '@/components/ErrorBanner.vue';
import ToneTag from '@/components/ToneTag.vue';
import Money from '@/components/Money.vue';
import PipelineSteps from '@/platform/PipelineSteps.vue';
import { papi } from '@/api/platform';
import { useLoad, messageOf } from '@/composables/useLoad';
import { toast } from '@/utils/feedback';
import { d10, dt, daysText, stuckText } from '@/utils/fmt';

const route = useRoute();
const code = String(route.params.tenantCode ?? '');

const { data, loading, error, run } = useLoad(() => papi.tenantDetail(code));

const topupYuan = ref('');
const busy = ref(false);

const balanceTone = computed<'ok' | 'warn' | 'danger'>(() => {
  const g = data.value?.gates.wallet;
  if (!g) return 'ok';
  if (g.balanceCents <= g.creditLimitCents) return 'danger';
  if (g.balanceCents <= g.warnLineCents) return 'warn';
  return 'ok';
});

async function topup(): Promise<void> {
  const cents = Math.round(Number(topupYuan.value || 0) * 100);
  if (!validAmount(cents)) return;
  busy.value = true;
  try {
    const r = (await papi.topup(code, cents, '平台后台手动入账')) as { unfrozen?: boolean };
    toast(r?.unfrozen ? '已上账，余额已回到正常区间，锁单解除' : '已上账', 'ok');
    topupYuan.value = '';
    await run();
  } catch (e) {
    toast(messageOf(e), 'danger');
  } finally {
    busy.value = false;
  }
}

function validAmount(cents: number): boolean {
  if (!Number.isFinite(cents) || cents <= 0) {
    toast('请填写正确的金额', 'warn');
    return false;
  }
  return true;
}

async function setStatus(action: 'suspend' | 'recover'): Promise<void> {
  let reason = '';
  if (action === 'suspend') {
    reason = window.prompt(`停用「${data.value?.basic.shopName}」的原因（会写入审计）:`)?.trim() ?? '';
    if (!reason) return;
  }
  busy.value = true;
  try {
    await papi.setTenantStatus(code, action, reason || undefined);
    toast(action === 'suspend' ? '已停用（数据保留，可恢复）' : '已恢复', 'ok');
    await run();
  } catch (e) {
    toast(messageOf(e), 'danger');
  } finally {
    busy.value = false;
  }
}

async function renew(): Promise<void> {
  busy.value = true;
  try {
    await papi.renewSubscription(code);
    toast('已按本学期续期', 'ok');
    await run();
  } catch (e) {
    toast(messageOf(e), 'danger');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div>
    <PageHeader
      :title="data ? `租户详情 · ${data.basic.shopName}` : '租户详情'"
      code="P-02"
      :desc="code"
    >
      <template #actions>
        <button class="btn" type="button" @click="run()">刷新</button>
        <button
          v-if="data?.basic.status === 'suspended'"
          class="btn pbtn--primary"
          type="button"
          :disabled="busy"
          @click="setStatus('recover')"
        >
          恢复营业
        </button>
        <button
          v-else
          class="btn btn--danger"
          type="button"
          :disabled="busy"
          @click="setStatus('suspend')"
        >
          强制停用
        </button>
      </template>
    </PageHeader>

    <ErrorBanner :text="error" @retry="run()" />

    <div v-if="loading" class="pad"><PageSkeleton preset="table" /></div>

    <template v-else-if="data">
      <div v-if="data.basic.status === 'suspended'" class="p-note p-note--danger lead">
        该租户已停用：前台立即锁单并显示提示。数据保留，恢复后可直接继续使用。
      </div>

      <Panel title="基本信息" class="gap">
        <dl class="kv">
          <div><dt>租户号</dt><dd class="num">{{ data.basic.tenantCode }}</dd></div>
          <div><dt>店铺名</dt><dd>{{ data.basic.shopName }}</dd></div>
          <div><dt>执照主体</dt><dd>{{ data.basic.orgName }}</dd></div>
          <div><dt>AppID</dt><dd class="num">{{ data.basic.appid ?? '未绑定' }}</dd></div>
          <div><dt>商户号</dt><dd class="num">{{ data.basic.mchId ?? '未绑定' }}</dd></div>
          <div><dt>地区</dt><dd>{{ data.basic.region ?? '—' }}</dd></div>
          <div><dt>联系人</dt><dd>{{ data.basic.contactName ?? '—' }} {{ data.basic.contactPhone ?? '' }}</dd></div>
          <div><dt>租户库</dt><dd class="num">{{ data.basic.dbName }}</dd></div>
          <div><dt>创建时间</dt><dd>{{ d10(data.basic.createdAt) }}</dd></div>
        </dl>
      </Panel>

      <!-- 两个闸门同屏：只显示余额会让"订阅早过期了"隐形（§3.4） -->
      <div class="gates">
        <Panel title="闸门一 · 订阅">
          <p class="big">
            <ToneTag
              :tone="data.gates.subscription.daysLeft === null ? 'off' : data.gates.subscription.daysLeft <= 7 ? 'warn' : 'ok'"
              :text="daysText(data.gates.subscription.daysLeft)"
            />
          </p>
          <p class="sub muted">
            服务期 {{ d10(data.gates.subscription.periodStart) }} ~ {{ d10(data.gates.subscription.periodEnd) }}
          </p>
          <template #actions>
            <button class="btn btn--sm" type="button" :disabled="busy" @click="renew()">按本学期续期</button>
          </template>
        </Panel>

        <Panel title="闸门二 · 余额">
          <p class="big">
            <ToneTag :tone="balanceTone" :text="data.gates.wallet.balanceCents < 0 ? '已透支' : '正常'" />
            <Money :cents="data.gates.wallet.balanceCents" />
          </p>
          <p class="sub muted">
            预警线 <Money :cents="data.gates.wallet.warnLineCents" muted />
            · 应急额度 <Money :cents="data.gates.wallet.creditLimitCents" muted />
            · 待扣 {{ data.gates.pending.items.length }} 笔
          </p>
          <template #actions>
            <input
              v-model="topupYuan"
              class="input"
              style="width: 100px"
              placeholder="金额（元）"
            />
            <button class="btn btn--sm pbtn--primary" type="button" :disabled="busy" @click="topup()">
              上账
            </button>
          </template>
        </Panel>
      </div>

      <Panel title="上线流水线" class="gap">
        <PipelineSteps :stages="data.pipeline.stages" show-stuck />
        <p class="sub muted note">
          当前第 {{ data.pipeline.currentStageNo }} 阶段 · {{ data.pipeline.currentStageName }} ·
          {{ stuckText(data.pipeline.stuckDays) }}
          <template v-if="data.pipeline.lastContactedAt">
            · 上次触达 {{ dt(data.pipeline.lastContactedAt) }}
          </template>
          <template v-else> · 还没催过</template>
        </p>
      </Panel>

      <Panel
        title="楼栋"
        desc="只到楼栋级 —— 楼层与房间号属于租户库，平台侧不需要"
        flush
        class="gap"
      >
        <EmptyState v-if="!data.buildings.length" text="还没有楼栋" />
        <div v-else class="tbl-wrap">
          <table class="tbl">
            <thead>
              <tr>
                <th>编码</th>
                <th>名称</th>
                <th>配送</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="b in data.buildings" :key="b.id">
                <td class="num">{{ b.code }}</td>
                <td>{{ b.name }}</td>
                <td>{{ b.deliveryEnabled ? '可送' : '已停送' }}</td>
                <td>
                  <ToneTag :tone="b.status === 'active' ? 'ok' : 'off'" :text="b.status === 'active' ? '启用' : '已停用'" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel
        title="订单汇总"
        desc="只存钱不存人 —— 无房间号、无联系方式"
        flush
        class="gap"
      >
        <div class="sum">
          <span>近 {{ data.orderSummary.orderCount }} 单</span>
          <span>GMV <Money :cents="data.orderSummary.gmvCents" /></span>
          <span>应收服务费 <Money :cents="data.orderSummary.feeCents" /></span>
        </div>
        <EmptyState v-if="!data.orderSummary.recent.length" text="还没有已支付订单" />
        <div v-else class="tbl-wrap">
          <table class="tbl">
            <thead>
              <tr>
                <th>订单号</th>
                <th>金额</th>
                <th>服务费</th>
                <th>楼栋</th>
                <th>状态</th>
                <th>支付时间</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="o in data.orderSummary.recent" :key="o.orderNo">
                <td class="num">{{ o.orderNo }}</td>
                <td><Money :cents="o.amountCents" /></td>
                <td><Money :cents="o.feeCents" muted /></td>
                <td class="num">{{ o.buildingCode ?? '—' }}</td>
                <td>{{ o.status }}</td>
                <td class="sub">{{ dt(o.paidAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Panel>

      <div class="gates">
        <Panel title="版本发布状态">
          <p class="big">
            <span class="num">{{ data.version.currentVersion ?? '未推送' }}</span>
          </p>
          <p class="sub muted">
            推送 {{ dt(data.version.pushedAt) }} ·
            {{ data.version.submitted ? '已提审' : '未提审' }} ·
            {{ data.version.published ? '已发布' : '未发布' }}
          </p>
          <p v-if="data.version.error" class="p-note p-note--danger err">{{ data.version.error }}</p>
        </Panel>

        <Panel title="操作审计" flush>
          <EmptyState v-if="!data.audits.length" text="还没有操作记录" />
          <ul v-else class="logs">
            <li v-for="(a, i) in data.audits" :key="i">
              <span class="num sub">{{ dt(a.at) }}</span>
              <span class="act">{{ a.actor }}</span>
              <span>{{ a.action }}</span>
              <span v-if="a.detail" class="sub muted">— {{ a.detail }}</span>
            </li>
          </ul>
        </Panel>
      </div>
    </template>
  </div>
</template>

<style scoped>
.gap {
  margin-top: var(--sp-4);
}
.lead {
  margin-bottom: var(--sp-3);
}
.pad {
  padding: var(--sp-6);
  color: var(--ink-500);
}
.kv {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--sp-3);
  margin: 0;
}
.kv dt {
  font-size: var(--fs-sub);
  color: var(--ink-500);
}
.kv dd {
  margin: 2px 0 0;
  color: var(--ink-900);
}
.gates {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: var(--sp-4);
  margin-top: var(--sp-4);
}
.big {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  margin: 0 0 var(--sp-1);
  font-size: 20px;
}
.sum {
  display: flex;
  gap: var(--sp-6);
  padding: var(--sp-3) var(--sp-4);
  font-size: var(--fs-sub);
  color: var(--ink-700);
  border-bottom: var(--bd);
}
.logs {
  margin: 0;
  padding: var(--sp-2) var(--sp-4) var(--sp-4);
  list-style: none;
  max-height: 260px;
  overflow: auto;
}
.logs li {
  padding: var(--sp-1) 0;
  font-size: var(--fs-sub);
  border-bottom: var(--line-100);
}
.act {
  margin: 0 var(--sp-2);
  color: var(--ink-900);
}
.err {
  margin-top: var(--sp-2);
}
</style>
