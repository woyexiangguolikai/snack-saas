import { computed, ref } from 'vue';

/**
 * 全局网络状态（"网络横幅"的唯一真相源）。
 *
 * 三种可见状态（依据《加载过渡与状态全集 v3.0》§5.2）：
 *   断网（灰） → 弱网重试（琥珀，带次数） → 已恢复（绿，2 秒后自动消失）
 *
 * 三条纪律，缺一条这条横幅就会变成骚扰：
 *   ① **绝不"清空页面"**：断网时页面内容保持可见，只是不能提交。
 *      所以本模块只提供"横幅状态"，不提供任何"清空数据"的能力 —— 想做也做不到。
 *   ② **恢复态必须自己消失**：留一条绿条挂在那里，用户会以为还有什么没处理完。
 *   ③ **弱网次数必须真实**：次数来自真实失败重试，不是动画效果。
 *      编一个"第 2 次"的数字比不显示更糟 —— 它是在骗用户"系统正在努力"。
 *
 * 做成模块级单例（而不是 `useXxx()` 每次新建）：
 *   网络是一种**全局事实**。每个页面各持一份状态，会出现"这页说断网、那页说正常"。
 */
export type NetState = 'online' | 'offline' | 'weak' | 'recovered';

const state = ref<NetState>('online');
const retryCount = ref(0);
/** 已恢复的绿条停留时长（设计：2 秒） */
const RECOVER_HOLD_MS = 2000;

let holdTimer: ReturnType<typeof setTimeout> | null = null;
let listening = false;

function clearHold(): void {
  if (holdTimer) {
    clearTimeout(holdTimer);
    holdTimer = null;
  }
}

/** 是否显示了"需要用户知道"的横幅（online 时不渲染，避免永久占用 26px） */
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

/** tone → UI 颜色。业务代码不得自行选色（铁律 4） */
const tone = computed<'off' | 'warn' | 'ok'>(() => {
  if (state.value === 'offline') return 'off';
  if (state.value === 'weak') return 'warn';
  return 'ok';
});

export function useNetStatus() {
  ensureListening();

  return {
    state,
    text,
    tone,
    visible,
    retryCount,
    /** 请求层报告一次网络类失败 —— 次数由此累加，不是编的 */
    reportFailure(): void {
      netReporter.failure();
    },
    /** 请求层报告一次成功 */
    reportSuccess(): void {
      netReporter.success();
    },
    /** 手动置为断网（系统事件不可用时的兜底） */
    reportOffline(): void {
      netReporter.offline();
    },
  };
}

/** 系统网络事件只挂一次：这是全局事实，不是每个页面各挂一份 */
function ensureListening(): void {
  if (listening) return;
  listening = true;
  uni.onNetworkStatusChange?.((res) => {
    if (!res.isConnected) {
      netReporter.offline();
      return;
    }
    netReporter.success();
  });
}

/**
 * 给**非组件**调用方（请求层）用的上报入口。
 *
 * 请求层不是组件，调 `useNetStatus()` 会顺带注册网络事件监听，
 * 而那一层不应该关心 UI 生命周期 —— 所以单独开这个极薄的门面。
 */
export const netReporter = {
  failure(): void {
    clearHold();
    retryCount.value += 1;
    // 连续失败 2 次才显示"较弱"：偶发一次超时不该惊动用户
    if (retryCount.value >= 2) state.value = 'weak';
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

/** 测试/演示用：把状态复位 */
export function resetNetStatus(): void {
  clearHold();
  state.value = 'online';
  retryCount.value = 0;
}
