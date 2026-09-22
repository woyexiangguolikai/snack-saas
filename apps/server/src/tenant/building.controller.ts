import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { OwnerWriteGuard } from '../core/owner.guard';
import { tenantOf } from '../core/tenant-scope';
import { BuildingService } from './building.service';
import type { BuildingConfigOverride } from '../core/types';

/**
 * 楼栋接口。**读放开、写要店主身份**（OwnerWriteGuard）：
 * 读接口学生端也要用（选楼栋），写接口只有商户能做。
 *
 * 在这道守卫之前，只有租户校验 —— 于是**任何学生令牌都能改店铺配置**：
 * 把配送费改成 0、把楼栋停掉、把营业时间改掉，而且改动不留痕。
 */
@Controller('t/:tenantCode/api/buildings')
@UseGuards(OwnerWriteGuard)
export class BuildingController {
  constructor(private readonly buildings: BuildingService) {}

  /** 后台视图：含停用楼栋 + 每个字段是「继承店铺」还是「本栋覆盖」 */
  @Get()
  async list(@Param('tenantCode') tenantCode: string) {
    return this.buildings.listWithResolved(tenantOf(tenantCode));
  }

  @Post()
  async create(
    @Param('tenantCode') tenantCode: string,
    @Body() body: { name: string; sort?: number; configOverride?: BuildingConfigOverride | null },
  ) {
    return this.buildings.create(tenantOf(tenantCode), body);
  }

  @Patch(':id')
  async update(
    @Param('tenantCode') tenantCode: string,
    @Param('id', ParseIntPipe) id: number,
    @Body()
    body: Partial<{
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
  ) {
    return this.buildings.update(tenantOf(tenantCode), id, body);
  }

  /** 停用（前台不可选，历史订单完整保留） */
  @Post(':id/disable')
  async disable(@Param('tenantCode') tenantCode: string, @Param('id', ParseIntPipe) id: number) {
    return this.buildings.disable(tenantOf(tenantCode), id);
  }

  /** 删除 —— 一律 403。楼栋只能停用，不能删除（§4.8） */
  @Delete(':id')
  async remove(@Param('tenantCode') tenantCode: string, @Param('id', ParseIntPipe) id: number) {
    return this.buildings.remove(tenantOf(tenantCode), id);
  }
}
