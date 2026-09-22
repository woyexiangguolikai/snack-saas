import { Inject, Injectable } from '@nestjs/common';
import { resolveBuildingConfig } from '../core/config-resolver';
import { ERR, BizError } from '../core/errors';
import { REPO_FACTORY } from '../core/repo.factory';
import type { RepoFactory } from '../core/repository';
import type { BuildingConfigOverride, BuildingRecord, ResolvedBuildingConfig } from '../core/types';

@Injectable()
export class BuildingService {
  constructor(@Inject(REPO_FACTORY) private readonly repos: RepoFactory) {}

  private repo(tenantCode: string) {
    return this.repos.tenant(tenantCode);
  }

  /** 后台视图：含停用楼栋（停用不可删，历史订单仍要能查） */
  async listWithResolved(tenantCode: string): Promise<{
    buildings: Array<BuildingRecord & { resolved: ResolvedBuildingConfig }>;
    singleBuildingMode: boolean;
  }> {
    const repo = this.repo(tenantCode);
    const shop = await repo.getShopConfig();
    const buildings = await repo.listBuildings(true);
    const active = buildings.filter((b) => b.status === 'active');
    return {
      buildings: buildings.map((b) => ({ ...b, resolved: resolveBuildingConfig(b, shop) })),
      singleBuildingMode: active.length <= 1,
    };
  }

  /** 学生端视图：只给启用楼栋 */
  async listActiveResolved(tenantCode: string): Promise<ResolvedBuildingConfig[]> {
    const repo = this.repo(tenantCode);
    const shop = await repo.getShopConfig();
    const buildings = await repo.listBuildings(false);
    return buildings.map((b) => resolveBuildingConfig(b, shop));
  }

  async create(
    tenantCode: string,
    dto: { name: string; sort?: number; configOverride?: BuildingConfigOverride | null },
  ): Promise<BuildingRecord> {
    const name = String(dto.name ?? '').trim();
    if (!name) throw new BizError(ERR.VALIDATION_FAILED, '楼栋名不能为空');
    if (name.length > 32) throw new BizError(ERR.VALIDATION_FAILED, '楼栋名不能超过 32 字');
    const b = await this.repo(tenantCode).createBuilding({
      name,
      sort: dto.sort,
      configOverride: (dto.configOverride ?? null) as Record<string, unknown> | null,
    });
    // 新增楼栋**立即生效**：楼栋清单走配置下发，学生端下次打开就能选到，无需发版（§4.2）
    return b;
  }

  async update(
    tenantCode: string,
    id: number,
    dto: Partial<{
      name: string;
      sort: number;
      deliveryEnabled: boolean;
      notice: string | null;
      minAmountCents: number | null;
      deliveryFeeCents: number | null;
      accessibleFrom: string | null;
      accessibleTo: string | null;
      configOverride: BuildingConfigOverride | null;
    }>,
  ): Promise<BuildingRecord> {
    const repo = this.repo(tenantCode);
    const cur = await repo.findBuilding(id);
    if (!cur) throw BizError.notFound(ERR.BUILDING_NOT_FOUND, `楼栋不存在：${id}`);

    const patch: Partial<BuildingRecord> = {};
    if (dto.name !== undefined) {
      const name = String(dto.name).trim();
      if (!name) throw new BizError(ERR.VALIDATION_FAILED, '楼栋名不能为空');
      patch.name = name;
    }
    if (dto.sort !== undefined) patch.sort = Number(dto.sort);
    if (dto.deliveryEnabled !== undefined) patch.deliveryEnabled = !!dto.deliveryEnabled;
    if (dto.notice !== undefined) patch.notice = dto.notice;
    if (dto.minAmountCents !== undefined) patch.minAmountCents = dto.minAmountCents;
    if (dto.deliveryFeeCents !== undefined) patch.deliveryFeeCents = dto.deliveryFeeCents;
    if (dto.accessibleFrom !== undefined) patch.accessibleFrom = dto.accessibleFrom;
    if (dto.accessibleTo !== undefined) patch.accessibleTo = dto.accessibleTo;
    if (dto.configOverride !== undefined) {
      patch.configOverride = (dto.configOverride ?? null) as BuildingRecord['configOverride'];
    }
    return repo.updateBuilding(id, patch);
  }

  /** 停用：前台不可选、新订单不可用；**历史订单与流水完整保留**（§4.8） */
  async disable(tenantCode: string, id: number): Promise<BuildingRecord> {
    const repo = this.repo(tenantCode);
    const cur = await repo.findBuilding(id);
    if (!cur) throw BizError.notFound(ERR.BUILDING_NOT_FOUND, `楼栋不存在：${id}`);
    if (cur.isDefault) {
      throw new BizError(ERR.VALIDATION_FAILED, '默认楼栋不可停用（单楼栋商户的唯一门店）');
    }
    return repo.disableBuilding(id);
  }

  /**
   * 删除楼栋 —— **一律拒绝**。
   * 被历史订单 / 库存流水引用后删除，会导致订单、流水、报表全部对不上（§4.8）。
   * 这里不是"权限不够"，是产品决定了这条路径不存在。
   */
  async remove(_tenantCode: string, id: number): Promise<never> {
    throw BizError.forbidden(
      ERR.BUILDING_DELETE_FORBIDDEN,
      `楼栋 #${id} 不能删除：已产生历史订单与库存流水，删除会导致对账不一致。请改用「停用」。`,
    );
  }
}
