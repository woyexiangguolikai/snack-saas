import { computed, ref } from 'vue';
import { useSessionStore } from '../stores/session';
import { useCartStore } from '../stores/cart';
import { useCountdown } from './useCountdown';
import { api, type OrderGate, type StorefrontItem } from '../utils/api';
import { toast, switchTab, TAB } from '../utils/ui';

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

  /** 切换楼栋：唯一入口。切完必须重新拉闸门 —— 新楼栋的配送规则可能完全不同 */
  async function pickBuilding(id: number): Promise<void> {
    if (id === buildingId.value) return;
    session.setLastBuilding(id);
    bindCart();
    await loadGate();
    toast(`已切换到 ${session.currentBuilding?.buildingName ?? ''}`);
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
    if (r === 'overflow') toast('本栋库存不足了');
    else if (r === 'sold_out') toast('本栋已售完');
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
    gate, gateErr, gateLoading, loadGate, orderable, gateTip, cutoffSeconds, cutoffText, blocked,
    bindCart, pickBuilding,
    addToCart, setQty, qtyOf, lastAddFailed,
    gotoCheckout, gotoSearch, gotoCategory, gotoOrders, gotoMine,
  };
}
