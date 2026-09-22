<script setup lang="ts">
import { computed } from 'vue';
import { RouterView, useRoute } from 'vue-router';
import { NAV } from '@/router';
import { session, logout } from '@/stores/session';
import { toasts, dismiss } from '@/utils/feedback';
import PlatformShell from '@/platform/PlatformShell.vue';
import NetBanner from '@/components/NetBanner.vue';

const route = useRoute();
const isLogin = computed(() => route.name === 'login');
/** 平台区走自己的外壳（含侧边栏）—— 两个后台的导航结构完全不同，硬塞进一套只会互相将就 */
const isPlatform = computed(() => route.meta.platform === true);
const isPlatformLogin = computed(() => route.name === 'platform-login');

/** 侧边栏按 group 分组展示 —— 十一个页面平铺会让人每次都要从头扫一遍 */
const groups = computed(() => {
  const map = new Map<string, typeof NAV>();
  for (const item of NAV) {
    const list = map.get(item.group) ?? [];
    list.push(item);
    map.set(item.group, list);
  }
  return [...map.entries()];
});

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
  off: 'var(--off)',
  info: 'var(--info)',
};
</script>

<template>
  <div v-if="isPlatformLogin" class="bare"><RouterView /></div>

  <PlatformShell v-else-if="isPlatform"><RouterView /></PlatformShell>

  <div v-else-if="isLogin" class="bare"><RouterView /></div>

  <div v-else class="shell">
    <aside class="side">
      <div class="side__brand">
        <span class="side__name">{{ session.shopName || '店铺后台' }}</span>
        <span class="side__tenant num">{{ session.tenantCode }}</span>
      </div>

      <nav class="side__nav">
        <div v-for="[group, items] in groups" :key="group" class="side__group">
          <p class="side__gtitle">{{ group }}</p>
          <RouterLink
            v-for="it in items"
            :key="it.to"
            class="side__link"
            active-class="side__link--on"
            :to="it.to"
          >
            <span>{{ it.label }}</span>
            <span class="side__code">{{ it.code }}</span>
          </RouterLink>
        </div>
      </nav>

      <div class="side__foot">
        <span class="sub muted">{{ session.operator }}</span>
        <button class="btn btn--sm" type="button" @click="logout()">退出</button>
      </div>
    </aside>

    <main class="main">
      <!-- 网络横幅在内容区最上方：与平台后台同一条纪律（§5.2） -->
      <NetBanner />
      <RouterView />
    </main>

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
  </div>
</template>

<style scoped>
.bare {
  min-height: 100%;
}

.shell {
  display: flex;
  min-height: 100%;
}

/* ---------------------------------------------------------------- 侧边栏 */
.side {
  width: 216px;
  flex-shrink: 0;
  background: var(--surface);
  border-right: var(--bd);
  display: flex;
  flex-direction: column;
  position: sticky;
  top: 0;
  height: 100vh;
}
.side__brand {
  padding: var(--sp-4);
  border-bottom: var(--bd);
}
.side__name {
  display: block;
  font-size: var(--fs-card);
  line-height: var(--lh-card);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}
.side__tenant {
  display: block;
  margin-top: 2px;
  font-size: var(--fs-tag);
  color: var(--ink-400);
}
.side__nav {
  flex: 1;
  overflow: auto;
  padding: var(--sp-3) var(--sp-2);
}
.side__group + .side__group {
  margin-top: var(--sp-4);
}
.side__gtitle {
  margin: 0 0 var(--sp-1);
  padding: 0 var(--sp-2);
  font-size: var(--fs-tag);
  color: var(--ink-400);
}
.side__link {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
  color: var(--ink-700);
  font-size: var(--fs-body);
  transition: background var(--d-color) var(--e-std), color var(--d-color) var(--e-std);
}
.side__link:hover {
  background: var(--line-100);
}
.side__link--on {
  background: var(--brand-50);
  color: var(--brand-700);
  font-weight: var(--fw-medium);
}
.side__code {
  font-size: var(--fs-tag);
  color: var(--ink-400);
}
.side__link--on .side__code {
  color: var(--brand-700);
}
.side__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4);
  border-top: var(--bd);
}

/* ------------------------------------------------------------------ 主区 */
.main {
  flex: 1;
  min-width: 0;
  padding: var(--sp-6);
  max-width: 1440px;
}

/* ------------------------------------------------------------------ 提示 */
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
