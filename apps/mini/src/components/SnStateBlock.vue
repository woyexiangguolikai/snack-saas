<script setup lang="ts">
import SnButton from './SnButton.vue';

/**
 * A-16 状态块 StateBlock（原子 · 空态 / 错误态 / 业务状态页的统一模板）
 *
 * 这张模板存在的唯一理由是 **AC-02**：
 *   截单 / 停送 / 休息 / 未覆盖这四种状态**必须长得一样**，差别只在图标与文案。
 *   如果让每个页面自己画，就会出现"截单用红色感叹号、停送用黄色警告"——
 *   而这两种情况都只是"今天不行"，不是"出事了"。红色会让学生以为店铺倒闭了。
 *
 * 所以这里把 tone 的默认值定为 `off`（灰），并且**不提供 danger 的默认样式**：
 *   想用红色必须显式传 tone="danger"，而"截单/停送/休息/未覆盖"四个场景一律 off。
 *   把正确的做法设成默认值，比写在注释里管用。
 */
withDefaults(
  defineProps<{
    /** off：不可用但不危险（默认，覆盖四种"今天不行"）；danger：真的出错了 */
    tone?: 'off' | 'warn' | 'danger' | 'brand' | 'ok';
    /** 圆图标内的字形（本项目不引入图标字体，用字形 + 语义色表达） */
    glyph?: string;
    title: string;
    /** 原因说明：必须回答"为什么"，不能只说过不去 */
    desc?: string;
    /** 恢复时间等附加说明 —— 会渲染在虚线分隔下方 */
    nextText?: string;
    /** 主按钮文案；不传则不渲染 */
    primaryText?: string;
    secondaryText?: string;
    /** 底部小字（如 AppID 缩写，用于排查"扫错了小程序"） */
    footText?: string;
  }>(),
  {
    tone: 'off',
    glyph: '—',
    desc: '',
    nextText: '',
    primaryText: '',
    secondaryText: '',
    footText: '',
  },
);

const emit = defineEmits<{ (e: 'primary'): void; (e: 'secondary'): void }>();
</script>

<template>
  <view class="sn-state">
    <view class="sn-state__icon" :class="`is-${tone}`">
      <text class="sn-state__glyph">{{ glyph }}</text>
    </view>

    <text class="sn-state__title">{{ title }}</text>
    <text v-if="desc" class="sn-state__desc">{{ desc }}</text>

    <view v-if="nextText" class="sn-state__next">
      <view class="sn-state__dash" />
      <text class="sn-state__nexttext">{{ nextText }}</text>
    </view>

    <slot />

    <view v-if="primaryText || secondaryText" class="sn-state__acts">
      <SnButton v-if="primaryText" type="pri" block @click="emit('primary')">{{ primaryText }}</SnButton>
      <SnButton v-if="secondaryText" type="tex" block @click="emit('secondary')">{{ secondaryText }}</SnButton>
    </view>

    <text v-if="footText" class="sn-state__foot num">{{ footText }}</text>
  </view>
</template>

<style>
.sn-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: var(--sp-8) var(--sp-6);
}
.sn-state__icon {
  width: 58px;
  height: 58px;
  border-radius: var(--r-full);
  display: flex;
  align-items: center;
  justify-content: center;
}
.sn-state__icon.is-off {
  background: var(--off-bg);
}
.sn-state__icon.is-warn {
  background: var(--warn-bg);
}
.sn-state__icon.is-danger {
  background: var(--danger-bg);
}
.sn-state__icon.is-brand {
  background: var(--brand-50);
}
.sn-state__icon.is-ok {
  background: var(--ok-bg);
}
.sn-state__glyph {
  font-size: 24px;
  line-height: 26px;
}
.sn-state__icon.is-off .sn-state__glyph {
  color: var(--off);
}
.sn-state__icon.is-warn .sn-state__glyph {
  color: var(--warn);
}
.sn-state__icon.is-danger .sn-state__glyph {
  color: var(--danger);
}
.sn-state__icon.is-brand .sn-state__glyph {
  color: var(--brand-700);
}
.sn-state__icon.is-ok .sn-state__glyph {
  color: var(--ok);
}
.sn-state__title {
  margin-top: var(--sp-5);
  font-size: var(--fs-section);
  font-weight: var(--fw-semibold);
  line-height: var(--lh-section);
  color: var(--ink-900);
  text-align: center;
}
.sn-state__desc {
  margin-top: var(--sp-2);
  font-size: var(--fs-body);
  line-height: var(--lh-body);
  color: var(--ink-500);
  text-align: center;
}
.sn-state__next {
  width: 100%;
  margin-top: var(--sp-4);
  display: flex;
  flex-direction: column;
  align-items: center;
}
.sn-state__dash {
  width: 100%;
  height: 0;
  border-top: var(--bw) dashed var(--line-200);
  margin-bottom: var(--sp-3);
}
.sn-state__nexttext {
  font-size: var(--fs-sub);
  color: var(--ink-500);
  line-height: var(--lh-sub);
  text-align: center;
}
.sn-state__acts {
  width: 100%;
  margin-top: var(--sp-6);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.sn-state__foot {
  margin-top: var(--sp-5);
  font-size: var(--fs-tag);
  color: var(--ink-300);
}
</style>
