<script setup lang="ts">
import { reactive, ref } from 'vue';
import SnPage from '../../components/SnPage.vue';
import SnButton from '../../components/SnButton.vue';
import SnIconButton from '../../components/SnIconButton.vue';
import SnInput from '../../components/SnInput.vue';
import SnStepper from '../../components/SnStepper.vue';
import SnSwitch from '../../components/SnSwitch.vue';
import SnCheckbox from '../../components/SnCheckbox.vue';
import SnSegmented from '../../components/SnSegmented.vue';
import SnChip from '../../components/SnChip.vue';
import SnAnchor from '../../components/SnAnchor.vue';
import SnTag from '../../components/SnTag.vue';
import SnBadge from '../../components/SnBadge.vue';
import SnAmount from '../../components/SnAmount.vue';
import SnKeyValue from '../../components/SnKeyValue.vue';
import SnListRow from '../../components/SnListRow.vue';
import SnPageHeader from '../../components/SnPageHeader.vue';
import SnTable from '../../components/SnTable.vue';
import SnPagination from '../../components/SnPagination.vue';
import SnBulkBar from '../../components/SnBulkBar.vue';
import SnThumb from '../../components/SnThumb.vue';
import SnAvatar from '../../components/SnAvatar.vue';
import SnSkeleton from '../../components/SnSkeleton.vue';
import SnProgress from '../../components/SnProgress.vue';
import SnDivider from '../../components/SnDivider.vue';
import SnStickyBar from '../../components/SnStickyBar.vue';
import { useThemeStore } from '../../stores/theme';
import { THEME_SAMPLES } from '../../mock/theme-samples';
import { formatAmount, parseAmount } from '../../utils/amount';

/**
 * 组件 Playground —— S0 的退出条件就是「14 类原子组件全状态与设计系统一致」。
 * 这个页面同时是三样东西：组件的可视化核对台、换肤护栏的现场演示、以及能自证的自检面板。
 */

const theme = useThemeStore();

// ---- 交互状态 ----
const form = reactive({
  room: '302',
  floor: '',
  notice: '今天 21:00 后下单的订单，明早 06:30 统一配送。',
  price: '12',
  error: '3 楼',
});
const cartQty = ref(2);
const stockQty = ref(24);
const shopOpen = ref(true);
const recommend = ref(false);
const checked = ref(true);
const halfCheck = ref(false);
const seg = ref('pending');
const chip = ref('全部');
const anchor = ref('hot');
const page = ref(3);
const selected = ref<Array<string | number>>([1]);

const themeHint = ref('');
const showSticky = ref(true);

function applyTheme(code: string) {
  const s = THEME_SAMPLES.find((x) => x.code === code);
  if (!s) return;
  theme.applyTenantTheme(s.scale, s.code);
  themeHint.value = `${s.name}：${s.note}`;
}

// ---- 表格数据 ----
const columns = [
  { key: 'name', title: '商品' },
  { key: 'cat', title: '分类' },
  { key: 'price', title: '价格', type: 'num' as const, width: '90px' },
  { key: 'b1', title: '1 栋', type: 'num' as const, width: '70px' },
  { key: 'b2', title: '2 栋', type: 'num' as const, width: '70px' },
  { key: 'status', title: '状态', type: 'tag' as const, width: '100px' },
  { key: 'op', title: '操作', type: 'actions' as const },
];
const rows = [
  { id: 1, name: '乐事薯片 原味 104g', cat: '薯片膨化', price: '¥7.50', b1: '24', b2: '3', status: '在售', statusTone: 'ok' },
  { id: 2, name: '康师傅红烧牛肉面', cat: '方便面', price: '¥4.50', b1: '12', b2: '9', status: '在售', statusTone: 'ok' },
  { id: 3, name: '冰红茶 500ml', cat: '饮料', price: '¥3.00', b1: '0', b2: '18', status: '本栋售罄', statusTone: 'danger' },
  { id: 4, name: '士力架 51g', cat: '糖果', price: '¥4.00', b1: '8', b2: '2', status: '在售', statusTone: 'ok' },
];
const rowNote = (row: Record<string, unknown>) =>
  row.id === 4 ? '已被 12 笔订单引用，不可删除' : '';
const rowLocked = (row: Record<string, unknown>) => row.id === 4;

// ---- 自检面板：把「声称」变成「当场可证」 ----
interface CheckItem {
  name: string;
  detail: string;
  ok: boolean;
}
const checks = ref<CheckItem[]>([]);

function buildChecks(): CheckItem[] {
  const out: CheckItem[] = [];
  const eq = (name: string, actual: unknown, expected: unknown) =>
    out.push({
      name,
      detail: `期望 ${String(expected)}，实际 ${String(actual)}`,
      ok: String(actual) === String(expected),
    });

  // A-09 金额格式
  eq('整元省去 .00', formatAmount(1200), '¥12');
  eq('有零头固定 2 位', formatAmount(1250), '¥12.50');
  eq('不出一位小数', formatAmount(1255), '¥12.55');
  eq('≥10000 加千分位', formatAmount(1_248_000), '¥12,480');
  eq('零元不显符号', formatAmount(0), '¥0');
  eq('出账用 U+2212', formatAmount(-24, { signed: true }), '¥−0.24');
  eq('入账显式带 +', formatAmount(100_00, { signed: true }), '¥+100');
  eq('¥ 与整数分离排版', parseAmount(1250).symbol + parseAmount(1250).int, '¥12');

  // 换肤护栏：语义色必须被拒（值不重要，关键是被禁的是「键」）
  const rejectResult = theme.applyTenantTheme({ '--danger': '语义色不许换肤' } as never, 'bad');
  out.push({
    name: '换肤护栏：拒绝语义色（AC-05）',
    detail: rejectResult.ok ? '未拒绝 —— 护栏失效' : `已拒绝：${rejectResult.rejected.join(', ')}`,
    ok: !rejectResult.ok,
  });

  // 服务端契约：generateBrandScale 下发的是「裸数字键」色阶，前端必须认
  const serverShape = theme.applyTenantTheme(THEME_SAMPLES[1].scale, 't000002');
  out.push({
    name: '接受服务端色阶形态（裸数字键 50–800）',
    detail: serverShape.ok
      ? '裸数字键色阶被正确接受 —— 服务端与前端契约一致'
      : `被自己的护栏拦掉了：${serverShape.rejected.join(', ')}`,
    ok: serverShape.ok,
  });

  // 平台后台锁死中性色（AC-12）
  theme.lockNeutral();
  const lockResult = theme.applyTenantTheme(THEME_SAMPLES[1].scale, 't999999');
  const locked = theme.brandOverride === null && theme.themeStyle === '';
  out.push({
    name: '平台后台锁死中性色（AC-12）',
    detail: locked
      ? `锁死后换肤被忽略（${lockResult.rejected.join(', ')}），页面回到 Token 中性基线`
      : `锁死后仍注入了主题：${theme.themeStyle.slice(0, 60)}`,
    ok: locked,
  });

  // 反证：不锁定时换肤必须真的生效 —— 否则上一条「通过」是因为功能整体坏了
  theme.reset();
  theme.applyTenantTheme(THEME_SAMPLES[1].scale, 't000002');
  const expected500 = `--brand-500:${THEME_SAMPLES[1].scale['500']}`;
  const applied = theme.themeStyle.includes(expected500);
  out.push({
    name: '反证：未锁定时换肤确实生效',
    detail: applied
      ? `${expected500} 已注入页面根节点`
      : `未生效，themeStyle=${theme.themeStyle.slice(0, 60)}`,
    ok: applied,
  });

  theme.reset();
  theme.applyTenantTheme(THEME_SAMPLES[0].scale, 't000001');

  return out;
}

checks.value = buildChecks();

const passCount = () => checks.value.filter((c) => c.ok).length;

const stateTitle = (t: string) => `A-${t}`;
const amountCases = [2350, 1200, 850, 1500, 100_00, -24, 0];
const statusTags: Array<{ tone: 'ok' | 'warn' | 'danger' | 'info' | 'off' | 'brand'; label: string; solid: boolean }> = [
  { tone: 'ok', label: '已送达', solid: true },
  { tone: 'warn', label: '即将截单', solid: true },
  { tone: 'danger', label: '需处理', solid: true },
  { tone: 'info', label: '配送中', solid: true },
  { tone: 'off', label: '已截单', solid: true },
  { tone: 'brand', label: '1 号宿舍楼', solid: true },
  { tone: 'ok', label: '营业中', solid: false },
  { tone: 'warn', label: '低库存', solid: false },
  { tone: 'danger', label: '余额不足', solid: false },
  { tone: 'info', label: '待提审', solid: false },
  { tone: 'off', label: '未上架', solid: false },
];
</script>

<template>
  <SnPage nav-title="组件 Playground" :show-back="false" surface="student">
    <view class="pg">
      <!-- ============ 换肤现场演示 ============ -->
      <view class="pg__sec">
        <text class="pg__h">换肤护栏现场演示</text>
        <text class="pg__p">
          切主题时，只有品牌色阶会变；Tag 的语义色（ok / warn / danger / info / off）必须逐字节不变 ——
          这就是 AC-05「语义色零换肤」。切换后请对比上方状态标签的颜色。
        </text>
        <view class="pg__themes">
          <SnButton
            v-for="t in THEME_SAMPLES"
            :key="t.code"
            :type="theme.tenantCode === t.code ? 'pri' : 'sec'"
            size="sm"
            :aria-label="t.name"
            @click="applyTheme(t.code)"
          >
            {{ t.name }}
          </SnButton>
        </view>
        <text v-if="themeHint" class="pg__hint">{{ themeHint }}</text>
      </view>

      <SnDivider />

      <!-- ============ A-01 按钮 ============ -->
      <view class="pg__sec">
        <text class="pg__h">A-01 按钮 Button</text>
        <text class="pg__p">5 类型 × 3 尺寸 × 6 状态。一屏只能有一个主按钮；禁用必须给出原因。</text>

        <view class="pg__row">
          <SnButton type="pri">接单</SnButton>
          <SnButton type="sec">联系顾客</SnButton>
          <SnButton type="tex">全部订单 ›</SnButton>
        </view>
        <view class="pg__row">
          <SnButton type="dan">取消订单</SnButton>
          <SnButton type="danf">确认停用</SnButton>
        </view>
        <view class="pg__row">
          <SnButton size="sm">小</SnButton>
          <SnButton size="md">中</SnButton>
          <SnButton size="lg">大</SnButton>
        </view>
        <view class="pg__row">
          <SnButton type="pri" disabled disabled-reason="还差 ¥3.00 起送">提交订单</SnButton>
          <SnButton type="pri" loading loading-text="提交中">提交订单</SnButton>
          <SnButton type="sec" :badge="5">批量送达</SnButton>
        </view>
        <view class="pg__block">
          <SnButton type="pri" block size="lg">立即支付 ¥12.50</SnButton>
        </view>
      </view>

      <SnDivider />

      <!-- ============ A-02 图标按钮 ============ -->
      <view class="pg__sec">
        <text class="pg__h">A-02 图标按钮 / 工具条</text>
        <text class="pg__p">视觉 34×34，热区 ≥44×44（靠外边距扩大，不放大视觉）；label 必填。</text>
        <view class="pg__row">
          <SnIconButton label="返回"><text>‹</text></SnIconButton>
          <SnIconButton label="编辑"><text>✎</text></SnIconButton>
          <SnIconButton label="复制"><text>⧉</text></SnIconButton>
          <SnIconButton label="消息" :badge="3"><text>⚑</text></SnIconButton>
          <SnIconButton label="消息" :badge="120"><text>⚑</text></SnIconButton>
          <SnIconButton label="删除" disabled disabled-reason="已被订单引用"><text>🗑</text></SnIconButton>
        </view>
      </view>

      <SnDivider />

      <!-- ============ A-03 输入框 ============ -->
      <view class="pg__sec">
        <text class="pg__h">A-03 输入框 Input</text>
        <text class="pg__p">6 状态；错误说明写在框下方且必须可行动（禁止「输入有误」这类无法行动的提示）。</text>

        <SnInput v-model="form.room" label="房间号" required placeholder="302 室" helper="楼层可留空，不填则按房间号文本排序" />
        <view class="pg__gap" />
        <SnInput
          v-model="form.error"
          label="房间号（错误态）"
          required
          placeholder="302 室"
          error="房间号请只填房间，楼栋在上方单独选择"
        />
        <view class="pg__gap" />
        <SnInput v-model="form.floor" label="楼层（成功态）" placeholder="3" success="已按房间号排序，配送时 3 楼会在 6 楼之前" />
        <view class="pg__gap" />
        <SnInput v-model="form.price" label="起送金额" type="digit" placeholder="20" clearable hint="可留空">
          <template #prefix><text>¥</text></template>
        </SnInput>
        <view class="pg__gap" />
        <SnInput
          v-model="form.room"
          label="已提交（禁用态）"
          disabled
          disabled-reason="提交后不可修改，如需更改请取消重下"
        />
        <view class="pg__gap" />
        <SnInput v-model="form.notice" label="店铺公告" type="textarea" placeholder="今天 21:00 后下单的订单，明早 06:30 统一配送。" :maxlength="60" />
      </view>

      <SnDivider />

      <!-- ============ A-04 步进器 ============ -->
      <view class="pg__sec">
        <text class="pg__h">A-04 数字步进器 Stepper</text>
        <text class="pg__p">
          加购与改库存共用，语义不同：加购减到 1 再减 = 移出购物车（弹撤销条）；库存减到 0 = 置售罄（轻提示）。
          两者都不弹确认框 —— 都可逆。
        </text>
        <view class="pg__kv">
          <text class="pg__k">未加购（只有 +）</text>
          <SnStepper :model-value="0" variant="cart" />
        </view>
        <view class="pg__kv">
          <text class="pg__k">已加购</text>
          <SnStepper v-model="cartQty" variant="cart" />
        </view>
        <view class="pg__kv">
          <text class="pg__k">减到 1（再减 = 移出）</text>
          <SnStepper :model-value="1" variant="cart" />
        </view>
        <view class="pg__kv">
          <text class="pg__k">改库存 · 达到上限</text>
          <SnStepper v-model="stockQty" variant="stock" :max="24" limit-hint="本栋仅剩 24 件" />
        </view>
        <view class="pg__kv">
          <text class="pg__k">改库存 · 提交中</text>
          <SnStepper :model-value="12" variant="stock" loading />
        </view>
        <view class="pg__kv">
          <text class="pg__k">改库存 · 已减到 0</text>
          <SnStepper :model-value="0" variant="stock" :max="24" limit-hint="顾客已看不到该商品" />
        </view>
      </view>

      <SnDivider />

      <!-- ============ A-05 开关 ============ -->
      <view class="pg__sec">
        <text class="pg__h">A-05 开关 Switch</text>
        <text class="pg__p">
          表示持续状态，不表示动作。表示「生效中/正常」用语义绿（换肤不变色），
          只有选项型开关（如设为推荐）才用品牌色。
        </text>
        <SnSwitch v-model="shopOpen" label="营业中" description="关闭后学生无法下单，已下单的订单不受影响" />
        <view class="pg__gap" />
        <SnSwitch :model-value="false" label="本栋今日停送" description="该栋学生将看到「今日已停送」，库存保留" />
        <view class="pg__gap" />
        <SnSwitch v-model="recommend" tone="brand" label="设为推荐" description="选项型开关 —— 用品牌色，随主题变化" />
        <view class="pg__gap" />
        <SnSwitch :model-value="true" disabled disabled-reason="单楼栋商户自动启用，不可关闭" label="启用楼栋" />
      </view>

      <SnDivider />

      <!-- ============ A-06 复选 / 单选 ============ -->
      <view class="pg__sec">
        <text class="pg__h">A-06 复选 / 单选</text>
        <text class="pg__p">禁用项保留在列表中并说明原因，而不是移除 —— 移除会让商户以为功能坏了。</text>
        <SnCheckbox v-model="checked" label="同步到 2 号宿舍楼" />
        <SnCheckbox v-model="halfCheck" shape="radio" label="单选：按房间号排序" />
        <SnCheckbox :model-value="true" label="同步到 3 号宿舍楼" />
        <SnCheckbox
          :model-value="false"
          disabled
          disabled-reason="3 号宿舍楼今日停送，暂停同步"
          label="3 号宿舍楼"
        />
        <SnCheckbox :model-value="false" :indeterminate="true" trailing="已选 3 / 18 项" label="全选（半选态）" />
      </view>

      <SnDivider />

      <!-- ============ A-07 Chip / Segmented / 锚点 ============ -->
      <view class="pg__sec">
        <text class="pg__h">A-07 Chip / 分段控件 / 分类锚点</text>
        <text class="pg__p">Chip 可横滑可多选，Segmented 固定 2–4 项不滚动，锚点与长列表双向联动。</text>
        <scroll-view scroll-x class="pg__chips" :show-scrollbar="false">
          <view class="pg__chips-inner">
            <SnChip
              v-for="c in ['全部', '薯片膨化', '饮料', '方便面', '糖果']"
              :key="c"
              :label="c"
              :selected="chip === c"
              @click="chip = c"
            />
            <SnChip label="乳制品" disabled reason="本栋未上架" />
          </view>
        </scroll-view>
        <view class="pg__gap" />
        <SnSegmented
          v-model="seg"
          :options="[
            { value: 'pending', label: '待送', count: 5 },
            { value: 'done', label: '已送达', count: 12 },
          ]"
        />
        <view class="pg__gap" />
        <SnSegmented
          :model-value="'floor_desc'"
          :options="[
            { value: 'floor_desc', label: '楼层倒序' },
            { value: 'floor_asc', label: '楼层正序' },
            { value: 'room', label: '房间号' },
          ]"
        />
        <view class="pg__gap" />
        <SnAnchor
          :items="[
            { key: 'hot', label: '热销' },
            { key: 'chips', label: '薯片膨化' },
            { key: 'drink', label: '饮料' },
            { key: 'noodle', label: '方便面' },
            { key: 'candy', label: '糖果巧克力' },
          ]"
          :active-key="anchor"
          @change="anchor = $event"
        />
      </view>

      <SnDivider />

      <!-- ============ A-08 Tag / Badge / Dot ============ -->
      <view class="pg__sec">
        <text class="pg__h">A-08 标签 / 计数徽标 / 状态点</text>
        <text class="pg__p">每种颜色只对应一种业务含义，且永不换肤（切上方主题时逐个核对）。</text>
        <view class="pg__wrap">
          <SnTag
            v-for="t in statusTags"
            :key="t.label + t.solid"
            :tone="t.tone"
            :variant="t.solid ? 'solid' : 'outline'"
            :label="t.label"
          />
        </view>
        <view class="pg__gap" />
        <view class="pg__row">
          <SnBadge :count="3" />
          <SnBadge :count="12" />
          <SnBadge :count="120" />
          <SnBadge :count="1200" />
          <SnBadge count-tone="ok" :count="8" />
          <SnBadge count-tone="brand" :count="1" />
        </view>
        <view class="pg__gap" />
        <view class="pg__row">
          <SnBadge tone="ok" label="正常" />
          <SnBadge tone="warn" label="预警" />
          <SnBadge tone="danger" label="需处理" />
          <SnBadge tone="info" label="配送中" />
          <SnBadge tone="off" label="历史归档" />
        </view>
      </view>

      <SnDivider />

      <!-- ============ A-09 金额 ============ -->
      <view class="pg__sec">
        <text class="pg__h">A-09 金额 Amount（价签母题）</text>
        <text class="pg__p">数字全部等宽，多行金额的小数点成一条竖线（AC-05）。¥ 缩小到 .62em 与基线对齐。</text>
        <view class="pg__row pg__row--baseline">
          <SnAmount :fen="2350" size="lg" />
          <SnAmount :fen="1200" size="md" />
          <SnAmount :fen="1500" size="md" muted />
          <SnAmount :fen="100_00" size="sm" signed />
          <SnAmount :fen="-24" size="sm" signed />
          <SnAmount :fen="0" size="sm" />
        </view>
        <view class="pg__col">
          <SnAmount v-for="f in amountCases" :key="f" :fen="f" size="sm" signed />
        </view>
      </view>

      <SnDivider />

      <!-- ============ A-10 键值行 / 列表行 / 页头 ============ -->
      <view class="pg__sec">
        <text class="pg__h">A-10 键值行 / 列表行 / 页头</text>
        <text class="pg__p">键永远不加重。空值三写法缺一不可，绝不允许留白或显示 null。</text>
        <SnPageHeader title="1 号宿舍楼" :crumbs="['库存管理', '库存矩阵']" />
        <SnKeyValue label="订单号" value="ZS-20260921-0037" value-type="mono" />
        <SnKeyValue label="下单时间" value="今天 21:04" />
        <SnKeyValue label="送到" value="1 号宿舍楼 302 室" />
        <SnKeyValue label="商品小计" :fen="1100" />
        <SnKeyValue label="配送费" :fen="100" fen-muted />
        <SnKeyValue label="实付" :fen="1200" />
        <SnKeyValue label="楼层" :empty-reason="'未填写（按房间号排序）'" />
        <SnKeyValue label="联系电话" :empty-reason="'未留（送到房间）'" />
        <SnKeyValue label="备注" :empty-reason="'无'" />
        <SnKeyValue label="下载对账单" clickable last @click="() => {}" />
        <view class="pg__gap" />
        <SnListRow clickable>
          <template #lead><SnThumb :size="34" /></template>
          <text class="pg__celltitle">3 号宿舍楼 503 室</text>
          <text class="pg__cellsub">2 件商品 · 已送达</text>
          <template #tail><SnAmount :fen="1200" size="md" /></template>
        </SnListRow>
        <SnListRow last>
          <text class="pg__celltitle">不可点击的行（无 chevron）</text>
        </SnListRow>
      </view>

      <SnDivider />

      <!-- ============ A-11 数据表 / 分页 / 批量条 ============ -->
      <view class="pg__sec">
        <text class="pg__h">A-11 数据表 / 分页 / 批量操作条</text>
        <text class="pg__p">数字列右对齐且表头也右对齐；行不可删除时给出原因并把操作置灰。</text>
        <SnTable
          :columns="columns"
          :rows="rows"
          selectable
          :selected-keys="selected"
          :row-note="rowNote"
          :row-locked="rowLocked"
          @select="selected = $event"
        />
        <SnPagination :total="247" v-model:page="page" :page-size="20" />
        <SnBulkBar :count="selected.length" @clear="selected = []">
          <text class="pg__bulkaction">同步上架</text>
          <text class="pg__bulkaction">同步库存数值</text>
          <text class="pg__bulkaction">批量下架</text>
        </SnBulkBar>
      </view>

      <SnDivider />

      <!-- ============ A-12 缩略图 / 头像 ============ -->
      <view class="pg__sec">
        <text class="pg__h">A-12 缩略图 / 头像</text>
        <text class="pg__p">加载中占位尺寸必须与真实图完全一致；加载失败必须有占位，不能留空白。</text>
        <view class="pg__row">
          <SnThumb :size="72" />
          <SnThumb :size="56" />
          <SnThumb :size="34" />
          <SnThumb :size="24" />
        </view>
        <view class="pg__gap" />
        <view class="pg__row">
          <SnAvatar name="张姐零食铺" />
          <SnAvatar name="陈" shape="circle" :size="34" />
          <SnAvatar name="未上传" :size="30" />
        </view>
      </view>

      <SnDivider />

      <!-- ============ A-13 骨架 / 进度条 / 分隔线 ============ -->
      <view class="pg__sec">
        <text class="pg__h">A-13 骨架块 / 进度条 / 分隔线</text>
        <text class="pg__p">骨架形状必须与真实内容一致，否则加载完成时会产生明显跳动。</text>
        <view class="pg__row">
          <SnSkeleton variant="thumb" :size="72" />
          <view class="pg__skel-box">
            <SnSkeleton variant="title" width="60%" />
            <SnSkeleton variant="text" width="100%" />
            <SnSkeleton variant="sub" width="40%" />
          </view>
        </view>
        <view class="pg__gap" />
        <SnProgress :value="14" :max="37" label="推送进度（14 / 37）" trailing="38%" />
        <view class="pg__gap" />
        <SnProgress :value="37" :max="37" tone="ok" label="导入校验完成" trailing="100%" />
        <view class="pg__gap" />
        <SnProgress :value="18" :max="120" label="订阅剩余（18 / 120 天）" trailing="15%" />
        <view class="pg__gap" />
        <SnProgress :value="120" :max="100" label="余额（已透支）" trailing="−¥8.40" trailing-tone="danger" />
        <SnDivider dashed space="md" />
        <text class="pg__p">上面是虚线分隔（小票式，用于金额汇总区）。</text>
      </view>

      <SnDivider />

      <!-- ============ A-14 框架零件 ============ -->
      <view class="pg__sec">
        <text class="pg__h">A-14 安全区 / 吸底栏 / 顶部导航</text>
        <text class="pg__p">
          本页外壳即 SnNavBar + SnPage。顶部导航的**高度与右侧留白都是实测的**
          （`useNavMetrics` 读状态栏高度 + `getMenuButtonBoundingClientRect()`），
          不是写死 100px —— 写死会在状态栏更高的机型上错行。吸底条与 TabBar 互斥。
        </text>

        <text class="pg__p">
          ① 通栏形态（rounded=false）：占位、不遮挡内容 —— 结算页底部、商户端批量操作条。
        </text>
        <view class="pg__demo-frame">
          <SnStickyBar>
            <view class="pg__demo-left">
              <text class="pg__demo-k">合计</text>
              <SnAmount :fen="3140" size="md" />
            </view>
            <SnButton type="pri" size="md">去结算</SnButton>
          </SnStickyBar>
        </view>

        <text class="pg__p">
          ② 胶囊形态（rounded=true）：脱离文档流浮在列表之上，离底 16px、左右各 16px ——
          学生端购物车条。设计明确要求它「不通栏」，否则会遮住最后一行商品的价格。
        </text>
        <SnSwitch
          v-model="showSticky"
          label="显示真实胶囊吸底条"
          description="打开后它固定在屏幕底部，滚动本页即可验证：它浮在内容之上，且不占位、不顶动列表"
        />
      </view>

      <!-- 真实浮起的胶囊吸底条（学生端购物车条） -->
      <SnStickyBar v-if="showSticky" rounded>
        <view class="pg__demo-left">
          <SnBadge count-tone="brand" :count="2" />
          <text class="pg__demo-k">已选 2 件</text>
        </view>
        <SnButton type="pri" size="md">去结算 ¥31.40</SnButton>
      </SnStickyBar>

      <SnDivider />

      <!-- ============ 自检面板 ============ -->
      <view class="pg__sec">
        <text class="pg__h">自检面板 —— {{ passCount() }} / {{ checks.length }} 通过</text>
        <text class="pg__p">把「声称一致」变成当场可证。失败项会在这里显红，不需要人去肉眼比对。</text>
        <view v-for="c in checks" :key="c.name" class="pg__check">
          <SnTag :tone="c.ok ? 'ok' : 'danger'" :label="c.ok ? '通过' : '失败'" />
          <view class="pg__check-body">
            <text class="pg__check-name">{{ c.name }}</text>
            <text class="pg__check-detail">{{ c.detail }}</text>
          </view>
        </view>
      </view>

      <view class="pg__foot" :class="{ 'is-lifted': showSticky }" />
    </view>
  </SnPage>
</template>

<style>
.pg {
  padding-bottom: var(--sp-8);
}
.pg__sec {
  padding: var(--sp-5) 0 var(--sp-2);
}
.pg__h {
  display: block;
  font-size: var(--fs-section);
  font-weight: var(--fw-semibold);
  line-height: var(--lh-section);
  color: var(--ink-900);
}
.pg__p {
  display: block;
  margin-top: var(--sp-1);
  font-size: var(--fs-sub);
  line-height: var(--lh-sub);
  color: var(--ink-500);
}
.pg__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  margin-top: var(--sp-3);
}
.pg__row--baseline {
  align-items: baseline;
}
.pg__row > view {
  margin-right: var(--sp-3);
  margin-bottom: var(--sp-2);
}
.pg__block {
  margin-top: var(--sp-3);
}
.pg__gap {
  height: var(--sp-5);
}
.pg__wrap {
  display: flex;
  flex-wrap: wrap;
  margin-top: var(--sp-3);
}
.pg__wrap > view {
  margin: 0 var(--sp-2) var(--sp-2) 0;
}
.pg__col {
  display: flex;
  flex-direction: column;
  margin-top: var(--sp-2);
}
.pg__col > view {
  margin-bottom: var(--sp-1);
}
.pg__themes {
  display: flex;
  flex-wrap: wrap;
  margin-top: var(--sp-2);
}
.pg__themes > view {
  margin: 0 var(--sp-2) var(--sp-2) 0;
}
.pg__hint {
  display: block;
  font-size: var(--fs-tag);
  color: var(--brand-700);
}
.pg__chips {
  width: 100%;
  white-space: nowrap;
  margin-top: var(--sp-3);
}
.pg__chips-inner {
  display: inline-flex;
}
.pg__chips-inner > view {
  margin-right: var(--sp-2);
}
.pg__kv {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 44px;
  border-bottom: var(--bw) solid var(--line-100);
}
.pg__k {
  font-size: 13.5px;
  color: var(--ink-500);
}
.pg__celltitle {
  font-size: var(--fs-card);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}
.pg__cellsub {
  margin-top: 2px;
  font-size: var(--fs-sub);
  color: var(--ink-500);
}
.pg__bulkaction {
  margin-right: var(--sp-4);
  font-size: var(--fs-sub);
  color: var(--on-brand);
}
.pg__skel-box {
  flex: 1;
  min-width: 180px;
  display: flex;
  flex-direction: column;
}
.pg__check {
  display: flex;
  align-items: flex-start;
  margin-top: var(--sp-3);
}
.pg__check-body {
  flex: 1;
  margin-left: var(--sp-2);
  display: flex;
  flex-direction: column;
}
.pg__check-name {
  font-size: var(--fs-sub);
  color: var(--ink-900);
}
.pg__check-detail {
  margin-top: 2px;
  font-size: var(--fs-tag);
  color: var(--ink-500);
}
.pg__foot {
  height: var(--sp-8);
}
/* 胶囊吸底条浮在页面上时，尾部留出让位，否则它会压住最后一条自检结果 */
.pg__foot.is-lifted {
  height: calc(var(--sp-8) * 3);
}
/* 静态对照：把通栏吸底条放进一个「模拟屏幕」里，避免它自己贴到真屏幕底 */
.pg__demo-frame {
  margin-top: var(--sp-3);
  border: var(--bw) solid var(--line-150);
  border-radius: var(--r-md);
  overflow: hidden;
  background: var(--paper);
}
.pg__demo-left {
  flex: 1;
  display: flex;
  align-items: center;
}
.pg__demo-left > view {
  margin-right: var(--sp-2);
}
.pg__demo-k {
  margin-right: var(--sp-2);
  font-size: var(--fs-sub);
  color: var(--ink-500);
}
</style>
