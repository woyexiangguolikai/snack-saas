<script setup lang="ts">
import SnTag from './SnTag.vue';

/**
 * A-11 数据表 DataTable（原子 · 网页端专用）
 * 商户网页与平台后台的骨架。列宽/对齐/空值规则必须全站一致，否则横向对比失效。
 * 硬约束（写进组件）：
 *   · 表头 11.5/500/ink-500，永不加重、不用 ink-900
 *   · 数字列 --mono + 右对齐，表头也必须右对齐（AC-05）
 *   · 一列只放一个 Tag；操作列只放纯文字动作，禁止实心按钮
 *   · 行不可删除时：商品名下方 11px 说明 + 操作置灰（rowNote）
 */
type Row = Record<string, unknown>;

const props = withDefaults(
  defineProps<{
    columns: Array<{
      key: string;
      title: string;
      /** text | num | tag | actions */
      type?: 'text' | 'num' | 'tag' | 'actions';
      width?: string;
      align?: 'left' | 'right';
      /** tag 列的语义色取值函数结果键 */
      tagToneKey?: string;
    }>;
    rows: Row[];
    /** 勾选列 */
    selectable?: boolean;
    selectedKeys?: Array<string | number>;
    /** 首列下方 11px 说明（如「已被 12 笔订单引用，不可删除」） */
    rowNote?: (row: Row) => string;
    /** 行是否不可操作（操作置灰） */
    rowLocked?: (row: Row) => boolean;
    rowKey?: string;
  }>(),
  {
    selectable: false,
    selectedKeys: () => [],
    rowNote: undefined,
    rowLocked: undefined,
    rowKey: 'id',
  },
);

const emit = defineEmits<{
  (e: 'select', keys: Array<string | number>): void;
  (e: 'action', payload: { action: string; row: Row }): void;
}>();

function keyOf(row: Row): string | number {
  return row[props.rowKey] as string | number;
}

function isSelected(row: Row) {
  return props.selectedKeys.includes(keyOf(row));
}

function toggle(row: Row) {
  const k = keyOf(row);
  const next = isSelected(row)
    ? props.selectedKeys.filter((x) => x !== k)
    : [...props.selectedKeys, k];
  emit('select', next);
}

function toggleAll() {
  const all = props.rows.map(keyOf);
  emit('select', props.selectedKeys.length === all.length ? [] : all);
}

function cellText(row: Row, col: { key: string; type?: string }): string {
  const v = row[col.key];
  if (v === null || v === undefined || v === '') return '—';
  return String(v);
}

/** tag 列的语义色：优先取 tagToneKey，其次取 `${key}Tone`，兜底 off */
type TagTone = 'ok' | 'warn' | 'danger' | 'info' | 'off' | 'brand';
const TAG_TONES = ['ok', 'warn', 'danger', 'info', 'off', 'brand'] as const;

function toneOf(row: Row, col: { key: string; tagToneKey?: string }): TagTone {
  const raw = row[col.tagToneKey || `${col.key}Tone`];
  return typeof raw === 'string' && (TAG_TONES as readonly string[]).includes(raw)
    ? (raw as TagTone)
    : 'off';
}

function isLocked(row: Row): boolean {
  return props.rowLocked ? props.rowLocked(row) : false;
}
</script>

<template>
  <view class="sn-table">
    <!-- 表格是网页端专用件（设计基准 ≥1024px）。窄屏时横向滚动，
         绝不允许把列压成「每格两个字」——那样列头与数据都失去可比性，等于表格失效。 -->
    <view class="sn-table__scroll">
      <view class="sn-table__inner">
        <view class="sn-table__head">
          <view v-if="selectable" class="sn-table__cell sn-table__cell--check">
            <view
              class="sn-table__check"
              :class="{
                'is-on': selectedKeys.length > 0,
                'is-half': selectedKeys.length > 0 && selectedKeys.length < rows.length,
              }"
              aria-label="全选"
              role="checkbox"
              @click="toggleAll"
            >
              <text v-if="selectedKeys.length === rows.length && rows.length > 0" class="sn-table__tick">✓</text>
              <view v-else-if="selectedKeys.length > 0" class="sn-table__dash" />
            </view>
          </view>
          <view
            v-for="(col, ci) in columns"
            :key="col.key"
            class="sn-table__cell"
            :class="[
              col.type === 'num' ? 'sn-table__cell--num' : '',
              col.type === 'actions' ? 'sn-table__cell--actions' : '',
              ci === 0 ? 'sn-table__cell--first' : '',
            ]"
            :style="col.width ? `width:${col.width}` : ''"
          >
            <text class="sn-table__th">{{ col.title }}</text>
          </view>
        </view>

        <view
          v-for="(row, ri) in rows"
          :key="String(keyOf(row))"
          class="sn-table__row"
          :class="{ 'is-last': ri === rows.length - 1 }"
        >
          <view v-if="selectable" class="sn-table__cell sn-table__cell--check">
            <view
              class="sn-table__check"
              :class="{ 'is-on': isSelected(row) }"
              :aria-label="'选择第 ' + (ri + 1) + ' 行'"
              role="checkbox"
              @click="toggle(row)"
            >
              <text v-if="isSelected(row)" class="sn-table__tick">✓</text>
            </view>
          </view>

          <view
            v-for="(col, ci) in columns"
            :key="col.key"
            class="sn-table__cell"
            :class="[
              col.type === 'num' ? 'sn-table__cell--num' : '',
              col.type === 'actions' ? 'sn-table__cell--actions' : '',
              ci === 0 ? 'sn-table__cell--first' : '',
            ]"
            :style="col.width ? `width:${col.width}` : ''"
          >
            <SnTag v-if="col.type === 'tag'" :tone="toneOf(row, col)" :label="cellText(row, col)" />
            <view v-else-if="col.type === 'actions'" class="sn-table__actions" :class="{ 'is-locked': isLocked(row) }">
              <slot name="actions" :row="row">
                <text class="sn-table__action" @click="emit('action', { action: 'edit', row })">编辑</text>
                <text
                  class="sn-table__action"
                  :class="{ 'is-off': isLocked(row) }"
                  @click="isLocked(row) ? null : emit('action', { action: 'remove', row })"
                >
                  下架
                </text>
              </slot>
            </view>
            <view v-else class="sn-table__valwrap">
              <text class="sn-table__td" :class="{ num: col.type === 'num' }">{{ cellText(row, col) }}</text>
              <text v-if="rowNote && rowNote(row) && ci === 0" class="sn-table__note">
                {{ rowNote(row) }}
              </text>
            </view>
          </view>
        </view>
      </view>
    </view>
  </view>
</template>

<style>
/* 表格只在网页端使用。容器横向可滚 —— 窄屏宁可滚动，也不把列压成两字一格 */
.sn-table {
  width: 100%;
  background: var(--surface);
  border: var(--bw) solid var(--line-200);
  border-radius: var(--r-md);
  overflow: hidden;
}
.sn-table__scroll {
  width: 100%;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
/* 横向最小宽度：7 列（含勾选与操作）在不低于此宽度时才有可比性 */
.sn-table__inner {
  min-width: 780px;
}

.sn-table__head,
.sn-table__row {
  display: flex;
  align-items: center;
}
.sn-table__head {
  background: var(--paper);
  border-bottom: var(--bw) solid var(--line-200);
}
.sn-table__row {
  border-bottom: var(--bw) solid var(--line-100);
  transition: background-color var(--d-color) var(--e-std);
}
.sn-table__row.is-last {
  border-bottom: none;
}
.sn-table__row:active {
  background: var(--brand-50);
}

.sn-table__head .sn-table__cell {
  padding: 9px 12px;
}
.sn-table__row .sn-table__cell {
  padding: 10px 12px;
}
.sn-table__cell {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
}
.sn-table__cell--check {
  flex: none;
  width: 44px;
}
.sn-table__cell--num {
  justify-content: flex-end;
}
.sn-table__cell--actions {
  flex: none;
  width: 132px;
  justify-content: flex-end;
}

/* 表头永不加重，避免与数据行抢注意力 */
.sn-table__th {
  font-size: 11.5px;
  font-weight: var(--fw-medium);
  color: var(--ink-500);
}
.sn-table__cell--num .sn-table__th {
  text-align: right;
}

.sn-table__valwrap {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.sn-table__td {
  font-size: var(--fs-sub);
  color: var(--ink-900);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.sn-table__note {
  margin-top: 2px;
  font-size: 11px;
  color: var(--ink-400);
}

.sn-table__check {
  width: 19px;
  height: 19px;
  border: 1.4px solid var(--ink-300);
  border-radius: 5px;
  background: var(--surface);
  display: flex;
  align-items: center;
  justify-content: center;
}
.sn-table__check.is-on,
.sn-table__check.is-half {
  background: var(--brand-500);
  border-color: var(--brand-500);
}
.sn-table__tick {
  color: var(--on-brand);
  font-size: 12px;
  line-height: 12px;
}
.sn-table__dash {
  width: 9px;
  height: 2px;
  background: var(--on-brand);
}

.sn-table__actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
}
.sn-table__action {
  font-size: 12px;
  color: var(--brand-700);
  padding: 4px 6px;
}
/* 行不可操作：操作置灰，并已在首列给出原因 */
.sn-table__action.is-off,
.sn-table__actions.is-locked .sn-table__action {
  color: var(--ink-300);
}
</style>
