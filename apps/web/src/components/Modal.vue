<script setup lang="ts">
defineProps<{ open: boolean; title: string; width?: number }>();
const emit = defineEmits<{ (e: 'close'): void }>();
</script>

<template>
  <div v-if="open" class="mask" @click.self="emit('close')">
    <div class="dlg" :style="width ? { width: `${width}px` } : undefined" role="dialog">
      <header class="dlg__head">
        <h3 class="dlg__title">{{ title }}</h3>
        <button class="dlg__x" type="button" aria-label="关闭" @click="emit('close')">×</button>
      </header>
      <div class="dlg__body"><slot /></div>
      <footer v-if="$slots.footer" class="dlg__foot"><slot name="footer" /></footer>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: var(--z-mask);
  background: var(--mask);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: var(--sp-8) var(--sp-4);
  overflow: auto;
}
.dlg {
  width: 560px;
  max-width: 100%;
  background: var(--surface);
  border-radius: var(--r-lg);
  box-shadow: var(--s2);
}
.dlg__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-4);
  border-bottom: var(--bd);
}
.dlg__title {
  margin: 0;
  font-size: var(--fs-section);
  line-height: var(--lh-section);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}
.dlg__x {
  border: 0;
  background: transparent;
  font-size: 22px;
  line-height: 1;
  color: var(--ink-500);
  padding: 0 var(--sp-1);
}
.dlg__body {
  padding: var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  max-height: 62vh;
  overflow: auto;
}
.dlg__foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
  padding: var(--sp-4);
  border-top: var(--bd);
}
</style>
