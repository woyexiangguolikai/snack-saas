import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

/* ============================================================================
 * 购物车（§4.11 第 2 条：**购物车绑楼栋**）
 * ----------------------------------------------------------------------------
 * 这是整个学生端最容易做错的一个状态，所以把规则写死在 store 里，页面无权绕过：
 *
 * ① **车属于某一栋**。换楼栋时必须清空 —— 不清空的后果不是"多买了东西"，
 *    而是"库存预占按新楼栋算、商品在新楼栋可能根本没货"，
 *    最后表现为学生点结算 → 某个商品售罄 → 整单失败，但学生完全不知道为什么。
 *    所以宁可在切换时明确告知（轻提示），也不要留一个"看起来还在但已经无效"的车。
 *
 * ② **购物车里的金额只是展示**。下单金额由服务端按 productId 重新算（D11 价格全局统一）。
 *    前端存快照只为了不闪烁，绝不作为下单依据。
 *
 * ③ **行存快照，但可售上限以最新的 storefront 为准**。
 *    商户随时可能改库存，车里的 availableQty 一旦过期，加购就会撞上售罄。
 *    所以每次拿到新列表就 syncLimits() 覆盖一次，并把"已经买不到"的行标出来，
 *    让结算前就能看到，而不是点了结算才报错。
 * ==========================================================================*/

export interface CartLine {
  productId: number;
  name: string;
  spec: string | null;
  cover: string | null;
  /** 展示用快照；下单以服务端算价为准 */
  priceCents: number;
  qty: number;
  /** 该栋当前可售上限（来自最新 storefront） */
  limit: number;
  /** 当前是否已不可售（售罄 / 已下架）—— 结算前必须提示 */
  invalid: boolean;
}

interface Persisted {
  buildingId: number | null;
  lines: CartLine[];
}

const STORAGE_KEY = 'snack.cart';
/** 单项最大购买量：不是业务规则，是防误触（学生把 10 份按成 100 份） */
const MAX_QTY_PER_LINE = 99;

export const useCartStore = defineStore('cart', () => {
  const buildingId = ref<number | null>(null);
  const lines = ref<CartLine[]>([]);

  const count = computed(() => lines.value.reduce((s, l) => s + l.qty, 0));
  const totalCents = computed(() => lines.value.reduce((s, l) => s + l.priceCents * l.qty, 0));
  const isEmpty = computed(() => lines.value.length === 0);
  /** 有不可售的行 —— 结算按钮据此给出明确原因，而不是让服务端拒单 */
  const hasInvalid = computed(() => lines.value.some((l) => l.invalid));
  const invalidNames = computed(() => lines.value.filter((l) => l.invalid).map((l) => l.name));

  function persist(): void {
    try {
      uni.setStorageSync(STORAGE_KEY, { buildingId: buildingId.value, lines: lines.value } satisfies Persisted);
    } catch {
      // 存储写失败（配额满）不该让加购失败 —— 内存里的车仍然可用
    }
  }

  function restore(): void {
    try {
      const raw = uni.getStorageSync(STORAGE_KEY) as Persisted | '' | null;
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.lines)) return;
      buildingId.value = raw.buildingId ?? null;
      lines.value = raw.lines.filter((l) => l && typeof l.productId === 'number' && l.qty > 0);
    } catch {
      /* 脏数据当作空车 */
    }
  }

  /**
   * 绑定楼栋。**换栋即清空**，并返回被清空的信息供调用方弹轻提示。
   * 返回 null 表示"没有发生清空"（首次绑定 / 同一栋）。
   */
  function bindBuilding(nextId: number): { cleared: number } | null {
    if (buildingId.value === nextId) return null;
    const cleared = lines.value.length;
    buildingId.value = nextId;
    lines.value = [];
    persist();
    return { cleared };
  }

  function add(item: {
    productId: number;
    name: string;
    spec: string | null;
    cover: string | null;
    priceCents: number;
    availableQty: number;
  }): 'added' | 'overflow' | 'sold_out' {
    if (item.availableQty <= 0) return 'sold_out';
    const found = lines.value.find((l) => l.productId === item.productId);
    if (found) {
      found.limit = item.availableQty;
      found.invalid = false;
      // 上限取三者最小值：库存、单项防误触上限
      const cap = Math.min(item.availableQty, MAX_QTY_PER_LINE);
      if (found.qty >= cap) return 'overflow';
      found.qty += 1;
    } else {
      lines.value.push({
        productId: item.productId,
        name: item.name,
        spec: item.spec,
        cover: item.cover,
        priceCents: item.priceCents,
        qty: 1,
        limit: Math.min(item.availableQty, MAX_QTY_PER_LINE),
        invalid: false,
      });
    }
    persist();
    return 'added';
  }

  /** 加/减到指定数量；qty<=0 视为移出（由调用方决定是否二次确认） */
  function setQty(productId: number, qty: number): void {
    const i = lines.value.findIndex((l) => l.productId === productId);
    if (i < 0) return;
    const cap = Math.min(lines.value[i].limit, MAX_QTY_PER_LINE);
    if (qty <= 0) lines.value.splice(i, 1);
    else lines.value[i].qty = Math.min(qty, cap);
    persist();
  }

  function remove(productId: number): void {
    lines.value = lines.value.filter((l) => l.productId !== productId);
    persist();
  }

  function clear(): void {
    lines.value = [];
    persist();
  }

  /** 撤销：把刚移出的一行放回去（"误删"必须有退路） */
  function restoreLine(line: CartLine): void {
    if (lines.value.some((l) => l.productId === line.productId)) return;
    lines.value.push(line);
    persist();
  }

  function qtyOf(productId: number): number {
    return lines.value.find((l) => l.productId === productId)?.qty ?? 0;
  }

  /**
   * 用最新的 storefront 覆盖每行的可售上限。
   * 列表里找不到该商品 = 已下架或被隐藏 → 标为 invalid（**不自动删除**：
   * 自动删掉会让学生的车"自己少东西"，比让他看见并自己处理更糟）。
   */
  function syncLimits(items: Array<{ productId: number; availableQty: number; visibility: string; priceCents: number }>): void {
    if (!lines.value.length) return;
    const byId = new Map(items.map((i) => [i.productId, i]));
    for (const l of lines.value) {
      const it = byId.get(l.productId);
      if (!it || it.visibility === 'sold_out' || it.availableQty <= 0) {
        l.invalid = true;
        l.limit = 0;
        continue;
      }
      l.invalid = false;
      // 价格也可能被商户改过 —— 同步过来，避免结算时"金额和刚才看到的不一样"
      l.priceCents = it.priceCents;
      l.limit = Math.min(it.availableQty, MAX_QTY_PER_LINE);
      if (l.qty > l.limit) l.qty = l.limit;
    }
    persist();
  }

  /**
   * 「再来一单」专用：按**当前**货架把历史订单的行补回来。
   *
   * 三条容易做错的边界，集中在这里处理：
   *  ① 历史订单的数量不能照抄。当时买了 5 份、现在只剩 2 份，只能补 2 份 ——
   *     照抄会让结算时被服务端拒（下单是"全有或全无"），学生只看到"下单失败"三个字。
   *  ② 补不上的要**点名**，不能静默跳过。学生点「再来一单」是带着预期来的，
   *     少了一件却不说，他会以为是 App 出了 bug。
   *  ③ 调用方必须先 bindBuilding 完成换栋再调这里，否则加完会被清空。
   */
  function addFromHistory(
    wanted: Array<{ productId: number; name: string; qty: number }>,
    shelfItems: Array<{
      productId: number; name: string; spec: string | null; cover: string | null;
      priceCents: number; availableQty: number;
    }>,
  ): { addedCount: number; partial: string[]; missing: string[] } {
    const byId = new Map(shelfItems.map((i) => [i.productId, i]));
    const partial: string[] = [];
    const missing: string[] = [];
    let addedCount = 0;

    for (const w of wanted) {
      const cur = byId.get(w.productId);
      if (!cur || cur.availableQty <= 0) {
        missing.push(w.name);
        continue;
      }
      const cap = Math.min(cur.availableQty, MAX_QTY_PER_LINE);
      // 已在车里的要累加到上限为止，而不是重复覆盖
      const room = cap - qtyOf(w.productId);
      const take = Math.max(0, Math.min(w.qty, room));
      for (let i = 0; i < take; i += 1) {
        add({
          productId: cur.productId, name: cur.name, spec: cur.spec,
          cover: cur.cover, priceCents: cur.priceCents, availableQty: cur.availableQty,
        });
      }
      if (take > 0) addedCount += 1;
      else missing.push(w.name);
      if (take > 0 && take < w.qty) partial.push(w.name);
    }
    return { addedCount, partial, missing };
  }

  /** 下单载荷：只传 id 与数量，价格由服务端算 */
  function toOrderItems(): Array<{ productId: number; qty: number }> {
    return lines.value.filter((l) => !l.invalid).map((l) => ({ productId: l.productId, qty: l.qty }));
  }

  restore();

  return {
    buildingId, lines, count, totalCents, isEmpty, hasInvalid, invalidNames,
    bindBuilding, add, addFromHistory, setQty, remove, clear, restoreLine, qtyOf, syncLimits, toOrderItems,
    MAX_QTY_PER_LINE,
  };
});
