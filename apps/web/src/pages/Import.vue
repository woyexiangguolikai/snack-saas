<script setup lang="ts">
/**
 * W-08 批量导入（四步）。
 *
 * 为什么必须拆成四步而不是"选文件 → 直接导入"：
 *   一次性导入几十上百个商品，错了没有撤销。四步里的每一步都在回答一个
 *   导入前必须回答的问题：**你这表是什么**（解析）、**哪些行有问题**（校验）、
 *   **这些货上到哪几栋、各多少**（范围）、**到底成了几个**（结果）。
 *   省掉任何一步，出错时的代价都是"要么全删重来，要么一条条手动改"。
 */
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '@/api';
import { parseCsv, toCsv, downloadCsv } from '@/utils/csv';
import { yuanToCents } from '@/utils/money';
import { messageOf } from '@/composables/useLoad';
import { toast } from '@/utils/feedback';
import Panel from '@/components/Panel.vue';
import PageHeader from '@/components/PageHeader.vue';
import EmptyState from '@/components/EmptyState.vue';

const STEP_TEXT = ['选择文件', '预览与校验', '选择上架范围', '导入结果'];

const router = useRouter();
const step = ref(0);

/* ------------------------------------------------------------ ① 解析 */

interface ParsedRow {
  line: number;
  name: string;
  spec: string;
  price: string;
  category: string;
  errors: string[];
}

const rows = ref<ParsedRow[]>([]);
const fileName = ref('');

const HEADER = ['名称', '规格', '单价(元)', '分类'];

function downloadTemplate(): void {
  downloadCsv(
    '商品导入模板.csv',
    toCsv(HEADER, [
      ['冰红茶', '500ml·瓶', '3.50', '饮料'],
      ['薯片', '70g·袋', '5.00', '零食'],
    ]),
  );
}

/**
 * 「下载错误行」（§3.2 明确要求的两条出路之一，另一条是「跳过继续导入」）。
 *
 * 只有"跳过"是不够的：商户最终还是要拿着那几行去改，而在一张 240 行的表里
 * 翻找第 12、47、88 行，是最容易半路放弃的一步。所以把错误行单独导出 ——
 * 原样 4 列 + 一列「校验未通过」，他改完这个小文件单独再导一次即可，
 * 不必回过头去整张表里对行号。
 */
function downloadErrors(): void {
  if (!bad.value.length) return;
  const base = fileName.value.replace(/\.csv$/i, '') || '导入';
  downloadCsv(
    `${base}_错误行.csv`,
    toCsv(
      [...HEADER, '校验未通过'],
      bad.value.map((r) => [r.name, r.spec, r.price, r.category, r.errors.join('；')]),
    ),
  );
}

function onFile(e: Event): void {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  fileName.value = file.name;
  const reader = new FileReader();
  reader.onload = () => {
    rows.value = buildRows(parseCsv(String(reader.result ?? '')));
    step.value = 1;
  };
  reader.readAsText(file, 'utf-8');
}

/**
 * 单价的建议修正值（§5.4-9）。
 *
 * 「7.5元」→ 7.5，「￥3.50」→ 3.5。取不出一个正数就返回 null ——
 * 那时**不给建议**：编一个数字当建议比不给更糟（学生照着改，改完还是错的，
 * 而且这次他会以为是我们教错了）。
 */
function suggestPrice(raw: string): string | null {
  const cleaned = raw.replace(/[^\d.]/g, '');
  const n = Number(cleaned);
  if (!cleaned || !Number.isFinite(n) || n <= 0) return null;
  // 去掉浮点噪声与多余的零：3.5 而不是 3.5000000000000004，也不是 3.50
  return String(Math.round(n * 100) / 100);
}

function buildRows(grid: string[][]): ParsedRow[] {
  if (!grid.length) return [];
  // 首行若是表头就丢掉 —— 模板下载下来必然带表头，不跳过的话第一行会变成商品"名称"
  const first = grid[0].map((c) => c.trim());
  const hasHeader = first[0] === '名称';
  const body = hasHeader ? grid.slice(1) : grid;

  return body.map((cols, i) => {
    const name = (cols[0] ?? '').trim();
    const spec = (cols[1] ?? '').trim();
    const price = (cols[2] ?? '').trim();
    const category = (cols[3] ?? '').trim();

    // 行号先算出来：**每条错误都要带行号**（§5.4-9）。
    // 「文件格式错误」这种话学生没法动手 —— 他要在几百行里自己找出是哪一行。
    const line = i + (hasHeader ? 2 : 1);

    const errors: string[] = [];
    if (!name) errors.push(`第 ${line} 行没有商品名称，请补上名称`);

    const p = Number(price);
    if (!price) {
      errors.push(`第 ${line} 行没有填价格，请填一个数字，例如 3.50`);
    } else if (!Number.isFinite(p) || p <= 0) {
      const fix = suggestPrice(price);
      errors.push(
        fix
          ? `第 ${line} 行价格「${price}」不是数字，请改为 ${fix}`
          : `第 ${line} 行价格「${price}」不是数字，请填一个大于 0 的数字`,
      );
    } else if (Math.round(p * 100) !== p * 100) {
      // 分是最小单位，小数超过两位会在这里就被四舍五入掉 —— 与其静默改动金额，
      // 不如让商户自己决定第三位怎么处理（对账时"差 1 分"最难查）
      errors.push(`第 ${line} 行价格「${price}」超过两位小数，请改为 ${p.toFixed(2)}`);
    }

    return { line, name, spec, price, category, errors };
  });
}

/* ------------------------------------------------------------ ② 校验 */

const bad = computed(() => rows.value.filter((r) => r.errors.length));
const good = computed(() => rows.value.filter((r) => !r.errors.length));

/**
 * 校验结论（§5.4-10）。
 *
 * 关键是**给出"能做什么"**：只说"3 行有问题"会让人以为整批白选了，
 * 于是关掉页面去改文件 —— 而其实那 237 行现在就能导进去。
 */
const verdict = computed(() => {
  if (!rows.value.length) return '这个文件里没有可读取的数据行，请确认导出时选了 CSV 格式';
  if (!bad.value.length) return `${good.value.length} 行全部可用，直接下一步就行`;
  if (!good.value.length) return `${bad.value.length} 行都需要修正，改好后重新选这个文件`;
  return `${bad.value.length} 行需修正，其余 ${good.value.length} 行可先导入`;
});

/* --------------------------------------------------------- ③ 上架范围 */

const buildings = ref<Array<{ buildingId: number; buildingName: string }>>([]);
const picked = ref<number[]>([]);
const stock = ref('20');

(async () => {
  try {
    const r = await api.buildings();
    buildings.value = r.items
      .filter((b) => b.status === 'active')
      .map((b) => ({ buildingId: b.buildingId, buildingName: b.buildingName }));
  } catch (e) {
    toast(messageOf(e), 'danger');
  }
})();

function toggle(id: number): void {
  picked.value = picked.value.includes(id) ? picked.value.filter((x) => x !== id) : [...picked.value, id];
}

/* ------------------------------------------------------------ ④ 导入 */

interface RowResult {
  name: string;
  ok: boolean;
  message: string;
}

const running = ref(false);
const results = ref<RowResult[]>([]);

async function runImport(): Promise<void> {
  if (!picked.value.length) {
    toast('至少选择一栋楼', 'warn');
    return;
  }
  const qty = Number(stock.value);
  if (!Number.isInteger(qty) || qty < 0) {
    toast('初始库存必须是 0 或正整数', 'warn');
    return;
  }

  running.value = true;
  results.value = [];
  step.value = 3;

  // 逐条导入：**不因为一条失败就整批回滚**。
  // 已经建好的商品是既成事实，回滚只会让"哪些进去了"变成未知
  for (const r of good.value) {
    try {
      const created = await api.createProduct({
        name: r.name,
        spec: r.spec || null,
        priceCents: yuanToCents(r.price),
      });
      const pid = created.product.id;
      await api.syncPublish({ productId: pid, targetBuildingIds: picked.value, status: 'on' });
      await api.adjustStock({
        productId: pid,
        buildingId: picked.value[0],
        stock: qty,
        reason: '批量导入',
        operator: '批量导入',
      });
      // 其余楼栋用同一数量铺开（跨栋同步走的是 sync/stock，不逐格 adjust）
      if (picked.value.length > 1) {
        await api.syncStock({
          productId: pid,
          fromBuildingId: picked.value[0],
          targetBuildingIds: picked.value.slice(1),
          mode: 'value',
        });
      }
      results.value.push({ name: r.name, ok: true, message: `已创建并上架 ${picked.value.length} 栋` });
    } catch (e) {
      results.value.push({ name: r.name, ok: false, message: messageOf(e) });
    }
  }
  running.value = false;
  toast(
    `导入完成：成功 ${okCount.value}，失败 ${failCount.value}`,
    okCount.value ? 'ok' : 'warn',
  );
}

function reset(): void {
  step.value = 0;
  rows.value = [];
  results.value = [];
  fileName.value = '';
}

const okCount = computed(() => results.value.filter((r) => r.ok).length);
const failCount = computed(() => results.value.filter((r) => !r.ok).length);

/** ④ 结果页的结论（§5.4-10）：失败时必须说清"已经成了哪些"，而不是只报一个失败数 */
const resultVerdict = computed(() => {
  if (running.value) return '正在逐个创建，这条列表会实时更新';
  if (!failCount.value) return `${okCount.value} 个商品全部导入成功`;
  return `${failCount.value} 个没导进去，其余 ${okCount.value} 个已经建好了 —— 修好这几个再导一次即可`;
});

function stepClass(i: number): string {
  if (i < step.value) return 'steps__item--done';
  if (i === step.value) return 'steps__item--on';
  return '';
}
</script>

<template>
  <div>
    <PageHeader code="W-08" title="批量导入" desc="四步走：选文件 → 校验 → 选上架范围 → 看结果。错了能看见错在哪一行。" />

    <ol class="steps">
      <li v-for="(s, i) in STEP_TEXT" :key="s" class="steps__item" :class="stepClass(i)">
        <span class="steps__n num">{{ i + 1 }}</span>{{ s }}
      </li>
    </ol>

    <!-- ① -->
    <Panel v-if="step === 0" title="选择文件">
      <p class="sub muted">支持 CSV。用 Excel 打开进货表后「另存为 CSV」即可；表头顺序：{{ HEADER.join(' / ') }}。</p>
      <div class="row">
        <button class="btn" type="button" @click="downloadTemplate()">下载模板</button>
        <input class="file" type="file" accept=".csv,text/csv" @change="onFile" />
      </div>
    </Panel>

    <!-- ② -->
    <Panel v-else-if="step === 1" :title="`预览与校验 · ${fileName}`">
      <p class="sub">
        共 {{ rows.length }} 行 —— {{ verdict }}
      </p>
      <p v-if="bad.length" class="sub muted">
        两条出路都留着：先「下载错误行」拿去改，改好单独再导一次；也可以直接继续，
        有问题的行会被跳过，不会中断整批导入。
      </p>
      <div class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr><th class="num">行</th><th>名称</th><th>规格</th><th class="num">单价</th><th>分类</th><th>校验</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.line">
              <td class="num sub muted">{{ r.line }}</td>
              <td>{{ r.name || '—' }}</td>
              <td class="sub muted">{{ r.spec || '—' }}</td>
              <td class="num">{{ r.price || '—' }}</td>
              <td class="sub muted">{{ r.category || '—' }}</td>
              <td>
                <span v-if="!r.errors.length" class="ok">通过</span>
                <span v-else class="bad">{{ r.errors.join('；') }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="row" style="margin-top: var(--sp-3)">
        <button class="btn" type="button" @click="reset()">换个文件</button>
        <button v-if="bad.length" class="btn" type="button" @click="downloadErrors()">
          下载错误行（{{ bad.length }}）
        </button>
        <div class="spacer" />
        <button class="btn btn--primary" type="button" :disabled="!good.length" @click="step = 2">
          下一步：选择上架范围
        </button>
      </div>
    </Panel>

    <!-- ③ -->
    <Panel v-else-if="step === 2" title="选择上架范围">
      <p class="sub muted">
        将把 {{ good.length }} 个商品上架到勾选的楼栋，并给每栋设置相同的初始库存。
        上架后仍可在库存矩阵里逐格调整。
      </p>
      <div class="chips">
        <button
          v-for="b in buildings"
          :key="b.buildingId"
          class="chip"
          :class="{ 'chip--on': picked.includes(b.buildingId) }"
          type="button"
          @click="toggle(b.buildingId)"
        >
          {{ b.buildingName }}
        </button>
        <EmptyState v-if="!buildings.length" text="还没有楼栋" hint="先去楼栋页添加" />
      </div>
      <div class="field stockfield">
        <label class="field__label">初始库存</label>
        <input v-model="stock" class="input num" style="width: 140px" />
        <span class="field__hint">每栋每格都设为这个数量</span>
      </div>
      <div class="row">
        <button class="btn" type="button" @click="step = 1">上一步</button>
        <div class="spacer" />
        <button class="btn btn--primary" type="button" :disabled="!picked.length || running" @click="runImport()">
          开始导入
        </button>
      </div>
    </Panel>

    <!-- ④ -->
    <Panel v-else :title="running ? '正在导入…' : '导入结果'">
      <p class="sub">{{ resultVerdict }}</p>
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr><th>商品</th><th>结果</th></tr></thead>
          <tbody>
            <tr v-for="(r, i) in results" :key="i">
              <td>{{ r.name }}</td>
              <td :class="r.ok ? 'ok' : 'bad'">{{ r.message }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="row" style="margin-top: var(--sp-3)">
        <div class="spacer" />
        <button class="btn" type="button" @click="reset()">再导一批</button>
        <button class="btn btn--primary" type="button" :disabled="running" @click="router.push('/products')">
          去商品管理
        </button>
      </div>
    </Panel>
  </div>
</template>

<style scoped>
.steps {
  display: flex;
  gap: var(--sp-4);
  list-style: none;
  margin: 0 0 var(--sp-4);
  padding: 0;
  flex-wrap: wrap;
}
.steps__item {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-sub);
  color: var(--ink-400);
}
.steps__n {
  width: 22px;
  height: 22px;
  border-radius: var(--r-full);
  border: var(--bd);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-tag);
}
.steps__item--on {
  color: var(--brand-700);
  font-weight: var(--fw-medium);
}
.steps__item--on .steps__n {
  background: var(--brand-500);
  border-color: var(--brand-500);
  color: var(--on-brand);
}
.steps__item--done {
  color: var(--ink-700);
}
.steps__item--done .steps__n {
  background: var(--ok-bg);
  border-color: var(--ok-bg);
  color: var(--ok);
}

.file {
  font-size: var(--fs-sub);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
  margin: var(--sp-3) 0;
}
.chip {
  padding: var(--sp-2) var(--sp-4);
  border: var(--bd);
  border-radius: var(--r-full);
  background: var(--surface);
  color: var(--ink-700);
  font-size: var(--fs-sub);
  transition: background var(--d-color) var(--e-std), color var(--d-color) var(--e-std);
}
.chip--on {
  background: var(--brand-500);
  border-color: var(--brand-500);
  color: var(--on-brand);
}
.stockfield {
  max-width: 220px;
  margin-bottom: var(--sp-3);
}
.ok {
  color: var(--ok);
}
.bad {
  color: var(--danger);
}
</style>
