import { Inject, Injectable } from '@nestjs/common';
import { ERR, BizError } from '../core/errors';
import { REPO_FACTORY } from '../core/repo.factory';
import type { RepoFactory, TenantRepo } from '../core/repository';
import type { CategoryRecord, ProductRecord } from '../core/types';

/**
 * ProductService —— 商品与品类。
 *
 * 一条贯穿全系统的规矩：**价格全局统一，不按楼栋**（D11）。
 * 换栋就改价会让学生怀疑"同一袋薯片为什么 3 栋比 5 栋贵"，信任一旦裂了就补不回来。
 * 所以 `priceCents` 只存在商品上，库存格（SKU × 楼栋）里没有价格字段 ——
 * 这不是"暂时没做"，是结构上不允许。
 */
@Injectable()
export class ProductService {
  constructor(@Inject(REPO_FACTORY) private readonly repos: RepoFactory) {}

  private repo(tenantCode: string): TenantRepo {
    return this.repos.tenant(tenantCode);
  }

  listCategories(tenantCode: string): Promise<CategoryRecord[]> {
    return this.repo(tenantCode).listCategories();
  }

  listProducts(tenantCode: string, opts: { includeOff?: boolean } = {}): Promise<ProductRecord[]> {
    return this.repo(tenantCode).listProducts(opts);
  }

  async findProduct(tenantCode: string, id: number): Promise<ProductRecord> {
    const p = await this.repo(tenantCode).findProduct(id);
    if (!p) throw BizError.notFound(ERR.NOT_FOUND, `商品不存在：${id}`);
    return p;
  }

  async create(
    tenantCode: string,
    input: {
      name: string;
      spec?: string | null;
      cover?: string | null;
      priceCents: number;
      categoryId?: number | null;
      sort?: number;
      buildingIds?: number[];
    },
  ): Promise<ProductRecord> {
    const name = input.name?.trim();
    if (!name) throw new BizError(ERR.VALIDATION_FAILED, '商品名称不能为空');
    if (!Number.isInteger(input.priceCents) || input.priceCents <= 0) {
      throw new BizError(ERR.VALIDATION_FAILED, '价格必须为大于 0 的整数分');
    }
    if (input.priceCents > 100_000_00) {
      throw new BizError(ERR.VALIDATION_FAILED, '价格异常（上限 10 万元），请检查是否把元当成了分');
    }

    const repo = this.repo(tenantCode);
    const categories = await repo.listCategories();
    if (input.categoryId != null && !categories.some((c) => c.id === input.categoryId)) {
      throw new BizError(ERR.VALIDATION_FAILED, `品类不存在：${input.categoryId}`);
    }
    if (input.buildingIds?.length) {
      // includeDisabled=true：**已停用的楼栋也接受**。
      // 理由：停用只是"暂时不对外"，将来重新启用时如果商品配置丢了，
      // 商户要一栋栋重新配一遍 —— 那是我们造成的重复劳动，不是他的。
      const buildings = await repo.listBuildings(true);
      const known = new Set(buildings.map((b) => b.id));
      const bad = input.buildingIds.filter((id) => !known.has(id));
      if (bad.length) throw new BizError(ERR.VALIDATION_FAILED, `楼栋不存在：${bad.join(', ')}`);
    }

    return repo.createProduct({
      name,
      spec: input.spec?.trim() || null,
      cover: input.cover ?? null,
      priceCents: input.priceCents,
      categoryId: input.categoryId ?? null,
      sort: input.sort,
      buildingIds: input.buildingIds,
    });
  }

  async update(
    tenantCode: string,
    id: number,
    patch: Partial<Pick<ProductRecord, 'name' | 'spec' | 'cover' | 'priceCents' | 'categoryId' | 'sort' | 'status'>>,
  ): Promise<ProductRecord> {
    await this.findProduct(tenantCode, id);
    if (patch.name !== undefined && !patch.name.trim()) {
      throw new BizError(ERR.VALIDATION_FAILED, '商品名称不能为空');
    }
    if (patch.priceCents !== undefined && (!Number.isInteger(patch.priceCents) || patch.priceCents <= 0)) {
      throw new BizError(ERR.VALIDATION_FAILED, '价格必须为大于 0 的整数分');
    }
    const clean: typeof patch = { ...patch };
    if (clean.name !== undefined) clean.name = clean.name.trim();
    if (clean.spec !== undefined) clean.spec = clean.spec?.trim() || null;
    return this.repo(tenantCode).updateProduct(id, clean);
  }

  /** 全局下架 / 恢复 —— 与"某栋下架"是两件事，这里动的是全局状态位 */
  async setStatus(tenantCode: string, id: number, status: 'active' | 'off'): Promise<ProductRecord> {
    await this.findProduct(tenantCode, id);
    return this.repo(tenantCode).updateProduct(id, { status });
  }
}
