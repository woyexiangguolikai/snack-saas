import { Inject, Injectable } from '@nestjs/common';
import { ERR, BizError } from '../core/errors';
import { REPO_FACTORY } from '../core/repo.factory';
import type { ProductRecord, RepoFactory, StockLogRecord, TenantRepo } from '../core/repository';
import type { ProductCellView, ProductMatrixRow, ProductStockRecord, ProductVisibility } from '../core/types';

/**
 * StockService —— SKU × 楼栋 的二维库存矩阵。
 *
 * 三件必须坚持的事，缺一件这套系统就会在日常运营里"看起来能用但其实错了"：
 *
 * 1) **未上架 ≠ 售罄。** 两者在前台是不同的展示：未上架是不显示（顾客不知道有这东西），
 *    售罄是显示但不可加购（顾客知道，明天再来）。把它们合并成一个"库存 0"，
 *    商户就再也表达不出"这个楼栋我不卖这个"。所以 `status` 与 `stock` 是两个字段。
 *
 * 2) **改库存只有两条路**：`repo.moveStock`（无条件增量）与 `repo.moveStockIf`（条件迁移）。
 *    业务层不再有任何"先查再改"—— 那种写法在并发下必然超卖。
 *
 * 3) **每次变动必写流水。** 库存是"算出来的结果"，流水是"过程"。
 *    只留结果的话，某天对不上账就永远查不出是哪一步错的。
 *    流水的 `stockAfter` 是快照，且 `stock === Σ change` 恒成立 —— 这让"库存对不对"变成可执行命题。
 */

/** 七种库存迁移的完整定义。任何一格库存的变化都必须能对应到这里的一行。 */
const TRANSITIONS = {
  /** 下单预占：可售 −qty，预占 +qty。**必须条件执行**（stock ≥ qty 且该栋已上架） */
  order_hold: { dStock: 'neg', dLocked: '+', dSold: 'none', conditional: true },
  /** 支付确认：**不动可售**（预占时已扣），预占 −qty，已售 +qty */
  pay_confirm: { dStock: 'none', dLocked: 'neg', dSold: '+', conditional: false },
  /** 取消 / 超时释放：可售 +qty，预占 −qty */
  cancel_release: { dStock: '+', dLocked: 'neg', dSold: 'none', conditional: false },
  /** 退款回库（仅未送达）：可售 +qty，已售 −qty */
  refund_return: { dStock: '+', dLocked: 'none', dSold: 'neg', conditional: false },
  /** 人工调整（盘点纠偏）：只动可售 */
  manual_adjust: { dStock: '±', dLocked: 'none', dSold: 'none', conditional: false },
  /** 调拨出：只动调出栋的可售 */
  transfer_out: { dStock: 'neg', dLocked: 'none', dSold: 'none', conditional: true },
  /** 调拨入：只动调入栋的可售 */
  transfer_in: { dStock: '+', dLocked: 'none', dSold: 'none', conditional: false },
} as const;

@Injectable()
export class StockService {
  constructor(@Inject(REPO_FACTORY) private readonly repos: RepoFactory) {}

  private repo(tenantCode: string): TenantRepo {
    return this.repos.tenant(tenantCode);
  }

  /* ============================================================ 一、前台可见性 */

  /**
   * 商品在某栋的前台可见性（三态）。
   * 判据顺序很重要：先问"上没上架"，再问"有没有货"。
   */
  static visibilityOf(product: ProductRecord, cell: ProductStockRecord | null): ProductVisibility {
    // 商品全局下架 → 所有楼栋都看不到（与某栋单独下架是两件事）
    if (product.status !== 'active') return 'hidden';
    // 该栋从来没有这一格 = 从未上架 → 不显示
    if (!cell) return 'hidden';
    // 该栋单独下架 → 不显示
    if (cell.status !== 'on') return 'hidden';
    return cell.stock > 0 ? 'available' : 'sold_out';
  }

  /**
   * 库存格的双重编码（AC-11）：底色 = 状态，同时给文字角标（色盲也必须能读）。
   * 颜色与角标都由服务端给，商户端不得自行选色。
   */
  static cellTone(cell: ProductStockRecord | null, visibility: ProductVisibility): ProductCellView['tone'] {
    if (visibility === 'hidden') return 'off';
    if (!cell) return 'off';
    if (cell.stock === 0) return 'danger';
    if (cell.warnStock !== null && cell.stock <= cell.warnStock) return 'warn';
    return 'ok';
  }

  static cellBadge(cell: ProductStockRecord | null, visibility: ProductVisibility): string {
    if (visibility === 'hidden') return cell ? '该栋未上架' : '未上架';
    if (!cell) return '未上架';
    if (cell.stock === 0) return '售罄';
    if (cell.warnStock !== null && cell.stock <= cell.warnStock) return `仅剩 ${cell.stock}`;
    return '在售';
  }

  /**
   * 库存矩阵（商户后台核心页 / 学生端商品列表的来源）。
   * 一次把商品 × 楼栋拉平，避免前端 N×M 次请求。
   */
  async matrix(
    tenantCode: string,
    opts: { includeOff?: boolean } = {},
  ): Promise<{
    buildings: Array<{ id: number; code: string; name: string; status: string }>;
    rows: ProductMatrixRow[];
  }> {
    const repo = this.repo(tenantCode);
    const buildings = (await repo.listBuildings(true)).map((b) => ({
      id: b.id,
      code: b.code,
      name: b.name,
      status: b.status,
    }));
    const activeBuildings = buildings.filter((b) => b.status === 'active');
    const products = await repo.listProducts({ includeOff: opts.includeOff });
    const stocks = await repo.listStocks();
    const byKey = new Map(stocks.map((s) => [`${s.productId}|${s.buildingId}`, s]));

    const rows: ProductMatrixRow[] = products.map((p) => {
      const cells: ProductCellView[] = activeBuildings.map((b) => {
        const cell = byKey.get(`${p.id}|${b.id}`) ?? null;
        const visibility = StockService.visibilityOf(p, cell);
        return {
          buildingId: b.id,
          buildingCode: b.code,
          buildingName: b.name,
          exists: cell !== null,
          status: cell?.status ?? 'off',
          stock: cell?.stock ?? 0,
          locked: cell?.locked ?? 0,
          sold: cell?.sold ?? 0,
          warnStock: cell?.warnStock ?? null,
          visibility,
          tone: StockService.cellTone(cell, visibility),
          badge: StockService.cellBadge(cell, visibility),
        };
      });
      return {
        productId: p.id,
        name: p.name,
        spec: p.spec,
        priceCents: p.priceCents,
        categoryId: p.categoryId,
        status: p.status,
        sort: p.sort,
        cells,
        totalStock: cells.reduce((s, c) => s + c.stock, 0),
      };
    });
    return { buildings: activeBuildings, rows };
  }

  /** 学生端取该栋商品列表：**只返回 available 与 sold_out**，hidden 一律过滤掉 */
  async listForBuilding(
    tenantCode: string,
    buildingId: number,
    opts: { categoryId?: number; keyword?: string } = {},
  ) {
    const repo = this.repo(tenantCode);
    const products = await repo.listProducts();
    const stocks = await repo.listStocks(buildingId);
    const byProduct = new Map(stocks.map((s) => [s.productId, s]));

    const kw = opts.keyword?.trim().toLowerCase();
    return products
      .filter((p) => (opts.categoryId === undefined ? true : p.categoryId === opts.categoryId))
      .filter((p) => (kw ? p.name.toLowerCase().includes(kw) || (p.spec ?? '').toLowerCase().includes(kw) : true))
      .map((p) => {
        const cell = byProduct.get(p.id) ?? null;
        const visibility = StockService.visibilityOf(p, cell);
        return {
          productId: p.id,
          name: p.name,
          spec: p.spec,
          cover: p.cover,
          priceCents: p.priceCents,
          categoryId: p.categoryId,
          visibility,
          /** 可加购上限 = 当前可售（预占已从 stock 扣走） */
          availableQty: visibility === 'available' ? (cell?.stock ?? 0) : 0,
        };
      })
      .filter((x) => x.visibility !== 'hidden');
  }

  /* ============================================================ 二、库存状态迁移 */

  /**
   * 幂等守卫：某个"冲正类"操作（释放 / 回库）在同一订单上只能生效一次。
   *
   * 为什么必须有：超时关单任务与用户点"取消"可能同时到达，
   * 退款回调也可能被微信重试。没有这道闸，同一笔会释放两次 → 库存凭空多出来。
   */
  private async alreadyDone(repo: TenantRepo, orderNo: string, type: StockLogRecord['type']): Promise<boolean> {
    const logs = await repo.findStockByOrder(orderNo);
    return logs.some((l) => l.type === type);
  }

  /** 下单预占：stock−− / locked++。失败原因要能直接展示给学生 */
  async hold(tenantCode: string, input: { productId: number; buildingId: number; qty: number; orderNo: string }) {
    if (!Number.isInteger(input.qty) || input.qty <= 0) {
      throw new BizError(ERR.VALIDATION_FAILED, '预占数量必须为正整数');
    }
    const r = await this.repo(tenantCode).moveStockIf({
      productId: input.productId,
      buildingId: input.buildingId,
      dStock: -input.qty,
      dLocked: input.qty,
      type: 'order_hold',
      requireOnShelf: true,
      refOrderNo: input.orderNo,
    });
    if (!r.ok) {
      if (r.reason === 'not_on_shelf') {
        throw new BizError(ERR.VALIDATION_FAILED, '该商品在当前楼栋未上架，请换一件或换栋');
      }
      // §5.4-3：不说"库存不足"（只说不行），要说"还剩几件"（学生才知道改到多少）
      throw new BizError(ERR.VALIDATION_FAILED, `本栋只剩 ${r.cell?.stock ?? 0} 件了，请调整数量`);
    }
    return r.cell!;
  }

  /**
   * 支付确认：locked−− / sold++。
   * 这一步**不动 stock** —— 货在"预占"时就已从可售里扣走了，
   * 这里再加一次减就是重复扣（会凭空少货）。
   */
  async confirmPaid(tenantCode: string, input: { productId: number; buildingId: number; qty: number; orderNo: string }) {
    const repo = this.repo(tenantCode);
    // 幂等：支付回调会被重试，同一笔不能扣两次
    if (await this.alreadyDone(repo, input.orderNo, 'pay_confirm')) {
      const cell = await repo.findStock(input.productId, input.buildingId);
      return cell;
    }
    const r = await repo.moveStock({
      productId: input.productId,
      buildingId: input.buildingId,
      dLocked: -input.qty,
      dSold: input.qty,
      type: 'pay_confirm',
      refOrderNo: input.orderNo,
      requireExists: true,
    });
    if (!r.ok) {
      // locked 不足说明预占记录与支付回调不同步 —— 必须抛错而不是"尽力而为"地少扣
      const cell = await repo.findStock(input.productId, input.buildingId);
      throw new BizError(
        ERR.VALIDATION_FAILED,
        `预占数量不足（预占 ${cell?.locked ?? 0}，需要 ${input.qty}）`,
      );
    }
    return r.cell!;
  }

  /** 取消 / 超时关单释放：locked−− / stock++ */
  async release(
    tenantCode: string,
    input: { productId: number; buildingId: number; qty: number; orderNo: string; by: 'user' | 'timeout' },
  ) {
    const repo = this.repo(tenantCode);
    const cell = await repo.findStock(input.productId, input.buildingId);
    if (!cell) throw BizError.notFound(ERR.NOT_FOUND, '库存格不存在');
    // 幂等：用户取消与超时任务可能同时到达
    if (await this.alreadyDone(repo, input.orderNo, 'cancel_release')) return cell;

    const r = await repo.moveStock({
      productId: input.productId,
      buildingId: input.buildingId,
      dStock: input.qty,
      dLocked: -input.qty,
      type: 'cancel_release',
      refOrderNo: input.orderNo,
      operator: input.by,
      remark: input.by === 'timeout' ? '超时未支付自动关单，库存回滚' : '用户取消订单，库存回滚',
    });
    if (!r.ok) {
      // 预占不足 = 数据不一致，宁可报错也不要静默少还
      throw new BizError(
        ERR.VALIDATION_FAILED,
        `释放失败：该订单预占数为 ${cell.locked}，小于需释放的 ${input.qty}`,
      );
    }
    return r.cell!;
  }

  /** 退款回库（仅未送达）：sold−− / stock++ */
  async returnOnRefund(tenantCode: string, input: { productId: number; buildingId: number; qty: number; orderNo: string }) {
    const repo = this.repo(tenantCode);
    const cell = await repo.findStock(input.productId, input.buildingId);
    if (!cell) throw BizError.notFound(ERR.NOT_FOUND, '库存格不存在');
    if (await this.alreadyDone(repo, input.orderNo, 'refund_return')) return cell;

    const r = await repo.moveStock({
      productId: input.productId,
      buildingId: input.buildingId,
      dStock: input.qty,
      dSold: -input.qty,
      type: 'refund_return',
      refOrderNo: input.orderNo,
      remark: '退款且未送达，库存回库',
    });
    if (!r.ok) {
      throw new BizError(
        ERR.VALIDATION_FAILED,
        `回库失败：该格已售数为 ${cell.sold}，小于需回库的 ${input.qty}`,
      );
    }
    return r.cell!;
  }

  /** 人工调整（盘点纠偏）——必写 operator 与理由 */
  async adjust(
    tenantCode: string,
    input: { productId: number; buildingId: number; stock: number; reason: string; operator: string },
  ) {
    if (!input.reason?.trim() || !input.operator?.trim()) {
      throw new BizError(ERR.VALIDATION_FAILED, '人工调整库存必须写明理由与操作人');
    }
    if (!Number.isInteger(input.stock) || input.stock < 0) {
      throw new BizError(ERR.VALIDATION_FAILED, '库存必须为非负整数');
    }
    const repo = this.repo(tenantCode);
    const cell = await repo.findStock(input.productId, input.buildingId);
    if (!cell) throw BizError.notFound(ERR.NOT_FOUND, '该商品在此楼栋尚未上架，请先上架再调整');

    // 目标是绝对值 → 换算成增量，因为流水记的是变化量
    const r = await repo.moveStock({
      productId: input.productId,
      buildingId: input.buildingId,
      dStock: input.stock - cell.stock,
      type: 'manual_adjust',
      operator: input.operator,
      remark: input.reason.trim(),
    });
    if (!r.ok) throw new BizError(ERR.VALIDATION_FAILED, '调整后库存不得为负');
    return r.cell!;
  }

  /** 跨栋调拨（例外不是常态）—— 两格必须在同一次业务操作里完成 */
  async transfer(
    tenantCode: string,
    input: { productId: number; fromBuildingId: number; toBuildingId: number; qty: number; operator?: string },
  ) {
    if (!Number.isInteger(input.qty) || input.qty <= 0) {
      throw new BizError(ERR.VALIDATION_FAILED, '调拨数量必须为正整数');
    }
    if (input.fromBuildingId === input.toBuildingId) {
      throw new BizError(ERR.VALIDATION_FAILED, '调出与调入库栋不能相同');
    }
    const repo = this.repo(tenantCode);
    const from0 = await repo.findStock(input.productId, input.fromBuildingId);
    if (!from0 || from0.stock < input.qty) {
      throw new BizError(ERR.VALIDATION_FAILED, `调拨失败：调出楼栋可售不足（当前 ${from0?.stock ?? 0} 件）`);
    }
    const to0 = await repo.findStock(input.productId, input.toBuildingId);
    if (!to0) {
      throw new BizError(
        ERR.VALIDATION_FAILED,
        '调拨失败：目标楼栋未上架此商品，调拨不会顺手把它上架',
      );
    }

    // 先出后入。若"入"失败则把"出"冲正 —— 两格必须同生同灭
    const out = await repo.moveStock({
      productId: input.productId,
      buildingId: input.fromBuildingId,
      dStock: -input.qty,
      type: 'transfer_out',
      operator: input.operator ?? null,
      remark: `调拨至楼栋 ${input.toBuildingId}`,
    });
    if (!out.ok) throw new BizError(ERR.VALIDATION_FAILED, '调拨失败：调出楼栋可售不足');

    const into = await repo.moveStock({
      productId: input.productId,
      buildingId: input.toBuildingId,
      dStock: input.qty,
      type: 'transfer_in',
      operator: input.operator ?? null,
      remark: `由楼栋 ${input.fromBuildingId} 调入`,
    });
    if (!into.ok) {
      // 冲正，并留下流水 —— 不能悄悄抹掉刚才那一步
      await repo.moveStock({
        productId: input.productId,
        buildingId: input.fromBuildingId,
        dStock: input.qty,
        type: 'manual_adjust',
        operator: input.operator ?? null,
        remark: `调拨入失败自动冲正（目标楼栋异常）`,
      });
      throw new BizError(ERR.INTERNAL, '调拨失败：目标楼栋写入异常，已自动冲正');
    }
    return { ok: true as const, from: out.cell!, to: into.cell! };
  }

  /* ============================================================ 三、批量与同步（AC-10） */

  /**
   * 「同步上架」—— 把一个商品的**上下架状态**同步到多个楼栋。
   *
   * ⚠️ 我不改什么：**库存数值**。
   * AC-10 的硬要求：这两个动作在界面上是两张独立的卡，各自必须写明"我不改什么"，
   * 因为商户最容易的误操作就是"我点了个同步，结果把库存也覆盖了"。
   */
  async syncPublish(
    tenantCode: string,
    input: { productId: number; targetBuildingIds?: number[]; status: 'on' | 'off' },
  ): Promise<{
    affected: number;
    doesNotChange: string[];
    changed: Array<{ buildingId: number; buildingName: string; status: string }>;
    kept: Array<{ buildingId: number; buildingName: string; stock: number }>;
  }> {
    const repo = this.repo(tenantCode);
    const product = await repo.findProduct(input.productId);
    if (!product) throw BizError.notFound(ERR.NOT_FOUND, `商品不存在：${input.productId}`);

    const buildings = (await repo.listBuildings(false)).filter(
      (b) => !input.targetBuildingIds || input.targetBuildingIds.includes(b.id),
    );
    const changed: Array<{ buildingId: number; buildingName: string; status: string }> = [];
    const kept: Array<{ buildingId: number; buildingName: string; stock: number }> = [];

    for (const b of buildings) {
      const before = await repo.findStock(input.productId, b.id);
      const after = await repo.upsertStock(input.productId, b.id, { status: input.status });
      changed.push({ buildingId: b.id, buildingName: b.name, status: after.status });
      // 明确回报"库存原封不动"，让界面能把这句承诺显示出来
      kept.push({ buildingId: b.id, buildingName: b.name, stock: before?.stock ?? after.stock });
    }

    await this.repos.platform().appendAudit({
      tenantCode,
      actor: 'merchant',
      action: 'sync_publish',
      target: `product:${input.productId}`,
      detail: `同步上下架=${input.status}，影响 ${changed.length} 栋；未改库存数值`,
    });

    return {
      affected: changed.length,
      doesNotChange: ['库存数值', '低库存提醒线', '已售数量'],
      changed,
      kept,
    };
  }

  /**
   * 「同步库存数值」—— 把一个楼栋的**库存数值**复制到多个楼栋。
   *
   * ⚠️ 我不改什么：**上下架状态**。
   * 否则"同步库存"会顺手把别人单独下架的楼栋重新上架，商户会以为是灵异事件。
   */
  async syncStock(
    tenantCode: string,
    input: { productId: number; fromBuildingId: number; targetBuildingIds?: number[]; mode?: 'value' | 'delta' },
  ): Promise<{
    affected: number;
    doesNotChange: string[];
    from: { buildingId: number; stock: number };
    changed: Array<{ buildingId: number; buildingName: string; before: number; after: number; status: string }>;
    skipped: Array<{ buildingId: number; buildingName: string; reason: string }>;
  }> {
    const repo = this.repo(tenantCode);
    const product = await repo.findProduct(input.productId);
    if (!product) throw BizError.notFound(ERR.NOT_FOUND, `商品不存在：${input.productId}`);

    const src = await repo.findStock(input.productId, input.fromBuildingId);
    if (!src) throw BizError.notFound(ERR.NOT_FOUND, '来源楼栋尚未上架该商品，无可同步的库存');

    const buildings = (await repo.listBuildings(false)).filter(
      (b) => b.id !== input.fromBuildingId && (!input.targetBuildingIds || input.targetBuildingIds.includes(b.id)),
    );

    const changed: Array<{ buildingId: number; buildingName: string; before: number; after: number; status: string }> = [];
    const skipped: Array<{ buildingId: number; buildingName: string; reason: string }> = [];

    for (const b of buildings) {
      const cell = await repo.findStock(input.productId, b.id);
      // 未上架的楼栋不参与同步 —— 同步库存不该顺手把它上架
      if (!cell) {
        skipped.push({ buildingId: b.id, buildingName: b.name, reason: '该栋未上架此商品，同步库存不会顺手把它上架' });
        continue;
      }
      const before = cell.stock;
      const target = input.mode === 'delta' ? before + src.stock : src.stock;
      const r = await repo.moveStock({
        productId: input.productId,
        buildingId: b.id,
        dStock: target - before,
        type: 'manual_adjust',
        operator: 'sync',
        remark: `由楼栋 ${input.fromBuildingId} 同步库存（${input.mode === 'delta' ? '增量' : '覆盖'}）`,
      });
      if (!r.ok) {
        skipped.push({ buildingId: b.id, buildingName: b.name, reason: '同步后库存会为负，已跳过' });
        continue;
      }
      changed.push({
        buildingId: b.id,
        buildingName: b.name,
        before,
        after: r.cell!.stock,
        status: r.cell!.status,
      });
    }

    await this.repos.platform().appendAudit({
      tenantCode,
      actor: 'merchant',
      action: 'sync_stock',
      target: `product:${input.productId}`,
      detail: `由楼栋 ${input.fromBuildingId} 同步库存（${input.mode ?? 'value'}），影响 ${changed.length} 栋；未改上下架状态`,
    });

    return {
      affected: changed.length,
      doesNotChange: ['上下架状态', '已售数量', '预占数量'],
      from: { buildingId: input.fromBuildingId, stock: src.stock },
      changed,
      skipped,
    };
  }

  /** 一键配置全部楼栋（建商品后的常态操作：3 栋 × 50 SKU 从 150 次手工输入降到 1 次） */
  async bulkUpsert(
    tenantCode: string,
    input: { productId: number; buildingIds: number[]; stock?: number; status?: 'on' | 'off'; warnStock?: number | null },
  ) {
    const repo = this.repo(tenantCode);
    const product = await repo.findProduct(input.productId);
    if (!product) throw BizError.notFound(ERR.NOT_FOUND, `商品不存在：${input.productId}`);
    if (input.stock !== undefined && (!Number.isInteger(input.stock) || input.stock < 0)) {
      throw new BizError(ERR.VALIDATION_FAILED, '库存必须为非负整数');
    }

    let n = 0;
    for (const bid of input.buildingIds) {
      const cell = await repo.findStock(input.productId, bid);
      // 先改库存（走原语，必留流水），再改状态/提醒线（这两项不产生库存流水）
      if (input.stock !== undefined && cell) {
        const r = await repo.moveStock({
          productId: input.productId,
          buildingId: bid,
          dStock: input.stock - cell.stock,
          type: 'manual_adjust',
          operator: 'bulk',
          remark: '一键配置全部楼栋',
        });
        if (!r.ok) continue;
        n++;
      } else if (!cell) {
        // 格子还不存在 → 建格时直接给目标值（建格本身算一次人工调整）
        const r = await repo.moveStock({
          productId: input.productId,
          buildingId: bid,
          dStock: input.stock ?? 0,
          type: 'manual_adjust',
          operator: 'bulk',
          remark: '一键配置全部楼栋（该栋首次上架）',
        });
        if (!r.ok) continue;
        n++;
      }
      const patch: Partial<Pick<ProductStockRecord, 'status' | 'warnStock'>> = {};
      if (input.status !== undefined) patch.status = input.status;
      if (input.warnStock !== undefined) patch.warnStock = input.warnStock;
      if (Object.keys(patch).length) await repo.upsertStock(input.productId, bid, patch);
      if (input.stock === undefined) n++;
    }
    return { affected: n };
  }

  /* ============================================================ 四、流水与自检 */

  /** 库存流水（可按商品 / 楼栋过滤） */
  async logs(tenantCode: string, opts: { productId?: number; buildingId?: number; limit?: number } = {}) {
    return this.repo(tenantCode).listStockLogs(opts);
  }

  /**
   * 库存自洽核对 —— 这是"库存对得上"的可执行定义。
   *
   * 两条断言（任一条失败都说明有人绕过原语直接改了库存）：
   *   ① `stock === Σ 该格全部流水的 change`
   *      —— 流水记的是可售侧增量，可售值就是增量的累积。漏写一条流水，这个等式立刻不成立。
   *   ② `最后一条流水的 stockAfter === 当前 stock`
   *      —— 快照对不上说明"改了但没记"，或"记的顺序错了"。
   *
   * 注意 `locked` / `sold` 不参与求和：预占是 stock−− 与 locked++ 同时发生，
   * 而流水只记 stock 侧，所以把它们加进来反而会错。它们各自由
   * confirmPaid / release / returnOnRefund 的成对迁移保证守恒。
   */
  async reconcile(tenantCode: string, buildingId?: number) {
    const repo = this.repo(tenantCode);
    const stocks = await repo.listStocks(buildingId);
    const logs = await repo.listStockLogs({ limit: 100_000 });

    const byCell = new Map<string, { sum: number; count: number; lastAfter: number | null; lastId: number }>();
    for (const l of logs) {
      const k = `${l.productId}|${l.buildingId}`;
      const cur = byCell.get(k) ?? { sum: 0, count: 0, lastAfter: null, lastId: -1 };
      cur.sum += l.change;
      cur.count++;
      if (l.id > cur.lastId) {
        cur.lastId = l.id;
        cur.lastAfter = l.stockAfter;
      }
      byCell.set(k, cur);
    }

    const items = stocks.map((s) => {
      const agg = byCell.get(`${s.productId}|${s.buildingId}`) ?? { sum: 0, count: 0, lastAfter: null, lastId: -1 };
      const sumOk = s.stock === agg.sum;
      // 无流水且库存非 0 = 直接建格绕过了原语；有流水则快照必须对得上
      const snapshotOk = agg.count === 0 ? s.stock === 0 : agg.lastAfter === s.stock;
      return {
        productId: s.productId,
        buildingId: s.buildingId,
        stock: s.stock,
        locked: s.locked,
        sold: s.sold,
        logCount: agg.count,
        logSum: agg.sum,
        diff: s.stock - agg.sum,
        sumOk,
        snapshotOk,
        ok: sumOk && snapshotOk,
      };
    });

    const bad = items.filter((i) => !i.ok);
    return {
      items,
      /** 逐格核对未通过的数量 —— 必须为 0 */
      mismatch: bad.length,
      /** 有问题的格子（便于直接定位） */
      mismatched: bad,
      total: items.length,
    };
  }
}
