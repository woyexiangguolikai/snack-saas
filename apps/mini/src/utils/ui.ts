/* ============================================================================
 * 轻提示 / 确认弹窗（文案的统一出口）
 * ----------------------------------------------------------------------------
 * 为什么要包一层而不直接用 uni.showToast：
 *
 * ① **文案基线在这里**。D5 禁用词表（"欠费""警告""失败"这类会让人紧张的词）
 *    是全站要求，散落在 20 个页面里必然有人写错。集中在一处，改一次全站生效。
 * ② **时长随字数**。默认 1500ms 对"已切换到 2 栋，购物车已清空"来说太短，
 *    学生还没看清就没了。统一按字数给时长，比自己调参省事且一致。
 * ③ 小程序 toast 默认带图标，图标会抢走文字的注意力 —— 这里一律 icon:'none'。
 * ==========================================================================*/

type ToastKind = 'info' | 'ok' | 'warn';

const PREFIX: Record<ToastKind, string> = {
  info: '',
  ok: '',
  warn: '',
};

/** 按字数给时长：至少 1.5s，最多 3s —— 够看清，又不至于挡住下一步操作 */
function durationOf(text: string): number {
  return Math.min(3_000, Math.max(1_500, 600 + text.length * 90));
}

export function toast(text: string, kind: ToastKind = 'info'): void {
  uni.showToast({
    title: `${PREFIX[kind]}${text}`,
    icon: 'none',
    duration: durationOf(text),
    mask: false, // 不加遮罩：提示期间仍可操作，避免"被弹窗关住"的感觉
  });
}

/** 统一的"操作已受理"提示 */
export function toastDone(text: string): void {
  toast(text, 'ok');
}

/**
 * 二次确认。
 * ⚠️ 只用于**有实际损失**的操作（删除地址、清空购物车）。
 * 什么都要确认会让用户养成无脑点"确定"的习惯，那时确认就失去意义了。
 *
 * 关于 `confirmColor`：**故意不传**。
 * 原生 modal 的按钮色属于微信客户端自己渲染的界面，不受我们的 Token 控制；
 * 想"让它跟设计系统一致"就得在这里把 --danger 的色值**抄一份字面量** ——
 * 那等于在 Token 体系外开了一个色值出口，AC-04 的单一真相源当场失效，
 * 而且将来改语义色时没人会想起这里（检查脚本也会直接报错）。
 * 少数几个像素的观感差异，不值得换掉"色值只有一个来源"这条硬约束。
 */
export function confirm(title: string, content: string, confirmText = '确定'): Promise<boolean> {
  return new Promise((resolve) => {
    uni.showModal({
      title,
      content,
      confirmText,
      cancelText: '再想想',
      success: (r) => resolve(!!r.confirm),
      fail: () => resolve(false),
    });
  });
}

/** 底部选择（ActionSheet）。返回选中的下标，取消返回 -1。 */
export function choose(itemList: string[], title?: string): Promise<number> {
  return new Promise((resolve) => {
    uni.showActionSheet({
      itemList,
      ...(title ? { title } : {}),
      success: (r) => resolve(r.tapIndex),
      fail: () => resolve(-1),
    });
  });
}

/* ---------------------------------------------------------------- 导航 */

/** TabBar 页面路径 —— 这几页**只能**用 switchTab 打开 */
export const TAB = {
  home: '/pages/shop/home',
  orders: '/pages/order/list',
  mine: '/pages/mine/index',
} as const;

/**
 * 跳转到 TabBar 页面。
 *
 * ⚠️ 必须用这个而不是 navigateTo：`uni.navigateTo` 打开 tab 页会**静默失败**
 * （不报错、不跳转、控制台只有一条 warning）。这类问题在真机自查时表现为
 * "点了没反应"，而我们习惯性地点按钮测试时又不会去点 tab 页，
 * 所以它很容易活到线上。把它收敛成一个函数，就不会有人再写错。
 */
export function switchTab(path: string): void {
  uni.switchTab({ url: path });
}

/** 返回上一页；没有上一页时回首页（TabBar 页用 switchTab） */
export function goBackOrHome(): void {
  const pages = getCurrentPages();
  if (pages.length > 1) uni.navigateBack();
  else switchTab(TAB.home);
}
