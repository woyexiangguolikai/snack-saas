<script setup lang="ts">
/**
 * P-13 学校与楼栋模板。
 *
 * 这一页存在的理由是**减少一次重复劳动**：同一所学校开第二家店时，
 * 楼栋清单是已知的、稳定的（1 号楼、2 号楼、体育馆…）。没有模板，
 * 建租户向导就要每次让人手打一遍楼栋名 —— 打错一个字就是"3 号楼"和"三号楼"
 * 变成两栋楼，而这两个数据在配送清单里会各自成组，看起来像有 6 栋楼。
 *
 * 「删除」必须挡住在用模板：模板被租户引用后删掉，那些租户的详情页
 * 会显示空白，而没有任何人知道为什么 —— 所以服务端拒绝，界面把拒绝原因说清楚。
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

const { data, loading, error, run } = useLoad(() => papi.schoolTemplates());

type School = NonNullable<typeof data.value>['items'][number];

const schools = computed<School[]>(() => data.value?.items ?? []);

const keyword = ref('');
const filtered = computed(() => {
  const k = keyword.value.trim().toLowerCase();
  if (!k) return schools.value;
  return schools.value.filter(
    (s) => s.name.toLowerCase().includes(k) || s.region.toLowerCase().includes(k) || (s.city ?? '').toLowerCase().includes(k),
  );
});

/* ------------------------------------------------------------ 编辑 */

/** 表单用独立 ref 而不是一个对象 —— 模板里  这类非空断言对 vue-tsc 不可靠 */
const open = ref(false);
const editId = ref<number | null>(null);
const fName = ref('');
const fRegion = ref('');
const fCity = ref('');
const fBuildings = ref('');
const busy = ref(false);

function openNew(): void {
  editId.value = null;
  fName.value = '';
  fRegion.value = '';
  fCity.value = '';
  fBuildings.value = '';
  open.value = true;
}

function openEdit(s: School): void {
  editId.value = s.id;
  fName.value = s.name;
  fRegion.value = s.region;
  fCity.value = s.city ?? '';
  // 一行一栋：批量改楼栋清单时，逐行编辑比一排小输入框快得多
  fBuildings.value = s.buildings.map((b) => b.name).join('\n');
  open.value = true;
}

/** 一行一栋，去掉空行与前后空格，并去重（同名楼栋会让库存矩阵出现两列一模一样的列） */
function parseBuildings(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    const name = line.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

const parsed = computed(() => parseBuildings(fBuildings.value));

async function submit(): Promise<void> {
  if (!open.value) return;
  if (!fName.value.trim() || !fRegion.value.trim()) {
    toast('学校名称与地区不能为空', 'warn');
    return;
  }
  const buildingNames = parseBuildings(fBuildings.value);
  if (!buildingNames.length) {
    toast('至少要有 1 栋楼 —— 没有楼栋的学校模板在向导里没有任何作用', 'warn');
    return;
  }
  busy.value = true;
  try {
    await papi.saveSchool({
      id: editId.value ?? undefined,
      name: fName.value.trim(),
      region: fRegion.value.trim(),
      city: fCity.value.trim() || null,
      buildingNames,
    });
    toast(editId.value ? '已保存' : `已新建，含 ${buildingNames.length} 栋楼的模板`, 'ok');
    open.value = false;
    await run();
  } catch (err) {
    toast(messageOf(err), 'danger');
  } finally {
    busy.value = false;
  }
}

/* ------------------------------------------------------------ 删除 */

const removing = ref<School | null>(null);

async function submitDelete(): Promise<void> {
  const s = removing.value;
  if (!s) return;
  busy.value = true;
  try {
    const r = (await papi.deleteSchool(s.id)) as { deleted?: boolean; blockedBy?: number };
    if (r?.blockedBy) {
      toast(`已被 ${r.blockedBy} 家租户引用，删不得 —— 删了那些租户的详情页会变空白`, 'danger');
    } else {
      toast('已删除', 'ok');
    }
    removing.value = null;
    await run();
  } catch (e) {
    toast(messageOf(e), 'danger');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <PageHeader title="学校与楼栋模板" code="P-13">
    <template #actions>
      <input v-model="keyword" class="input sk__search" placeholder="搜学校 / 地区" />
      <button class="btn pbtn--primary" type="button" @click="openNew">新建学校模板</button>
    </template>
  </PageHeader>

  <ErrorBanner :text="error" @retry="run()" :kept="'搜过的关键词还在。'" />

  <div class="p-note p-note--info gap">
    模板的作用是省掉一次重复录入：同一所学校开第二家店时，楼栋清单照抄即可。
    没有模板，每次建租户都要手打一遍楼栋名，而「3 号楼」和「三号楼」会变成两栋楼。
  </div>

  <PageSkeleton v-if="loading" preset="table" />
  <EmptyState v-else-if="!filtered.length && !error" :text="keyword ? '没有匹配的学校' : '还没有学校模板'" />
  <div v-else class="sc gap">
    <Panel v-for="s in filtered" :key="s.id" :title="s.name" :desc="`${s.region}${s.city ? ' · ' + s.city : ''}`">
      <template #actions>
        <button class="btn btn--sm" type="button" @click="openEdit(s)">编辑</button>
        <button class="btn btn--sm btn--danger" type="button" @click="removing = s">删除</button>
      </template>

      <div class="sc__row">
        <span class="sc__k">楼栋</span>
        <span class="sc__v">共 {{ s.buildings.length }} 栋</span>
      </div>
      <div class="sc__blds">
        <span v-for="b in s.buildings" :key="b.id" class="sc__bld">{{ b.name }}</span>
        <span v-if="!s.buildings.length" class="sc__none">没有楼栋 —— 这个模板在建租户时不起作用</span>
      </div>
      <div class="sc__row sc__row--foot">
        <span class="sc__k">已被引用</span>
        <span class="sc__v" :class="s.tenantCount ? 'sc__v--used' : ''">
          {{ s.tenantCount ? `${s.tenantCount} 家租户` : '还没有租户用它' }}
        </span>
      </div>
    </Panel>
  </div>

  <Modal :open="open" :title="editId ? '编辑学校模板' : '新建学校模板'" :width="560" @close="open = false">
    <label class="sc__f">
      <span class="sc__fk">学校名称</span>
      <input v-model="fName" class="input" placeholder="如 江西理工大学（三江校区）" />
    </label>
    <div class="sc__two">
      <label class="sc__f">
        <span class="sc__fk">地区</span>
        <input v-model="fRegion" class="input" placeholder="如 江西省赣州市" />
      </label>
      <label class="sc__f">
        <span class="sc__fk">城市（可选）</span>
        <input v-model="fCity" class="input" placeholder="如 赣州" />
      </label>
    </div>
    <label class="sc__f">
      <span class="sc__fk">楼栋清单（一行一栋）</span>
      <textarea
        v-model="fBuildings"
        class="input"
        rows="6"
        placeholder="1 号楼&#10;2 号楼&#10;3 号楼&#10;研究生公寓"
      />
    </label>
    <p class="sc__hint">
      已解析出 <b>{{ parsed.length }}</b> 栋：{{ parsed.length ? parsed.join('、') : '（还没有）' }}
    </p>
    <p class="sc__hint sc__hint--dim">空行会被忽略；重复的名称会自动去重。</p>
    <template #footer>
      <button class="btn" type="button" @click="open = false">取消</button>
      <button class="btn pbtn--primary" type="button" :disabled="busy" @click="submit">
        {{ busy ? '保存中…' : '保存' }}
      </button>
    </template>
  </Modal>

  <Modal :open="!!removing" title="删除学校模板" :width="480" @close="removing = null">
    <p class="sc__delname">{{ removing?.name }}</p>
    <p class="p-note p-note--warn">
      {{ removing?.tenantCount
        ? `这个模板已被 ${removing?.tenantCount} 家租户引用，删除会被服务端拒绝 ——
           删掉之后那些租户的详情页会显示空白，而没人知道为什么。`
        : '这个模板还没有被任何租户引用，可以删。' }}
    </p>
    <template #footer>
      <button class="btn" type="button" @click="removing = null">取消</button>
      <button
        class="btn btn--danger"
        type="button"
        :disabled="busy || !!removing?.tenantCount"
        @click="submitDelete"
      >
        {{ busy ? '删除中…' : '确认删除' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.sc__search {
  max-width: 220px;
}
.sc {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
}
.sc__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  font-size: var(--fs-sub);
}
.sc__row--foot {
  margin-top: var(--sp-3);
  padding-top: var(--sp-3);
  border-top: var(--bd);
}
.sc__k {
  color: var(--ink-500);
}
.sc__v {
  color: var(--ink-900);
}
.sc__v--used {
  color: var(--info);
}
.sc__blds {
  margin-top: var(--sp-2);
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-1);
}
.sc__bld {
  padding: 2px 8px;
  border-radius: var(--r-full);
  background: var(--line-100);
  color: var(--ink-700);
  font-size: var(--fs-tag);
}
.sc__none {
  font-size: var(--fs-tag);
  color: var(--warn);
}

.sc__f {
  display: block;
  margin-bottom: var(--sp-3);
}
.sc__fk {
  display: block;
  margin-bottom: var(--sp-1);
  font-size: var(--fs-sub);
  color: var(--ink-500);
}
.sc__two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-3);
}
.sc__hint {
  margin: 0 0 var(--sp-1);
  font-size: var(--fs-tag);
  color: var(--ink-700);
}
.sc__hint--dim {
  color: var(--ink-400);
}
.sc__delname {
  margin: 0 0 var(--sp-3);
  font-weight: var(--fw-medium);
  color: var(--ink-900);
}
</style>
