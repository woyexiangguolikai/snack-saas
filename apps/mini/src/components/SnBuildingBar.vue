<script setup lang="ts">
import SnSkeleton from './SnSkeleton.vue';
/**
 * B-01 楼栋牌（签名组件 · AC-01）
 *
 * 为什么必须有这一个组件：
 *   它在本产品出现 5 个位置（首页 / 分类 / 结算 / 地址编辑 / 购物车），
 *   是唯一的「签名组件」—— 学生靠它建立"看到这块牌子就知道我在给哪栋看"的条件反射。
 *   一旦各页各画一版，这个反射就断了（历史上确实断过：结算页被做成 32px 小胶囊、
 *   地址页被做成 46px，两处高度都不一样）。
 *
 * 形态被写死，不留 prop 去改：
 *   高 44px（--building-chip-h）、圆角 10px（--building-chip-r = --r-md）、
 *   brand-500 实心底、白字、**无阴影、无描边、无渐变**。
 *   故意不暴露 size / variant / color —— 能改就不叫签名组件了（AC-01 禁止改造）。
 *
 * 可变的只有「内容」与「能不能点」，不是「长什么样」：
 *   · name 为空 → 显示 placeholder（"请先选择宿舍楼"之类），底色不变
 *     （楼栋牌是常驻的上下文条，不能因为没选就消失 —— 消失了学生就不知道去哪儿选）
 *   · pickable=false → 结算页那种"这里不能改"的场景，去掉箭头与点击态
 */
const props = withDefaults(
  defineProps<{
    /** 当前楼栋名；空串表示还没选 */
    name?: string;
    /** 未选楼栋时显示的引导文案 */
    placeholder?: string;
    /** 是否可点。false = 只展示（结算页：这栋在这一页不能改） */
    pickable?: boolean;
    /** 是否显示下拉箭头 —— 只有"点了真能换楼栋"时才显示。
     *  单楼栋模式下点了没得换，就不该给箭头，否则是"看着能换其实不能换"。 */
    chevron?: boolean;
    /**
     * 解析期占位：只把文字换成骨架块，高与圆角**不变**（AC-19 同构，数据到达不跳动）。
     *
     * 这个 prop 存在的理由就是 AC-01：以前各页在 booting 时自己画一个
     * `.xxx__bchip` 占位容器，结果又是一份独立的楼栋牌实现 ——
     * 只要能画，迟早会画歪。占位也归组件管，外面就只剩"用不用"这一个选择了。
     */
    loading?: boolean;
  }>(),
  { name: '', placeholder: '请先选择宿舍楼', pickable: true, chevron: true, loading: false },
);

const emit = defineEmits<{ (e: 'pick'): void }>();

function onClick(): void {
  if (!props.pickable) return;
  emit('pick');
}
</script>

<template>
  <view
    class="sn-bbar"
    :class="{ 'is-static': !pickable, 'is-empty': !name }"
    :role="pickable ? 'button' : 'text'"
    :aria-label="name ? `当前楼栋 ${name}` : placeholder"
    @click="onClick"
  >
    <SnSkeleton v-if="loading" variant="title" width="96px" />
    <text v-else class="sn-bbar__name">{{ name || placeholder }}</text>
    <text v-if="chevron && !loading" class="sn-bbar__chev" aria-hidden="true">⌄</text>
  </view>
</template>

<style>
/* AC-01：高 44、圆角 r-md、brand-500 实心、白字、无阴影无描边。
   四条全部走 Token，任何一条被写死都会在 check-token-refs / check-ac-01 里报错。 */
.sn-bbar {
  flex: none;
  height: var(--building-chip-h);
  padding: 0 var(--sp-4);
  border-radius: var(--building-chip-r);
  background: var(--building-chip-bg);
  color: var(--building-chip-fg);
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: var(--sp-1);
  /* 显式声明"无阴影无描边"，防止后续有人从别的卡片复制样式时带进来 */
  box-shadow: none;
  border: 0 none;
}
.sn-bbar__name {
  font-size: var(--fs-card);
  font-weight: var(--fw-semibold);
  color: var(--building-chip-fg);
}
.sn-bbar__chev {
  margin-top: -6px;
  font-size: var(--fs-card);
  color: var(--building-chip-fg);
}
/* 不可切换（结算页）：形态完全相同，只是没有箭头、没有按压反馈 ——
   不是"换个样式表示只读"，换样式就破坏了签名性 */
.sn-bbar.is-static {
  padding: 0 var(--sp-3);
}
/* 还没选楼栋：底色保持不变（它依然是那块牌子），文案换成引导 */
.sn-bbar.is-empty {
  opacity: 1;
}
.sn-bbar.is-empty .sn-bbar__name {
  font-weight: var(--fw-medium);
}
/* 按压反馈用 opacity —— 与 SnButton 一致（0.9）。
   不能用"变浅底色"或"缩小"：那等于按下时换了另一个形态，同样破坏签名性。 */
.sn-bbar:active {
  opacity: 0.9;
}
.sn-bbar.is-static:active {
  opacity: 1;
}
</style>
