import { computed, ref } from 'vue';
import { useSessionStore } from '../stores/session';
import { useCartStore } from '../stores/cart';
import { useCountdown } from './useCountdown';
import { api, type OrderGate, type StorefrontItem } from '../utils/api';
import { toast, switchTab, TAB } from '../utils/ui';
import { CUSTOMER_COPY } from '../utils/copy';
import { useUndoBar } from './useUndoBar';

/* ============================================================================
 * 店铺上下文（首页 / 分类 / 搜索三页共用的那一层）
 * ----------------------------------------------------------------------------
 * 这三页面对的是同一份"当前店铺状态"：我在哪一栋、现在能不能下单、
 * 加购往哪个车放。如果每页各写一遍，最典型的后果是：
 *   · A 页切了楼栋，B 页的购物车还绑在旧楼栋上（下单时库存按错楼算）
 *   · A 页闸门刷新了，B 页还显示"可下单"（点提交才被拒）
 * 所以这一层必须是共享的，且**只在这里**发生楼栋切换。
 * ==========================================================================*/

export function useShop() {
  const session = useSessionStore();
  const cart = useCartStore();
  /** 换楼栋的 5 秒撤销条（R-5）—— 单例，页面只负责把 <SnUndoBar> 挂上 */
  const undo = useUndoBar();

  const buildingId = computed(() => session.currentBuilding?.buildingId ?? 0);
  const buildingName = computed(() => session.currentBuilding?.buildingName ?? '');
  /** 单楼栋自动降级：有效楼栋 ≤ 1 时隐藏全部楼栋 UI（§4.9） */
  const multiBuilding = computed(() => !session.singleBuildingMode && session.buildings.length > 1);

  /* ------------------------------------------------------------- 闸门 */

  const gate = ref<OrderGate | null>(null);
  const gateErr = ref('');
  const gateLoading = ref(false);

  /**
   * 闸门单独取，**不并进商品列表**：
   * 「能不能下单」和「有没有商品」是两件事。闸门挂了不该让商品消失，
   * 商品挂了也不该让状态条说"不可下单"。
   */
  async function loadGate(): Promise<void> {
    if (!buildingId.value) return;
    gateLoading.value = true;
    try {
      gate.value = await api.gate(buildingId.value);
      gateErr.value = '';
    } catch (e) {
      gate.value = null;
      gateErr.value = e instanceof Error ? e.message : '暂时无法确认能否下单';
    } finally {
      gateLoading.value = false;
    }
  }

  const orderable = computed(() => gate.value?.orderable === true);

  /** 状态条文案：**服务端给什么显示什么**（AC-11），前端不自己造句 */
  const gateTip = computed(() => {
    if (gateErr.value) return { tone: 'off' as const, text: gateErr.value, extra: '' };
    if (!gate.value) return null;
    const g = gate.value;
    if (!g.orderable) {
      return { tone: g.tone, text: g.message, extra: g.nextOpenAt ? `下次可下单 ${g.nextOpenAt}` : '' };
    }
    if (g.minutesToCutoff !== null && g.minutesToCutoff <= 30) {
      return { tone: g.tone, text: `距截单还有 ${g.minutesToCutoff} 分钟，请尽快下单`, extra: '' };
    }
    return { tone: g.tone, text: g.message, extra: '' };
  });

  const cutoffSeconds = computed(() =>
    gate.value && gate.value.minutesToCutoff !== null ? gate.value.minutesToCutoff * 60 : null,
  );
  // 解构出来让它成为顶层 ref，模板里可自动解包
  const { text: cutoffText } = useCountdown(cutoffSeconds, () => {
    // 到点不在本地改状态，重新问服务端 —— 本地判定会与服务端有秒级偏差
    void loadGate();
  });

  const blocked = computed(() => gate.value !== null && !gate.value.orderable);

  /**
   * 「今天做不了」的**整页**状态（§5.3 / §6.4）。
   *
   * 为什么必须是整页而不是页内一条提示：
   *   截单 / 本栋停送之后，"选地址、点提交"这些动作都不可能成功。
   *   把它们留在屏幕上，等于给了一堆点不动的控件 —— 学生会反复点提交，
   *   每次都被拒，然后把失败归因成"这个 App 坏了"。换成整页状态后，
   *   页面上只剩**能做的事**（送到别的楼栋 / 回首页）。
   *
   * ⚠️ 学生端一律用灰（AC-02）。余额触底在服务端是 danger —— 那是给商户端
   *   与平台看板用的闸门色；学生端必须与"店家休息中"长得一模一样（§6.5 / AC-13）。
   *   所以这里的 tone **写死 'off'**，不跟着 gate.tone 走，这是刻意的。
   *
   * ⚠️ 调用方**不得因为进入这个状态就清空购物车**：已截单时购物车整体保留到明天、
   *   本栋停送时已选商品保留只拦提交（§5.3 第一原则：不要让用户丢数据）。
   */
  const noOrderView = computed(() => {
    const g = gate.value;
    if (!g || g.orderable) return null;
    return {
      title: g.title,
      text: g.message,
      recovery: g.recovery,
      tone: 'off' as const,
    };
  });

  /* --------------------------------------------------------- 楼栋切换 */

  /**
   * 购物车绑楼栋。换栋即清空，并**明确告知**（§4.11 第 2 条）。
   * 返回是否发生了清空，便于调用方决定要不要额外提示。
   */
  function bindCart(): boolean {
    if (!buildingId.value) return false;
    const r = cart.bindBuilding(buildingId.value);
    if (r && r.cleared > 0) {
      toast(`已切换到 ${buildingName.value}，购物车已清空（原有 ${r.cleared} 种商品）`);
      return true;
    }
    return false;
  }

  /**
   * 切换楼栋：唯一入口。切完必须重新拉闸门 —— 新楼栋的配送规则可能完全不同。
   *
   * R-5 的兜底在这里：换栋会清空购物车，而"手滑点错楼栋"是**高频**事件
   * （楼栋牌就在首页顶部，一点就开抽屉）。所以：
   *   · 不弹二次确认（AC-08：可逆操作不弹确认）；
   *   · 但必须给 **5 秒撤销**，而且撤销要把楼栋和整车一起还原 ——
   *     只还商品不还楼栋，那些商品在新楼栋全是错的库存，等于给了个假的后悔药。
   *
   * @param afterUndo 撤销成功后由**调用页面**重拉自己的列表。
   *                  页面列表是页面自己的状态（home/category 各有一份 goods），
   *                  composable 拿不到它；不还原它，界面会停在"新楼栋的商品"上，
   *                  而车里装的是刚换回去那栋的货 —— 学生一结算就被拒。
   */
  async function pickBuilding(id: number, afterUndo?: () => void | Promise<void>): Promise<void> {
    if (id === buildingId.value) return;
    const fromName = buildingName.value;
    // 快照必须在切换**之前**取：切换后整车已经没了，谁也拼不回来
    const snap = cart.snapshotOf();
    const cleared = cart.lines.length;

    session.setLastBuilding(id);
    // 直接用 store 的 bindBuilding 而不是 bindCart()：提示语统一由下面这一处给。
    // 两处都提示会先弹"购物车已清空"再弹"已切换"，用户只看得到后一句。
    cart.bindBuilding(id);
    await loadGate();

    if (cleared > 0) {
      undo.show({
        message: `已切到 ${buildingName.value}，购物车里 ${cleared} 种商品清空了`,
        run: async () => {
          cart.restoreSnapshot(snap);
          if (snap.buildingId !== null) session.setLastBuilding(snap.buildingId);
          await loadGate();
          await afterUndo?.();
          toast(`已换回 ${fromName || '原来那栋'}，商品都放回去了`);
        },
      });
    } else {
      toast(`已切换到 ${buildingName.value}`);
    }
  }

  /* ----------------------------------------------------------- 加购 */

  const lastAddFailed = ref(false);

  /** 加购。成功**故意不弹提示** —— 件数与金额在吸底条上实时变化，那才是反馈通道 */
  function addToCart(it: StorefrontItem): void {
    const r = cart.add({
      productId: it.productId,
      name: it.name,
      spec: it.spec,
      cover: it.cover,
      priceCents: it.priceCents,
      availableQty: it.availableQty,
    });
    lastAddFailed.value = r !== 'added';
    // §5.4-3：被上限挡住时必须说清"最多能买几件"，只写"库存不足"学生不知道改到哪
    if (r === 'overflow') toast(CUSTOMER_COPY.stockLimit(it.availableQty));
    else if (r === 'sold_out') toast(CUSTOMER_COPY.soldOut(`「${it.name}」`, buildingName.value));
  }

  function setQty(productId: number, qty: number): void {
    if (qty <= 0) {
      cart.remove(productId);
      return;
    }
    cart.setQty(productId, qty);
  }

  function qtyOf(productId: number): number {
    return cart.qtyOf(productId);
  }

  /* ----------------------------------------------------------- 导航 */

  function gotoCheckout(): void {
    if (cart.isEmpty) {
      toast('购物车是空的');
      return;
    }
    uni.navigateTo({ url: '/pages/order/confirm' });
  }

  function gotoSearch(): void {
    uni.navigateTo({ url: '/pages/shop/search' });
  }

  function gotoCategory(): void {
    uni.navigateTo({ url: '/pages/shop/category' });
  }

  /* 订单 / 我的 是 TabBar 页 —— 只能 switchTab（navigateTo 会静默失败） */
  function gotoOrders(): void {
    switchTab(TAB.orders);
  }

  function gotoMine(): void {
    switchTab(TAB.mine);
  }

  return {
    session, cart,
    buildingId, buildingName, multiBuilding,
    gate, gateErr, gateLoading, loadGate, orderable, gateTip, cutoffSeconds, cutoffText, blocked, noOrderView,
    bindCart, pickBuilding,
    addToCart, setQty, qtyOf, lastAddFailed,
    gotoCheckout, gotoSearch, gotoCategory, gotoOrders, gotoMine,
  };
}
