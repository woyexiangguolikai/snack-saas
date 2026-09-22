<script setup lang="ts">
import { onLaunch, onShow, onError } from '@dcloudio/uni-app';
import { useSessionStore } from './stores/session';

onLaunch(() => {
  const session = useSessionStore();

  /*
   * 启动只做两件事，且都不发网络请求：
   *   ① 从本地存储同步恢复令牌（含店名、楼栋记忆）—— 首屏可立即渲染正确内容
   *   ② 预热一次租户识别（fire-and-forget）
   *
   * 为什么必须"不 await"：
   *   小程序 onLaunch 里 await 一个网络请求 = 首屏白屏等网络。
   *   而"白屏"是我们明确列为不可接受的失败形态（见 stores/session.ts 顶部约束①）。
   *   预热的价值在于：页面真正需要时 await ensureResolved() 会命中同一个
   *   in-flight promise（单飞），总请求数仍然只有 1 次，但页面渲染不被它阻塞。
   */
  session.restore();
  void session.ensureResolved();
});

onShow(() => {
  // 从后台切回来时不做任何事：令牌有效性由请求层的 401 → 自动重登兜底，
  // 不需要在这里"猜"令牌是否过期（猜错就是多余的请求）。
});

onError((e) => {
  // 全局兜底：异常不许静默吞掉，否则线上问题无从查起
  console.error('[app] uncaught', e);
});
</script>

<style>
@import './styles/index.css';
</style>
