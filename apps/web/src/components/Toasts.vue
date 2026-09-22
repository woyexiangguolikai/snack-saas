<script setup lang="ts">
import { toasts, dismiss } from '@/utils/feedback';

const BG: Record<string, string> = {
  ok: 'var(--ok-bg)',
  warn: 'var(--warn-bg)',
  danger: 'var(--danger-bg)',
  off: 'var(--off-bg)',
  info: 'var(--info-bg)',
};
const FG: Record<string, string> = {
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  danger: 'var(--danger)',
  off: 'var(--ink-700)',
  info: 'var(--info)',
};
</script>

<template>
  <div class="toasts">
    <div
      v-for="t in toasts"
      :key="t.id"
      class="toast"
      :style="{ background: BG[t.tone], color: FG[t.tone] }"
      @click="dismiss(t.id)"
    >
      {{ t.text }}
    </div>
  </div>
</template>

<style scoped>
.toasts {
  position: fixed;
  right: var(--sp-4);
  bottom: var(--sp-4);
  z-index: var(--z-toast);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.toast {
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--r-md);
  box-shadow: var(--s2);
  font-size: var(--fs-body);
  cursor: pointer;
  max-width: 420px;
}
</style>
