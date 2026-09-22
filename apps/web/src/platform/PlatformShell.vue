<script setup lang="ts">
/**
 * 平台后台外壳。
 *
 * 与商户端的 MerchantShell（App.vue 内联那套）**刻意长得不像**：
 * 侧边栏选中态是墨色不是品牌色，标题是"平台后台"不是店铺名。
 * 这是 AC-12 在视觉上的落点 —— 一个人应该能一眼看出
 * "我现在在平台后台，不是在某个商户的后台"，而不是从 URL 去分辨。
 */
import { useRoute, useRouter } from 'vue-router';
import { PLATFORM_NAV } from '@/router';
import { platformSession, platformLogout } from '@/stores/platform';
import { toasts, dismiss } from '@/utils/feedback';
import NetBanner from '@/components/NetBanner.vue';

const route = useRoute();
const router = useRouter();

const groups = (() => {
  const map = new Map<string, typeof PLATFORM_NAV>();
  for (const item of PLATFORM_NAV) {
    const list = map.get(item.group) ?? [];
    list.push(item);
    map.set(item.group, list);
  }
  return [...map.entries()];
})();

function exit(): void {
  platformLogout();
  void router.push({ name: 'platform-login' });
}

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
  <div class="p-shell">
    <aside class="p-side">
      <div class="p-side__brand">
        <span class="p-side__mark">台</span>
        <span>
          <span class="p-side__name">平台后台</span>
          <span class="p-side__sub">{{ platformSession.operator || '未署名' }}</span>
        </span>
      </div>

      <nav class="p-side__nav">
        <div v-for="[group, items] in groups" :key="group" class="p-side__group">
          <p class="p-side__gtitle">{{ group }}</p>
          <RouterLink
            v-for="it in items"
            :key="it.to"
            class="p-side__link"
            active-class="p-side__link--on"
            :to="it.to"
          >
            <span>{{ it.label }}</span>
            <span class="p-side__code">{{ it.code }}</span>
          </RouterLink>
        </div>
      </nav>

      <div class="p-side__foot">
        <RouterLink class="p-side__link" to="/" title="回到商户后台">
          <span>商户后台</span>
        </RouterLink>
        <button class="btn btn--sm" type="button" @click="exit()">退出</button>
      </div>
    </aside>

    <main class="p-main">
      <!-- 网络横幅在内容区最上方：任何页面都可见，且不遮挡任何操作（§5.2） -->
      <NetBanner />
      <slot />
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
