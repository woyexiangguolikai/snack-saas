<script setup lang="ts">
import { computed } from 'vue';

/**
 * A-04 数字步进器（原子）
 * 加购与改库存共用同一组件，但语义完全不同：
 *   variant="cart"  加购「我要买几个」—— min 1；减到 1 再减 = 移出购物车（emit remove，由外部弹撤销条）
 *   variant="stock" 改库存「我这儿还有几个」—— min 0；减到 0 = 自动置售罄（emit zero，轻提示而非确认框）
 * 关键约束：两者都不弹确认框（都可逆）；达到上限时 + 禁用并给出剩余量说明，绝不静默不响应。
 */

const props = withDefaults(
  defineProps<{
    modelValue: number;
    variant?: 'cart' | 'stock';
    /** 上限：本楼栋库存 */
    max?: number;
    /** 提交中：防连点 */
    loading?: boolean;
    disabled?: boolean;
    /** 达到上限时右侧的说明文案，如「本栋仅剩 24 件」 */
    limitHint?: string;
  }>(),
  {
    variant: 'cart',
    max: Number.MAX_SAFE_INTEGER,
    loading: false,
    disabled: false,
    limitHint: '',
  },
);

const emit = defineEmits<{
  (e: 'update:modelValue', v: number): void;
  /** 加购场景：减到 1 再减 → 移出购物车 */
  (e: 'remove'): void;
  /** 库存场景：减到 0 → 已置为售罄 */
  (e: 'zero'): void;
  /** 触达上限被拒 */
  (e: 'overflow'): void;
  (e: 'change', v: number): void;
}>();

const locked = computed(() => props.disabled || props.loading);
const min = computed(() => (props.variant === 'cart' ? 1 : 0));

/** 加购场景下 0 表示「未加购」，只显示 + */
const collapsed = computed(() => props.variant === 'cart' && props.modelValue <= 0);

const canInc = computed(() => !locked.value && props.modelValue < props.max);
const canDec = computed(() => !locked.value && props.modelValue > min.value);

function commit(v: number) {
  emit('update:modelValue', v);
  emit('change', v);
}

function onInc() {
  if (locked.value) return;
  if (!canInc.value) {
    emit('overflow');
    return;
  }
  commit(props.modelValue + 1);
}

function onDec() {
  if (locked.value) return;
  const v = props.modelValue;

  // 加购：减到 1 再减 → 语义变为「移出购物车」
  if (props.variant === 'cart' && v <= 1) {
    emit('remove');
    return;
  }
  // 库存：减到 0 → 自动置售罄（可逆，走轻提示）
  if (props.variant === 'stock' && v === 0) {
    emit('zero');
    return;
  }
  commit(v - 1);
}
</script>

<template>
  <view class="sn-stepper" :class="{ 'is-locked': locked }">
    <view v-if="!collapsed" class="sn-stepper__ctrl">
      <view
        class="sn-stepper__btn sn-stepper__btn--dec"
        :class="{ 'is-off': !canDec }"
        aria-label="减少"
        @click="onDec"
      >
        <text class="sn-stepper__glyph">−</text>
      </view>

      <view class="sn-stepper__value num">
        <text v-if="loading">…</text>
        <text v-else>{{ modelValue }}</text>
      </view>

      <view
        class="sn-stepper__btn sn-stepper__btn--inc"
        :class="{ 'is-off': !canInc }"
        aria-label="增加"
        @click="onInc"
      >
        <text class="sn-stepper__glyph">+</text>
      </view>
    </view>

    <!-- 未加购：只有一个实心加号 -->
    <view v-else class="sn-stepper__btn sn-stepper__btn--inc sn-stepper__btn--solo" aria-label="加入购物车" @click="onInc">
      <text class="sn-stepper__glyph">+</text>
    </view>

    <text v-if="limitHint" class="sn-stepper__hint">{{ limitHint }}</text>
  </view>
</template>

<style>
.sn-stepper {
  display: flex;
  align-items: center;
}
.sn-stepper__ctrl {
  display: flex;
  align-items: center;
}

.sn-stepper__btn {
  width: 26px;
  height: 26px;
  border-radius: var(--r-full);
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1.4px solid var(--brand-500);
}
/* 加号为实心填充（强调「可以加」），减号为描边 */
.sn-stepper__btn--inc {
  background: var(--brand-500);
  color: var(--on-brand);
}
.sn-stepper__btn--dec {
  background: transparent;
  color: var(--brand-500);
}
.sn-stepper__btn--solo {
  width: 30px;
  height: 30px;
}
.sn-stepper__btn.is-off {
  border-color: var(--brand-300);
  background: transparent;
  color: var(--brand-300);
}
.sn-stepper__glyph {
  font-size: 16px;
  line-height: 16px;
  font-weight: var(--fw-semibold);
}

/* 数量必须等宽：9 → 10 不得引起布局位移（AC-07） */
.sn-stepper__value {
  min-width: 30px;
  text-align: center;
  font-size: var(--fs-body);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}

.sn-stepper__hint {
  margin-left: var(--sp-2);
  font-size: var(--fs-tag);
  color: var(--warn);
}
.sn-stepper.is-locked {
  opacity: 0.6;
}
</style>
