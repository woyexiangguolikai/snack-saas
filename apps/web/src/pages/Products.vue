<script setup lang="ts">
/**
 * W-04 商品管理。
 *
 * 与手机端（M-04）的分工：手机端是"顺手改一个"，这一页是"一次整理几十个"。
 * 所以这里把筛选、批量上下架、价签都排在一起，而不是照搬手机端的卡片流。
 */
import { computed, ref } from 'vue';
import { api } from '@/api';
import type { Product } from '@/api/types';
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
import PartialFailure from '@/components/PartialFailure.vue';

const products = useLoad(() => api.products(true));
const categories = useLoad(async () => (await api.categories()).items);

const categoryId = ref<number | ''>('');
const keyword = ref('');
const onlyOn = ref(false);

const filtered = computed(() => {
  let rows = products.data.value?.items ?? [];
  if (categoryId.value !== '') rows = rows.filter((p) => p.categoryId === categoryId.value);
  const kw = keyword.value.trim();
  if (kw) rows = rows.filter((p) => p.name.includes(kw) || (p.spec ?? '').includes(kw));
  if (onlyOn.value) rows = rows.filter((p) => p.status === 'active');
  return rows;
});

const editing = ref<Product | null>(null);
const form = ref({ name: '', spec: '', price: '', categoryId: '' as number | '' });
const saving = ref(false);
const showCreate = ref(false);

function openCreate(): void {
  form.value = { name: '', spec: '', price: '', categoryId: '' };
  editing.value = null;
  showCreate.value = true;
}

function openEdit(p: Product): void {
  editing.value = p;
  form.value = {
    name: p.name,
    spec: p.spec ?? '',
    price: centsToYuan(p.priceCents),
    categoryId: p.categoryId ?? '',
  };
  showCreate.value = true;
}

async function save(): Promise<void> {
  saving.value = true;
  try {
    const body = {
      name: form.value.name.trim(),
      spec: form.value.spec.trim() || null,
      priceCents: yuanToCents(form.value.price),
      categoryId: form.value.categoryId === '' ? null : Number(form.value.categoryId),
    };
    if (!body.name) {
      toast('商品名称不能为空', 'warn');
      return;
    }
    if (editing.value) {
      await api.updateProduct(editing.value.id, body);
      toast('已保存', 'ok');
    } else {
      await api.createProduct(body);
      toast('已创建，记得去库存矩阵给它上架并设置库存', 'ok');
    }
    showCreate.value = false;
    await products.run();
  } catch (e) {
    toast(messageOf(e), 'danger');
  } finally {
    saving.value = false;
  }
}

async function toggleStatus(p: Product): Promise<void> {
  try {
    await api.setProductStatus(p.id, p.status === 'active' ? 'off' : 'active');
    toast(p.status === 'active' ? '已下架，各栋立即不可见' : '已上架', 'ok');
    await products.run();
  } catch (e) {
    toast(messageOf(e), 'danger');
  }
}

const catName = (id: number | null) => categories.data.value?.find((c) => c.id === id)?.name ?? '未分类';
</script>

<template>
  <div>
    <PageHeader code="W-04" title="商品管理" desc="价格全局统一，不按楼栋 —— 换个楼栋就改价会让人怀疑被区别对待。">
      <template #actions>
        <button class="btn btn--primary" type="button" @click="openCreate()">新建商品</button>
      </template>
    </PageHeader>

    <ErrorBanner :text="products.error.value" @retry="products.run()" :kept="'已显示的商品和当前筛选都还在。'" />
    <PartialFailure
      v-if="categories.error.value && products.data.value"
      title="商品分类没加载出来"
      safe="已显示的商品可以直接增删改，「按分类筛选」暂时用不了。"
      @retry="categories.run()"
      retry-label="只重试分类"
    />

    <Panel flush>
      <template #actions>
        <div class="row row--wrap">
          <select v-model="categoryId" class="select" style="width: 140px">
            <option value="">全部分类</option>
            <option v-for="c in categories.data.value ?? []" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
          <input v-model="keyword" class="input" style="width: 180px" placeholder="搜索名称 / 规格" />
          <label class="check"><input v-model="onlyOn" type="checkbox" /><span>只看在售</span></label>
        </div>
      </template>

      <PageSkeleton v-if="products.loading.value && !filtered.length" preset="table" :rows="6" />
      <!-- 空态（12 类之⑨的一半）：这一格同时承担"还没有商品"与"筛选没结果"两种情况，
           文案必须能区分，但**下一步都给"新建商品"** —— 两种情况里
           用户最可能的诉求都是"我要往里加东西"。 -->
      <EmptyState
        v-else-if="!filtered.length && !products.error.value"
        :text="keyword || categoryId || onlyOn ? '没有符合条件的商品' : '还没有商品'"
        :hint="
          keyword || categoryId || onlyOn
            ? '换个筛选条件，或清空筛选看看全部商品'
            : '先建几个商品，再给各楼栋分配库存 —— 顺序反了会卡在库存矩阵上。也可以从 Excel 一次导入。'
        "
      >
        <button class="btn btn--sm btn--primary" type="button" @click="openCreate()">新建商品</button>
      </EmptyState>

      <div v-else class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>商品</th>
              <th>分类</th>
              <th class="num">单价</th>
              <th class="num">排序</th>
              <th>状态</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in filtered" :key="p.id">
              <td>
                <span class="pname">{{ p.name }}</span>
                <span v-if="p.spec" class="sub muted">{{ p.spec }}</span>
              </td>
              <td class="sub muted">{{ catName(p.categoryId) }}</td>
              <td class="num"><Money :cents="p.priceCents" /></td>
              <td class="num sub muted">{{ p.sort }}</td>
              <td>
                <span class="dot" :class="p.status === 'active' ? 'dot--on' : 'dot--off'" />
                {{ p.status === 'active' ? '在售' : '已下架' }}
              </td>
              <td class="ops">
                <button class="btn btn--sm btn--ghost" type="button" @click="openEdit(p)">编辑</button>
                <button
                  class="btn btn--sm"
                  :class="p.status === 'active' ? 'btn--danger' : ''"
                  type="button"
                  @click="toggleStatus(p)"
                >
                  {{ p.status === 'active' ? '下架' : '上架' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </Panel>

    <Modal :open="showCreate" :title="editing ? `编辑 ${editing.name}` : '新建商品'" @close="showCreate = false">
      <div class="field">
        <label class="field__label">名称</label>
        <input v-model="form.name" class="input" placeholder="如 冰红茶" />
      </div>
      <div class="field">
        <label class="field__label">规格</label>
        <input v-model="form.spec" class="input" placeholder="如 500ml · 瓶" />
      </div>
      <div class="grid2">
        <div class="field">
          <label class="field__label">单价（元）</label>
          <input v-model="form.price" class="input num" @input="form.price = sanitizeYuan(form.price)" />
        </div>
        <div class="field">
          <label class="field__label">分类</label>
          <select v-model="form.categoryId" class="select">
            <option value="">未分类</option>
            <option v-for="c in categories.data.value ?? []" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </div>
      </div>
      <template #footer>
        <button class="btn" type="button" @click="showCreate = false">取消</button>
        <button class="btn btn--primary" type="button" :disabled="saving" @click="save()">保存</button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.pname {
  display: block;
  font-weight: var(--fw-medium);
}
.ops {
  display: flex;
  gap: var(--sp-1);
  justify-content: flex-end;
}
.check {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  font-size: var(--fs-sub);
  color: var(--ink-700);
}
.dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: var(--r-full);
  margin-right: var(--sp-1);
}
.dot--on {
  background: var(--ok);
}
.dot--off {
  background: var(--off);
}
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-3);
}
</style>
