<script setup lang="ts">
/**
 * P-12 密钥管理。
 *
 * 这一页的设计约束只有一条，但它决定了整页形状：**明文永远拿不回来**。
 * 所以界面不能是"列表 + 查看 + 编辑"（那会诱导人点一下看看），
 * 只能是"列表 + 替换"：
 *   · 已有的密钥只显示掩码（`a1b2****`），没有任何"看一眼原值"的入口；
 *   · 要改就整把替换 —— 服务端收到明文、加密入库、只回掩码；
 *   · 「未收集」的两格必须显式列出来。
 *     只显示已有密钥，人会以为齐了；而缺密钥的表现是"推送静默失败"，
 *     等到发现时已经积了几天的失败版本。
 *
 * 失效标记（invalidate）不是"删除"：删掉之后那一格会消失，
 * 又会掉进"以为齐了"的坑；标成失效能带着时间和原因留在页面上。
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
import { d10 } from '@/utils/fmt';

const { data, loading, error, run } = useLoad(() => papi.secrets());

const KIND: Record<string, string> = {
  upload_key: '代码上传密钥',
  pay_cert: '支付证书',
};

/** 每种密钥的用途 —— 缺了会怎样，比"少一个文件"更能说明为什么要催 */
const KIND_WHY: Record<string, string> = {
  upload_key: '缺了无法替商户上传小程序版本，商户只能自己传',
  pay_cert: '缺了无法发起/接收支付回调，只能停留在模拟支付',
};

const STATUS: Record<string, string> = { active: '有效', invalid: '已失效', missing: '未收集' };
const STATUS_TONE: Record<string, string> = { active: 'ok', invalid: 'danger', missing: 'warn' };

const items = computed(() => data.value?.items ?? []);
const missing = computed(() => data.value?.missing ?? []);

const invalidCount = computed(() => items.value.filter((s) => s.status === 'invalid').length);

/* ------------------------------------------------------------ 替换 */

const editing = ref<{ tenantCode: string; kind: 'upload_key' | 'pay_cert'; shopName: string } | null>(null);
const value = ref('');
const remark = ref('');
const busy = ref(false);

function openPut(tenantCode: string, kind: 'upload_key' | 'pay_cert', shopName: string): void {
  editing.value = { tenantCode, kind, shopName };
  value.value = '';
  remark.value = '';
}

async function submitPut(): Promise<void> {
  const e = editing.value;
  if (!e) return;
  if (!value.value.trim()) {
    toast('请粘贴密钥内容', 'warn');
    return;
  }
  busy.value = true;
  try {
    const r = (await papi.putSecret(e.tenantCode, e.kind, value.value.trim(), remark.value.trim() || undefined)) as {
      masked?: string;
    };
    // 回显掩码而不是"保存成功" —— 让人当场确认存进去的是哪一把
    toast(`已替换，现为 ${r?.masked ?? '****'}`, 'ok');
    editing.value = null;
    value.value = '';
    await run();
  } catch (err) {
    toast(messageOf(err), 'danger');
  } finally {
    busy.value = false;
  }
}

/* ------------------------------------------------------------ 标记失效 */

const invalidating = ref<{ tenantCode: string; kind: string; shopName: string } | null>(null);
const reason = ref('');

async function submitInvalidate(): Promise<void> {
  const v = invalidating.value;
  if (!v) return;
  if (!reason.value.trim()) {
    toast('请写明失效原因 —— 否则日后只看到"失效"两个字，查不出是谁重置的', 'warn');
    return;
  }
  busy.value = true;
  try {
    await papi.invalidateSecret(v.tenantCode, v.kind, reason.value.trim());
    toast('已标记失效', 'ok');
    invalidating.value = null;
    reason.value = '';
    await run();
  } catch (e) {
    toast(messageOf(e), 'danger');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <PageHeader title="密钥管理" code="P-12">
    <template #actions>
      <button class="btn" type="button" @click="run()">刷新</button>
    </template>
  </PageHeader>

  <ErrorBanner :text="error" @retry="run()" />

  <!-- 这一条不是说明文案，是这一页的规则本身 —— 所以它常驻、且在数据之上 -->
  <div class="p-guard gap">
    <span class="sk__lock">🔒</span>
    <div>
      <div class="p-guard__t">密钥一旦存入，任何界面与接口都取不回明文</div>
      <div class="p-guard__d">
        服务端只保留密文与掩码，界面上只有「替换」没有「查看」——
        这不是权限设置，是数据结构上就不存在明文可读的路径。
        取回明文的需求应走"让商户重新提供"，而不是"给我们看一眼"。
      </div>
    </div>
  </div>

  <div class="p-cards gap">
    <div class="p-card">
      <div class="p-card__k">已收集</div>
      <div class="p-card__v">{{ items.length }}</div>
      <div class="p-card__d">有效 {{ items.filter((s) => s.status === 'active').length }} 把</div>
    </div>
    <div class="p-card">
      <div class="p-card__k">未收集</div>
      <div class="p-card__v">{{ missing.length }}</div>
      <div class="p-card__d">会影响推送 / 支付</div>
    </div>
    <div class="p-card">
      <div class="p-card__k">已失效</div>
      <div class="p-card__v">{{ invalidCount }}</div>
      <div class="p-card__d">需商户重新提供</div>
    </div>
  </div>

  <PageSkeleton v-if="loading" preset="table" />
  <template v-else>
    <Panel
      v-if="missing.length"
      class="gap"
      title="还没收到的密钥"
      desc="显式列出来是有意的 —— 只显示已有密钥的界面会让人以为已经齐了"
    >
      <div class="sk">
        <div v-for="m in missing" :key="`${m.tenantCode}-${m.kind}`" class="sk__row">
          <div class="sk__main">
            <div class="sk__name">
              {{ m.shopName }}
              <span class="sk__code">{{ m.tenantCode }}</span>
            </div>
            <div class="sk__why">{{ KIND[m.kind] ?? m.kind }} — {{ KIND_WHY[m.kind] ?? '' }}</div>
          </div>
          <div class="sk__act">
            <span class="sk__badge sk__badge--warn">未收集</span>
            <button
              class="btn btn--sm"
              type="button"
              @click="openPut(m.tenantCode, m.kind as 'upload_key' | 'pay_cert', m.shopName)"
            >
              录入
            </button>
          </div>
        </div>
      </div>
    </Panel>

    <Panel class="gap" title="已收集的密钥" desc="掩码是给人认的，不是给人还原的">
      <EmptyState v-if="!items.length" text="还没有收集到任何密钥" />
      <div v-else class="sk">
        <div v-for="s in items" :key="s.id" class="sk__row">
          <div class="sk__main">
            <div class="sk__name">
              {{ s.shopName }}
              <span class="sk__code">{{ s.tenantCode }}</span>
              <span class="sk__kind">{{ KIND[s.kind] ?? s.kind }}</span>
            </div>
            <div class="sk__mask p-mask">{{ s.masked }}</div>
            <div class="sk__meta">
              <span>更新于 {{ d10(s.updatedAt) }}</span>
              <template v-if="s.remark">
                <span class="sk__dot">·</span>
                <span>{{ s.remark }}</span>
              </template>
              <template v-if="s.invalidAt">
                <span class="sk__dot">·</span>
                <span class="sk__invalid">失效于 {{ d10(s.invalidAt) }}：{{ s.invalidReason ?? '未写明原因' }}</span>
              </template>
            </div>
          </div>
          <div class="sk__act">
            <span class="sk__badge" :class="`sk__badge--${s.status}`">{{ STATUS[s.status] ?? s.status }}</span>
            <button
              class="btn btn--sm"
              type="button"
              @click="openPut(s.tenantCode, s.kind as 'upload_key' | 'pay_cert', s.shopName)"
            >
              替换
            </button>
            <button
              v-if="s.status === 'active'"
              class="btn btn--sm btn--danger"
              type="button"
              @click="invalidating = { tenantCode: s.tenantCode, kind: s.kind, shopName: s.shopName }"
            >
              标失效
            </button>
          </div>
        </div>
      </div>
    </Panel>
  </template>

  <Modal
    :open="!!editing"
    :title="`替换 ${KIND[editing?.kind ?? ''] ?? ''}`"
    :width="520"
    @close="editing = null"
  >
    <p class="sk__target">对象：{{ editing?.shopName }}（{{ editing?.tenantCode }}）</p>
    <p class="p-note p-note--warn sk__note">
      粘贴的是明文。它只会出现在这一次请求里，存进去之后只能看到掩码 ——
      请确认粘对了再把原文件从聊天记录里删掉。
    </p>
    <label class="sk__f">
      <span class="sk__k">密钥内容</span>
      <textarea v-model="value" class="input" rows="4" placeholder="粘贴密钥文件内容 / 证书内容" />
    </label>
    <label class="sk__f">
      <span class="sk__k">备注</span>
      <input v-model="remark" class="input" placeholder="如 2026-03 商户重置后重新提供" />
    </label>
    <template #footer>
      <button class="btn" type="button" @click="editing = null">取消</button>
      <button class="btn pbtn--primary" type="button" :disabled="busy" @click="submitPut">
        {{ busy ? '提交中…' : '替换' }}
      </button>
    </template>
  </Modal>

  <Modal :open="!!invalidating" title="标记密钥失效" :width="480" @close="invalidating = null">
    <p class="sk__target">
      对象：{{ invalidating?.shopName }}（{{ invalidating?.tenantCode }}）·
      {{ KIND[invalidating?.kind ?? ''] ?? '' }}
    </p>
    <p class="p-note p-note--danger sk__note">
      标失效不是删除：这一格会留着，只是状态变成「已失效」并记下原因。
      留着是刻意的 —— 删掉之后又变回「未收集」，容易被人以为从没存在过。
    </p>
    <label class="sk__f">
      <span class="sk__k">失效原因（必填）</span>
      <input v-model="reason" class="input" placeholder="如 商户在微信后台重置了上传密钥" />
    </label>
    <template #footer>
      <button class="btn" type="button" @click="invalidating = null">取消</button>
      <button class="btn btn--danger" type="button" :disabled="busy" @click="submitInvalidate">
        {{ busy ? '提交中…' : '确认标失效' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.sk__lock {
  font-size: 18px;
  line-height: 1;
}
.sk {
  display: flex;
  flex-direction: column;
}
.sk__row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-4);
  padding: var(--sp-3) var(--sp-4);
  border-bottom: var(--bd);
}
.sk__row:last-child {
  border-bottom: 0;
}
.sk__name {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-weight: var(--fw-medium);
  color: var(--ink-900);
}
.sk__code {
  font-family: var(--mono);
  font-size: var(--fs-tag);
  color: var(--ink-400);
  font-weight: var(--fw-normal);
}
.sk__kind {
  padding: 1px 6px;
  border-radius: var(--r-sm);
  background: var(--line-100);
  color: var(--ink-700);
  font-size: var(--fs-tag);
  font-weight: var(--fw-normal);
}
.sk__mask {
  margin-top: 4px;
  font-size: var(--fs-body);
}
.sk__why {
  margin-top: 4px;
  font-size: var(--fs-sub);
  color: var(--ink-500);
}
.sk__meta {
  margin-top: 4px;
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-1);
  font-size: var(--fs-tag);
  color: var(--ink-400);
}
.sk__dot {
  color: var(--ink-300);
}
.sk__invalid {
  color: var(--danger);
}
.sk__act {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-shrink: 0;
}
.sk__badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: var(--r-sm);
  font-size: var(--fs-tag);
}
.sk__badge--ok,
.sk__badge--active {
  background: var(--ok-bg);
  color: var(--ok);
}
.sk__badge--invalid {
  background: var(--danger-bg);
  color: var(--danger);
}
.sk__badge--missing,
.sk__badge--warn {
  background: var(--warn-bg);
  color: var(--warn);
}

.sk__target {
  margin: 0 0 var(--sp-3);
  font-size: var(--fs-sub);
  color: var(--ink-500);
}
.sk__note {
  margin: 0 0 var(--sp-3);
}
.sk__f {
  display: block;
  margin-bottom: var(--sp-3);
}
.sk__k {
  display: block;
  margin-bottom: var(--sp-1);
  font-size: var(--fs-sub);
  color: var(--ink-500);
}
</style>
