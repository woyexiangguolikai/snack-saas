<script setup lang="ts">
defineProps<{ title: string; desc?: string; code?: string }>();
</script>

<template>
  <header class="ph">
    <div class="ph__main">
      <h1 class="ph__title">
        {{ title }}
        <span v-if="code" class="ph__code">{{ code }}</span>
      </h1>
      <p v-if="desc" class="ph__desc">{{ desc }}</p>
    </div>
    <div class="ph__actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped>
.ph {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-4);
  margin-bottom: var(--sp-5);
}
.ph__title {
  margin: 0;
  font-size: var(--fs-title);
  line-height: var(--lh-title);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
}
.ph__code {
  font-size: var(--fs-tag);
  font-weight: var(--fw-medium);
  color: var(--ink-400);
  padding: 2px var(--sp-2);
  border: var(--bd);
  border-radius: var(--r-full);
}
.ph__desc {
  margin: var(--sp-1) 0 0;
  font-size: var(--fs-sub);
  line-height: var(--lh-sub);
  color: var(--ink-500);
  max-width: 68ch;
}
.ph__actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-shrink: 0;
}
</style>
