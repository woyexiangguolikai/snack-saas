<script setup lang="ts">
/**
 * P-03 创建租户向导（四步）。
 *
 * 四步的顺序是有道理的，不是排版：
 *   ① 基本资料 —— 没有它连库名都起不出来
 *   ② 学校与楼栋 —— 带出模板，可改名 / 排序 / 删减（模板只是初始值）
 *   ③ 凭证 —— **可后补**。商户号要商户本人去办（人脸/打款验证，代不了），
 *      卡在这里不让建租户，等于把"能并行的事"排成了串行
 *   ④ 确认创建 —— 建库 + 初始化 + 生成 12 阶段流水线
 *
 * 第 8 阶段（平台侧建库）由系统自动完成，所以创建完成后流水线是"1–7 待办、8 已完成"。
 */
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import PageHeader from '@/components/PageHeader.vue';
import Panel from '@/components/Panel.vue';
import { papi } from '@/api/platform';
import { useLoad, messageOf } from '@/composables/useLoad';
import { toast } from '@/utils/feedback';

const router = useRouter();
const { data: schools } = useLoad(() => papi.schools());

const step = ref(0);
const busy = ref(false);
const created = ref<{ tenantCode: string; shopName: string } | null>(null);

const form = ref({
  shopName: '',
  orgName: '',
  appid: '',
  schoolId: null as number | null,
  contactName: '',
  contactPhone: '',
  region: '广西',
  buildingNames: [] as string[],
  uploadKey: '',
  mchId: '',
});

const school = computed(() => (schools.value?.items ?? []).find((s) => s.id === form.value.schoolId) ?? null);

const STEP_TEXT = ['基本资料', '学校与楼栋', '凭证（可后补）', '确认创建'];

function pickSchool(id: number | null): void {
  form.value.schoolId = id;
  // 换学校就重带模板 —— 上一所的楼栋名留着会建出一个"混了两所学校"的楼栋列表
  form.value.buildingNames = (schools.value?.items ?? []).find((s) => s.id === id)?.buildingTemplates ?? [];
}

function stepValid(i: number): string {
  if (i === 0) {
    if (!form.value.shopName.trim()) return '店铺名不能为空';
    if (!form.value.orgName.trim()) return '执照主体不能为空（对账、开发票要用）';
    return '';
  }
  if (i === 1 && !form.value.buildingNames.length) return '至少要有一个楼栋，否则学生没地方可送';
  return '';
}

function next(): void {
  const err = stepValid(step.value);
  if (err) {
    toast(err, 'warn');
    return;
  }
  step.value = Math.min(3, step.value + 1);
}

function addBuilding(): void {
  form.value.buildingNames.push('');
}

function removeBuilding(i: number): void {
  form.value.buildingNames.splice(i, 1);
}

async function submit(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    const err = stepValid(i);
    if (err) {
      step.value = i;
      toast(err, 'warn');
      return;
    }
  }
  busy.value = true;
  try {
    const r = await papi.createTenant({
      shopName: form.value.shopName.trim(),
      orgName: form.value.orgName.trim(),
      appid: form.value.appid.trim() || null,
      schoolId: form.value.schoolId,
      contactName: form.value.contactName.trim() || null,
      contactPhone: form.value.contactPhone.trim() || null,
      region: form.value.region,
      buildingNames: form.value.buildingNames.map((n) => n.trim()).filter(Boolean),
    });
    created.value = r.tenant;

    // 凭证后补：填了就立刻写，失败也不回滚建户（户已经建好了，密钥可以再传）
    if (form.value.uploadKey.trim()) {
      try {
        await papi.putSecret(r.tenant.tenantCode, 'upload_key', form.value.uploadKey.trim(), '建户时提交');
      } catch (e) {
        toast(`租户已创建，但上传密钥写入失败：${messageOf(e)}`, 'warn');
      }
    }
    toast(`已创建 ${r.tenant.shopName}（${r.tenant.tenantCode}）${r.singleBuildingMode ? '，单楼栋模式' : ''}`, 'ok');
  } catch (e) {
    toast(messageOf(e), 'danger');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div>
    <PageHeader title="创建租户" code="P-03" desc="四步：资料 → 学校楼栋 → 凭证 → 确认">
      <template #actions>
        <button class="btn" type="button" @click="router.push({ name: 'P-01' })">返回列表</button>
      </template>
    </PageHeader>

    <template v-if="created">
      <div class="p-note p-note--ok lead">
        租户已创建：{{ created.shopName }}（<span class="num">{{ created.tenantCode }}</span>）。
        第 8 阶段「平台侧创建租户（建库 / 初始化 / 带出楼栋模板）」已由系统自动完成，
        流水线第 1–7 阶段正在进行中。
      </div>
      <div class="row row--wrap">
        <button class="btn pbtn--primary" type="button" @click="router.push({ name: 'P-02', params: { tenantCode: created.tenantCode } })">
          去看这户的详情
        </button>
        <button class="btn" type="button" @click="router.push({ name: 'P-04' })">去流水线看板</button>
        <button class="btn" type="button" @click="router.push({ name: 'P-01' })">回租户列表</button>
      </div>
    </template>

    <template v-else>
      <ol class="steps">
        <li
          v-for="(t, i) in STEP_TEXT"
          :key="t"
          :class="{ 'steps__i--done': i < step, 'steps__i--on': i === step }"
          class="steps__i"
        >
          <span class="steps__n">{{ i + 1 }}</span>{{ t }}
        </li>
      </ol>

      <!-- 第一步：基本资料 -->
      <Panel v-if="step === 0" title="基本资料" class="gap">
        <div class="grid">
          <label class="field">
            <span class="field__label">店铺名 *</span>
            <input v-model="form.shopName" class="input" placeholder="如：西大 1 号零食铺" />
          </label>
          <label class="field">
            <span class="field__label">执照主体 *</span>
            <input v-model="form.orgName" class="input" placeholder="如：南宁市西乡塘区某某便利店（个体工商户）" />
            <span class="field__hint">用于对账与开票，必须与执照一致</span>
          </label>
          <label class="field">
            <span class="field__label">AppID</span>
            <input v-model="form.appid" class="input" placeholder="wx 开头，可后补" />
            <span class="field__hint">AppID 是租户识别的唯一依据；没绑定前学生端打开会显示「店铺未开通」</span>
          </label>
          <label class="field">
            <span class="field__label">地区</span>
            <input v-model="form.region" class="input" />
          </label>
          <label class="field">
            <span class="field__label">联系人</span>
            <input v-model="form.contactName" class="input" />
          </label>
          <label class="field">
            <span class="field__label">联系电话</span>
            <input v-model="form.contactPhone" class="input" />
          </label>
        </div>
        <template #actions>
          <button class="btn pbtn--primary" type="button" @click="next()">下一步</button>
        </template>
      </Panel>

      <!-- 第二步：学校与楼栋 -->
      <Panel v-if="step === 1" title="学校与楼栋" desc="模板只是初始值 —— 可改名、排序、删减" class="gap">
        <div class="schools">
          <button
            v-for="s in schools?.items ?? []"
            :key="s.id"
            class="school"
            :class="{ 'school--on': s.id === form.schoolId }"
            type="button"
            @click="pickSchool(s.id)"
          >
            <b>{{ s.name }}</b>
            <span class="sub muted">{{ s.region }} · {{ s.buildingTemplates.length }} 个楼栋模板</span>
          </button>
        </div>

        <p class="field__label mt">楼栋清单（{{ form.buildingNames.length }}）</p>
        <div class="blds">
          <div v-for="(_, i) in form.buildingNames" :key="i" class="bld">
            <input v-model="form.buildingNames[i]" class="input" />
            <button class="btn btn--sm btn--danger" type="button" @click="removeBuilding(i)">删除</button>
          </div>
        </div>
        <button class="btn btn--sm" type="button" @click="addBuilding()">+ 手工新增一个楼栋</button>

        <p class="p-note p-note--info mt">
          只勾一个楼栋也没问题：有效楼栋 = 1 时，前后台会自动隐藏楼栋选择 UI（单楼栋降级）。
        </p>
        <template #actions>
          <button class="btn" type="button" @click="step = 0">上一步</button>
          <button class="btn pbtn--primary" type="button" @click="next()">下一步</button>
        </template>
      </Panel>

      <!-- 第三步：凭证 -->
      <Panel v-if="step === 2" title="凭证（可后补）" desc="商户号与上传密钥要商户本人去办，代不了" class="gap">
        <div class="grid">
          <label class="field">
            <span class="field__label">代码上传密钥</span>
            <input v-model="form.uploadKey" class="input" type="password" placeholder="只有小程序管理员能生成" />
            <span class="field__hint">
              现在填就现在入库（加密存储，界面上只显示前 4 位）；不填也行，第 7 阶段再收。
            </span>
          </label>
          <label class="field">
            <span class="field__label">微信支付商户号</span>
            <input v-model="form.mchId" class="input" placeholder="可后补" />
            <span class="field__hint">需要商户本人完成人脸 / 打款验证，我方无法代办</span>
          </label>
        </div>
        <p class="p-note p-note--info mt">
          凭证在这里是「可后补」的：卡在凭证不让建户，等于把本来能并行的事排成了串行 ——
          而商户号可能要等一周。
        </p>
        <template #actions>
          <button class="btn" type="button" @click="step = 1">上一步</button>
          <button class="btn pbtn--primary" type="button" @click="next()">下一步</button>
        </template>
      </Panel>

      <!-- 第四步：确认 -->
      <Panel v-if="step === 3" title="确认创建" desc="建库 + 初始化 + 带出楼栋模板 + 开户 + 生成 12 阶段流水线" class="gap">
        <dl class="kv">
          <div><dt>店铺名</dt><dd>{{ form.shopName }}</dd></div>
          <div><dt>执照主体</dt><dd>{{ form.orgName }}</dd></div>
          <div><dt>AppID</dt><dd class="num">{{ form.appid || '（未填，可后补）' }}</dd></div>
          <div><dt>学校</dt><dd>{{ school?.name ?? '未选' }}</dd></div>
          <div><dt>楼栋</dt><dd>{{ form.buildingNames.filter(Boolean).join('、') || '（无）' }}</dd></div>
          <div><dt>上传密钥</dt><dd>{{ form.uploadKey ? '已填，创建后写入（不可再查看）' : '（未填，第 7 阶段再收）' }}</dd></div>
        </dl>

        <p class="p-note p-note--warn mt">
          创建后会立刻生成租户库并带出楼栋。租户号若不指定，由系统按
          <span class="num">t000001</span> 递增分配。
        </p>
        <template #actions>
          <button class="btn" type="button" :disabled="busy" @click="step = 2">上一步</button>
          <button class="btn pbtn--primary" type="button" :disabled="busy" @click="submit()">
            {{ busy ? '创建中…' : '确认创建' }}
          </button>
        </template>
      </Panel>
    </template>
  </div>
</template>

<style scoped>
.lead {
  margin-bottom: var(--sp-4);
}
.gap {
  margin-top: var(--sp-4);
}
.steps {
  display: flex;
  gap: var(--sp-3);
  margin: 0 0 var(--sp-4);
  padding: 0;
  list-style: none;
}
.steps__i {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-sub);
  color: var(--ink-400);
}
.steps__n {
  width: 20px;
  height: 20px;
  border-radius: var(--r-full);
  background: var(--line-100);
  color: var(--ink-500);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-tag);
}
.steps__i--on {
  color: var(--ink-900);
  font-weight: var(--fw-medium);
}
.steps__i--on .steps__n {
  background: var(--ink-900);
  color: var(--surface);
}
.steps__i--done {
  color: var(--ok);
}
.steps__i--done .steps__n {
  background: var(--ok-bg);
  color: var(--ink-900);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: var(--sp-4);
}
.schools {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--sp-2);
}
.school {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: var(--sp-3);
  border: var(--bd);
  border-radius: var(--r-md);
  background: var(--surface);
  text-align: left;
}
.school:hover {
  background: var(--line-100);
}
.school--on {
  border-color: var(--ink-900);
  background: var(--line-100);
}
.blds {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: var(--sp-2);
  margin-bottom: var(--sp-2);
}
.bld {
  display: flex;
  gap: var(--sp-2);
}
.mt {
  margin-top: var(--sp-3);
}
.kv {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: var(--sp-3);
  margin: 0;
}
.kv dt {
  font-size: var(--fs-sub);
  color: var(--ink-500);
}
.kv dd {
  margin: 2px 0 0;
}
</style>
