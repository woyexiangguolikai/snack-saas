<script setup lang="ts">
/**
 * W-02 楼栋与配送。
 *
 * 两个必须说清的语义，界面上不能含糊：
 *   ① 「停送」≠「停用」—— 停送是临时（今天不送这栋），数据是活的；
 *      停用是这栋不再配送（学期结束 / 换楼），历史订单完整保留，**库存也保留**。
 *   ② 每栋的起送价 / 配送费 / 门禁时间可以是「继承店铺」或「本栋覆盖」，
 *      这一列必须显示来源 —— 否则商户改了店铺的配送费，会发现某栋没跟着变，
 *      然后以为是 bug。
 */
import { computed, ref } from 'vue';
import { api } from '@/api';
import type { ResolvedBuilding } from '@/api/types';
import { useLoad, messageOf } from '@/composables/useLoad';
import { toast } from '@/utils/feedback';
import { centsToYuan, sanitizeYuan, yuanToCents } from '@/utils/money';
import Money from '@/components/Money.vue';
import Modal from '@/components/Modal.vue';
import Panel from '@/components/Panel.vue';
import PageHeader from '@/components/PageHeader.vue';
import EmptyState from '@/components/EmptyState.vue';
import PageSkeleton from '@/components/PageSkeleton.vue';
import ErrorBanner from '@/components/ErrorBanner.vue';

const list = useLoad(async () => (await api.buildings()).items);

const editing = ref<ResolvedBuilding | null>(null);
const form = ref({
  name: '',
  deliveryEnabled: true,
  notice: '',
  minAmount: '',
  deliveryFee: '',
  accessibleFrom: '',
  accessibleTo: '',
});
const saving = ref(false);

const confirmDisable = ref<ResolvedBuilding | null>(null);
const newName = ref('');
const creating = ref(false);
const showCreate = ref(false);

const active = computed(() => (list.data.value ?? []).filter((b) => b.status === 'active'));
const disabled = computed(() => (list.data.value ?? []).filter((b) => b.status !== 'active'));

function openEdit(b: ResolvedBuilding): void {
  editing.value = b;
  form.value = {
    name: b.buildingName,
    deliveryEnabled: b.deliveryEnabled,
    notice: b.notice ?? '',
    minAmount: centsToYuan(b.minAmountCents),
    deliveryFee: centsToYuan(b.deliveryFeeCents),
    accessibleFrom: b.accessibleFrom ?? '',
    accessibleTo: b.accessibleTo ?? '',
  };
}

async function save(): Promise<void> {
  const b = editing.value;
  if (!b) return;
  saving.value = true;
  try {
    await api.updateBuilding(b.buildingId, {
      name: form.value.name.trim() || b.buildingName,
      deliveryEnabled: form.value.deliveryEnabled,
      notice: form.value.notice.trim() || null,
      minAmountCents: yuanToCents(form.value.minAmount),
      deliveryFeeCents: yuanToCents(form.value.deliveryFee),
      accessibleFrom: form.value.accessibleFrom || null,
      accessibleTo: form.value.accessibleTo || null,
    });
    toast('已保存', 'ok');
    editing.value = null;
    await list.run();
  } catch (e) {
    toast(messageOf(e), 'danger');
  } finally {
    saving.value = false;
  }
}

async function createBuilding(): Promise<void> {
  if (!newName.value.trim()) return;
  creating.value = true;
  try {
    await api.createBuilding({ name: newName.value.trim() });
    toast('楼栋已添加，记得去库存矩阵给它上架商品', 'ok');
    newName.value = '';
    showCreate.value = false;
    await list.run();
  } catch (e) {
    toast(messageOf(e), 'danger');
  } finally {
    creating.value = false;
  }
}

async function doDisable(): Promise<void> {
  const b = confirmDisable.value;
  if (!b) return;
  try {
    await api.disableBuilding(b.buildingId);
    toast('已停用。历史订单与该栋库存都保留', 'ok');
    confirmDisable.value = null;
    await list.run();
  } catch (e) {
    toast(messageOf(e), 'danger');
  }
}

async function toggleDelivery(b: ResolvedBuilding): Promise<void> {
  try {
    await api.updateBuilding(b.buildingId, { deliveryEnabled: !b.deliveryEnabled });
    toast(b.deliveryEnabled ? '已设为停送，学生暂时不能选这栋' : '已恢复配送', 'ok');
    await list.run();
  } catch (e) {
    toast(messageOf(e), 'danger');
  }
}

function sourceText(s: string): string {
  return s === 'override' ? '本栋覆盖' : '继承店铺';
}
</script>

<template>
  <div>
    <PageHeader
      code="W-02"
      title="楼栋与配送"
      desc="每栋的起送价、配送费、门禁时间可以单独覆盖。改完立即生效，不用发版。"
    >
      <template #actions>
        <button class="btn" type="button" @click="showCreate = true">添加楼栋</button>
      </template>
    </PageHeader>

    <ErrorBanner :text="list.error.value" @retry="list.run()" />

    <Panel title="在配送的楼栋" :desc="`共 ${active.length} 栋`">
      <PageSkeleton v-if="list.loading.value && !active.length" preset="table" :rows="4" />
      <!-- 空态（12 类之⑧）：说清**添加楼栋会带来什么**，而不是"请添加楼栋"。
           说清收益，商户才知道为什么要做这件事 —— "请添加楼栋"只说了要求。 -->
      <EmptyState
        v-else-if="!active.length && !list.error.value"
        text="还没有添加楼栋"
        hint="添加你负责配送的宿舍楼后，学生就能选到这栋楼下单，也会出现在配送清单里。"
      >
        <button class="btn btn--sm btn--primary" type="button" @click="showCreate = true">添加楼栋</button>
      </EmptyState>

      <div v-else class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>楼栋</th>
              <th>编号</th>
              <th class="num">起送价</th>
              <th class="num">配送费</th>
              <th>门禁时间</th>
              <th>截单时间</th>
              <th>配送</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="b in active" :key="b.buildingId">
              <td>
                <span class="bname">{{ b.buildingName }}</span>
                <span class="sub muted">{{ sourceText(b.source) }}</span>
              </td>
              <td class="num sub muted">{{ b.buildingCode }}</td>
              <td class="num"><Money :cents="b.minAmountCents" /></td>
              <td class="num"><Money :cents="b.deliveryFeeCents" /></td>
              <td class="sub">{{ b.accessibleFrom ?? '—' }}–{{ b.accessibleTo ?? '—' }}</td>
              <td class="num sub">{{ b.cutoffTime }}</td>
              <td>
                <button
                  class="btn btn--sm"
                  :class="{ 'btn--danger': !b.deliveryEnabled }"
                  type="button"
                  @click="toggleDelivery(b)"
                >
                  {{ b.deliveryEnabled ? '配送中' : '已停送' }}
                </button>
              </td>
              <td class="ops">
                <button class="btn btn--sm btn--ghost" type="button" @click="openEdit(b)">编辑</button>
                <button class="btn btn--sm btn--danger" type="button" @click="confirmDisable = b">停用</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </Panel>

    <Panel v-if="disabled.length" title="已停用的楼栋" desc="停用只影响新订单，历史订单与库存完整保留">
      <div class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr><th>楼栋</th><th>编号</th><th>状态</th></tr>
          </thead>
          <tbody>
            <tr v-for="b in disabled" :key="b.buildingId">
              <td>{{ b.buildingName }}</td>
              <td class="num sub muted">{{ b.buildingCode }}</td>
              <td class="sub muted">{{ b.status }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Panel>

    <!-- 编辑 -->
    <Modal :open="!!editing" :title="`编辑 ${editing?.buildingName ?? ''}`" @close="editing = null">
      <div class="field">
        <label class="field__label">楼栋名称</label>
        <input v-model="form.name" class="input" />
      </div>
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
      <div class="grid2">
        <div class="field">
          <label class="field__label">门禁开始</label>
          <input v-model="form.accessibleFrom" class="input num" placeholder="06:30" />
        </div>
        <div class="field">
          <label class="field__label">门禁结束</label>
          <input v-model="form.accessibleTo" class="input num" placeholder="22:30" />
        </div>
      </div>
      <div class="field">
        <label class="field__label">本栋公告</label>
        <input v-model="form.notice" class="input" placeholder="如 今晚只送到 21:00" />
      </div>
      <label class="check">
        <input v-model="form.deliveryEnabled" type="checkbox" />
        <span>该栋正常配送（取消勾选 = 停送，学生暂时选不了这栋）</span>
      </label>
      <template #footer>
        <button class="btn" type="button" @click="editing = null">取消</button>
        <button class="btn btn--primary" type="button" :disabled="saving" @click="save()">保存</button>
      </template>
    </Modal>

    <!-- 新增 -->
    <Modal :open="showCreate" title="添加楼栋" @close="showCreate = false">
      <div class="field">
        <label class="field__label">楼栋名称</label>
        <input v-model="newName" class="input" placeholder="如 6 栋" />
        <span class="field__hint">添加后默认继承店铺的起送价、配送费与门禁时间</span>
      </div>
      <template #footer>
        <button class="btn" type="button" @click="showCreate = false">取消</button>
        <button class="btn btn--primary" type="button" :disabled="creating || !newName.trim()" @click="createBuilding()">
          添加
        </button>
      </template>
    </Modal>

    <!-- 停用二次确认 -->
    <Modal :open="!!confirmDisable" title="停用楼栋" @close="confirmDisable = null">
      <p class="sub">
        将停用「{{ confirmDisable?.buildingName }}」。停用后：
      </p>
      <ul class="note">
        <li>学生不能再选这栋下单</li>
        <li>历史订单完整保留，可正常查询</li>
        <li>该栋的库存数量保留，不会清零</li>
        <li>停用不等于删除 —— 楼栋只能停用，不能删</li>
      </ul>
      <template #footer>
        <button class="btn" type="button" @click="confirmDisable = null">再想想</button>
        <button class="btn btn--danger" type="button" @click="doDisable()">确认停用</button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.bname {
  display: block;
  font-weight: var(--fw-medium);
}
.ops {
  display: flex;
  gap: var(--sp-1);
  justify-content: flex-end;
}
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-3);
}
.check {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-sub);
  color: var(--ink-700);
}
.note {
  margin: 0;
  padding-left: var(--sp-5);
  font-size: var(--fs-sub);
  line-height: var(--lh-sub);
  color: var(--ink-700);
}
</style>
