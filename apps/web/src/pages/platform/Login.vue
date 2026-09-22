<script setup lang="ts">
/**
 * 平台后台登录页。
 *
 * 过渡实现：填平台密钥（服务端 PLATFORM_ADMIN_KEY）。
 * 与商户端登录**长得完全不一样**是故意的 —— 这两个入口给的是两种权力，
 * 长得像的话迟早有人在商户登录页试平台密钥。
 */
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { papi } from '@/api/platform';
import { ApiFailure } from '@/api/http';
import { platformLogin, platformLogout } from '@/stores/platform';
import { messageOf } from '@/composables/useLoad';

const router = useRouter();
const key = ref('');
const operator = ref('');
const busy = ref(false);
const err = ref('');

async function submit(): Promise<void> {
  if (!key.value.trim()) {
    err.value = '请填写平台密钥';
    return;
  }
  busy.value = true;
  err.value = '';
  // 先写入再试一个真实接口 —— "密钥对不对"只有服务端能回答，
  // 在前端做任何本地校验都只是猜
  platformLogin(key.value, operator.value);
  try {
    await papi.tenants();
    await router.push({ name: 'P-01' });
  } catch (e) {
    // 密钥不对时立刻清掉，否则它会留在 localStorage 里，
    // 下次打开页面看起来"已登录"，然后每个接口都 401
    platformLogout();
    err.value = e instanceof ApiFailure && (e.status === 401 || e.status === 403) ? '平台密钥不对' : messageOf(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="pl">
    <form class="pl__box" @submit.prevent="submit()">
      <div class="pl__brand">
        <span class="p-side__mark">台</span>
        <div>
          <h1 class="pl__title">平台后台</h1>
          <p class="sub muted">租户上线 · 版本推送 · 账目与告警</p>
        </div>
      </div>

      <label class="field">
        <span class="field__label">平台密钥</span>
        <input v-model="key" class="input" type="password" autocomplete="off" placeholder="PLATFORM_ADMIN_KEY" />
      </label>

      <label class="field">
        <span class="field__label">操作人</span>
        <input v-model="operator" class="input" type="text" placeholder="用于审计留痕，可留空" />
      </label>

      <p v-if="err" class="pl__err">{{ err }}</p>

      <button class="btn pbtn--primary pl__go" type="submit" :disabled="busy">
        {{ busy ? '验证中…' : '进入平台后台' }}
      </button>

      <p class="pl__hint sub muted">
        这里是「我方」的后台。商户请走
        <RouterLink to="/login">商户后台登录</RouterLink>
        （在小程序里生成 6 位登录码）。
      </p>
    </form>
  </div>
</template>

<style scoped>
.pl {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--paper);
  padding: var(--sp-6);
}
.pl__box {
  width: 100%;
  max-width: 380px;
  background: var(--surface);
  border: var(--bd);
  border-radius: var(--r-lg);
  padding: var(--sp-6);
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.pl__brand {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
.pl__title {
  margin: 0;
  font-size: 20px;
  line-height: 1.3;
  color: var(--ink-900);
}
.pl__err {
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
  background: var(--danger-bg);
  color: var(--ink-900);
  font-size: var(--fs-sub);
}
.pl__go {
  width: 100%;
}
.pl__hint {
  margin: 0;
  line-height: 1.6;
}
</style>
