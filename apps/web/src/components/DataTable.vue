<script setup lang="ts">
/** 通用表格。列定义只管"宽度 / 是否数字"，单元格内容一律走插槽 —— 表格不该替页面决定怎么渲染状态 */
export interface Column {
  key: string;
  title: string;
  width?: string;
  num?: boolean;
}

defineProps<{ columns: Column[]; rows: Array<Record<string, unknown>>; rowKey?: string }>();
</script>

<template>
  <div class="tbl-wrap">
    <table class="tbl">
      <thead>
        <tr>
          <th v-for="c in columns" :key="c.key" :class="{ num: c.num }" :style="c.width ? { width: c.width } : undefined">
            {{ c.title }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(r, i) in rows" :key="rowKey ? String(r[rowKey]) : i">
          <td v-for="c in columns" :key="c.key" :class="{ num: c.num }">
            <slot :name="`cell-${c.key}`" :row="r" :value="r[c.key]">{{ r[c.key] }}</slot>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
