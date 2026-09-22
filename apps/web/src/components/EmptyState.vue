<script setup lang="ts">
defineProps<{ text: string; hint?: string }>();
</script>

<template>
  <div class="empty">
    <p class="empty__text">{{ text }}</p>
    <p v-if="hint" class="empty__hint">{{ hint }}</p>
    <div v-if="$slots.default" class="empty__slot"><slot /></div>
  </div>
</template>

<style scoped>
.empty {
  padding: var(--sp-8) var(--sp-4);
  text-align: center;
  color: var(--ink-500);
}
.empty__text {
  margin: 0;
  font-size: var(--fs-body);
  color: var(--ink-700);
}
.empty__hint {
  margin: var(--sp-1) 0 0;
  font-size: var(--fs-sub);
  line-height: var(--lh-sub);
  color: var(--ink-500);
}
.empty__slot {
  margin-top: var(--sp-3);
}
</style>
