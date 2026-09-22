<script setup lang="ts">
/**
 * 网页后台登录。
 *
 * 登录码由店主本人在小程序里生成（6 位 · 5 分钟 · 一次性）。
 * 这不是"懒得做账号体系"，而是在账号体系到位之前**更强**的方案：
 * 它把"证明我是店主"交给已经验证过的微信身份，而不是新造一个密码。
 * 页面必须把"码在哪生成、多久过期"说清楚 —— 否则用户只会觉得这个后台登录方式很怪。
 */
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { login } from '@/stores/session';
import { messageOf } from '@/composables/useLoad';

const route = useRoute();
const router = useRouter();

const tenantCode = ref('');
const code = ref('');
const operator = ref('');
const busy = ref(false);
const error = ref('');

async function submit(): Promise<void> {
  error.value = '';
  if (!/^\d{6}$/.test(code.value.trim())) {
    error.value = '登录码是 6 位数字';
    return;
  }
  busy.value = true;
  try {
    await login(tenantCode.value, code.value, operator.value);
    const next = typeof route.query.next === 'string' ? route.query.next : '/';
    await router.replace(next);
  } catch (e) {
    error.value = messageOf(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="wrap">
    <div class="card">
      <h1 class="card__title">店铺后台</h1>
      <p class="card__desc">用小程序生成的登录码进入。码由店主本人生成，5 分钟内有效、用一次即失效。</p>

      <form class="form" @submit.prevent="submit()">
        <div class="field">
          <label class="field__label" for="tenant">店铺编号</label>
          <input id="tenant" v-model="tenantCode" class="input num" placeholder="如 t000001" autocomplete="off" />
          <span class="field__hint">在小程序「我的」页顶部可看到</span>
        </div>

        <div class="field">
          <label class="field__label" for="code">登录码</label>
          <input
            id="code"
            v-model="code"
            class="input num"
            inputmode="numeric"
            maxlength="6"
            placeholder="6 位数字"
            autocomplete="one-time-code"
          />
          <span class="field__hint">小程序「我的 → 后台登录码」生成</span>
        </div>

        <div class="field">
          <label class="field__label" for="operator">操作人</label>
          <input id="operator" v-model="operator" class="input" placeholder="如 张姐" />
          <span class="field__hint">改库存、改配置会记在你的名下</span>
        </div>

        <p v-if="error" class="err">{{ error }}</p>

        <button class="btn btn--primary" type="submit" :disabled="busy">
          {{ busy ? '正在进入…' : '进入后台' }}
        </button>
      </form>
    </div>
  </div>
</template>

<style scoped>
.wrap {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-6);
  background: var(--paper);
}
.card {
  width: 380px;
  max-width: 100%;
  background: var(--surface);
  border: var(--bd);
  border-radius: var(--r-lg);
  box-shadow: var(--s1);
  padding: var(--sp-6);
}
.card__title {
  margin: 0;
  font-size: var(--fs-title);
  line-height: var(--lh-title);
  font-weight: var(--fw-semibold);
  color: var(--ink-900);
}
.card__desc {
  margin: var(--sp-2) 0 var(--sp-5);
  font-size: var(--fs-sub);
  line-height: var(--lh-sub);
  color: var(--ink-500);
}
.form {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.err {
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  background: var(--danger-bg);
  color: var(--danger);
  border-radius: var(--r-md);
  font-size: var(--fs-sub);
}
</style>
