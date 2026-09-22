import { computed, ref } from 'vue';

/**
 * 网页后台的全局网络状态 —— 与小程序端 `useNetStatus` 是同一条纪律的浏览器版本。
 * 三种可见状态（依据《加载过渡与状态全集 v3.0》§5.2）：
 *   断网（灰） → 弱网重试（琥珀，带次数） → 已恢复（绿，2 秒后自动消失）
 *
 * 为什么网页端也要有：
 *   后台的取数失败有一半是"网络在抖"而不是"服务端拒绝"。只给一行红色错误，
 *   运营会以为系统坏了并打电话；给一条"网络较弱，正在重试（第 2 次）"，
 *   他就知道系统自己会好，不用动手。这两件事的成本差很多。
 *
 * 做成**模块级单例**：网络是全局事实。每页各持一份会出现"这页说断网、那页说正常"。
 */
export type NetState = 'online' | 'offline' | 'weak' | 'recovered';
const state = ref<NetState>('online');
const retryCount = ref(0);
/** 已恢复的绿条停留时长（设计：2 秒） */
const RECOVER_HOLD_MS = 2000;
/** 连续失败 2 次才算"弱网"：偶发一次超时不该惊动用户 */
const WEAK_THRESHOLD = 2;

let holdTimer: ReturnType<typeof setTimeout> | null = null;
let listening = false;

function clearHold(): void {
  if (holdTimer) {
    clearTimeout(holdTimer);
    holdTimer = null;
  }
}

/** online 时不渲染 —— 一直挂着一条"网络正常"会让人以为出了什么事 */
const visible = computed(() => state.value !== 'online');

const text = computed(() => {
  switch (state.value) {
    case 'offline':
      return '网络已断开，已改为离线浏览';
    case 'weak':
      return `网络较弱，正在重试（第 ${retryCount.value} 次）`;
    case 'recovered':
      return '已恢复连接';
    default:
      return '';
  }
});

/** tone → 颜色。业务代码不得自行选色 */
const tone = computed<'off' | 'warn' | 'ok'>(() => {
  if (state.value === 'offline') return 'off';
  if (state.value === 'weak') return 'warn';
  return 'ok';
});

export function useNetStatus() {
  ensureListening();
  return { state, text, tone, visible, retryCount };
}

/** 浏览器网络事件只挂一次：这是全局事实 */
function ensureListening(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('offline', () => netReporter.offline());
  window.addEventListener('online', () => netReporter.success());
  // 打开页面时浏览器已经知道有没有网，直接用，不用等第一次请求失败
  if (navigator.onLine === false) netReporter.offline();
}

/**
 * 给**非组件**调用方（HTTP 层）用的上报入口。
 *
 * HTTP 层不是组件，调 `useNetStatus()` 会顺带挂系统事件监听，
 * 而那一层不该关心 UI 生命周期 —— 所以单独开这个极薄的门面。
 */
export const netReporter = {
  failure(): void {
    clearHold();
    retryCount.value += 1;
    if (state.value === 'offline') return;
    if (retryCount.value >= WEAK_THRESHOLD) state.value = 'weak';
  },
  success(): void {
    const wasBad = state.value === 'offline' || state.value === 'weak';
    retryCount.value = 0;
    if (!wasBad) return;
    state.value = 'recovered';
    clearHold();
    holdTimer = setTimeout(() => {
      if (state.value === 'recovered') state.value = 'online';
    }, RECOVER_HOLD_MS);
  },
  offline(): void {
    clearHold();
    state.value = 'offline';
  },
};

/** 演示/自测用：把状态复位 */
export function resetNetStatus(): void {
  clearHold();
  state.value = 'online';
  retryCount.value = 0;
}
