<script setup lang="ts">
defineProps<{ title?: string; desc?: string; flush?: boolean }>();
</script>

<template>
  <section class="panel" :class="{ 'panel--flush': flush }">
    <header v-if="title || $slots.actions" class="panel__head">
      <div>
        <h2 v-if="title" class="panel__title">{{ title }}</h2>
        <p v-if="desc" class="panel__desc">{{ desc }}</p>
      </div>
      <div v-if="$slots.actions" class="panel__actions"><slot name="actions" /></div>
    </header>
    <div class="panel__body"><slot /></div>
  </section>
</template>

<style scoped>
.panel {
  background: var(--surface);
  border: var(--bd);
  border-radius: var(--r-lg);
  box-shadow: var(--s1);
  overflow: hidden;
}
.panel__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-4);
  padding: var(--sp-4);
  border-bottom: var(--bd);
}
.panel__title {
  margin: 0;
  font-size: var(--fs-section);
  line-height: var(--lh-section);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}
.panel__desc {
  margin: var(--sp-1) 0 0;
  font-size: var(--fs-sub);
  line-height: var(--lh-sub);
  color: var(--ink-500);
}
.panel__actions {
  display: flex;
  gap: var(--sp-2);
  flex-shrink: 0;
}
.panel__body {
  padding: var(--sp-4);
}
.panel--flush .panel__body {
  padding: 0;
}
</style>
