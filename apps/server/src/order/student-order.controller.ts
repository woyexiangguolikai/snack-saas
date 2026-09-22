import {
  Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseIntPipe, Patch, Post, Query,
} from '@nestjs/common';
import { ERR, BizError } from '../core/errors';
import { requireUserId } from '../core/logger';
import { REPO_FACTORY } from '../core/repo.factory';
import type { RepoFactory } from '../core/repository';
import { tenantOf } from '../core/tenant-scope';
import { OrderService } from './order.service';

/**
 * 学生端订单接口。
 *
 * 全部要求**已登录**（`requireUserId`）—— 浏览可以匿名，下单不行。
 * 这也是"先看再登录"能成立的前提：不登录时这些接口一律 401，
 * 而不是把订单挂到一个匿名身份上。
 */
@Controller('t/:tenantCode/api/orders')
export class StudentOrderController {
  constructor(private readonly orders: OrderService) {}

  /** 提交订单。`clientKey` 是客户端生成的幂等键，重复提交返回同一单。 */
  @Post()
  async place(
    @Param('tenantCode') tenantCode: string,
    @Body()
    body: {
      buildingId: number;
      addressId?: number | null;
      items?: Array<{ productId: number; qty: number }>;
      remark?: string | null;
      clientKey?: string | null;
    },
  ) {
    const t = tenantOf(tenantCode);
    const userId = requireUserId();
    if (!body?.buildingId) throw new BizError(ERR.VALIDATION_FAILED, '缺少 buildingId');

    return this.orders.placeOrder(t, {
      userId,
      buildingId: Number(body.buildingId),
      addressId: body.addressId ? Number(body.addressId) : null,
      clientKey: body.clientKey ?? null,
      lines: body.items ?? [],
      remark: body.remark ?? null,
    });
  }

  /** 我的订单。`status=ongoing` 进行中 / `done` 已结束；同时返回两个分栏的计数 */
  @Get()
  async list(
    @Param('tenantCode') tenantCode: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    const t = tenantOf(tenantCode);
    const userId = requireUserId();
    return this.orders.studentOrders(t, userId, {
      status,
      limit: limit ? Number(limit) : undefined,
    });
  }

  /** 订单详情（含本人房间号与"此刻可做的动作"，前端据此决定按钮可用性） */
  @Get(':orderNo')
  async detail(@Param('tenantCode') tenantCode: string, @Param('orderNo') orderNo: string) {
    const t = tenantOf(tenantCode);
    const userId = requireUserId();
    return this.orders.studentOrderDetail(t, userId, orderNo);
  }

  /** 学生取消（仅未支付）。已支付的单只能由商户走退款，见状态机的不变量 ①。 */
  @Post(':orderNo/cancel')
  @HttpCode(200)
  async cancel(
    @Param('tenantCode') tenantCode: string,
    @Param('orderNo') orderNo: string,
    @Body() body: { reason?: string },
  ) {
    const t = tenantOf(tenantCode);
    const userId = requireUserId();
    return { order: await this.orders.cancelByStudent(t, orderNo, userId, body?.reason ?? '学生取消') };
  }

  /**
   * 发起支付（取 JSAPI 参数）。
   *
   * 未配置商户号时返回 `configured:false` 而非报错 —— 那是正常的中间状态，
   * 前端据此显示"订单已保留"，而不是把学生推进通用错误页。
   */
  @Post(':orderNo/pay')
  @HttpCode(200)
  async pay(
    @Param('tenantCode') tenantCode: string,
    @Param('orderNo') orderNo: string,
  ) {
    const t = tenantOf(tenantCode);
    return this.orders.createPrepay(t, orderNo, requireUserId());
  }

  /**
   * 开发用：模拟支付成功。
   * 走的是与真实回调**完全相同**的内部路径（金额校验 + 条件写 + 三件副作用），
   * 所以它验证的是真链路，而不是一个"改了状态就返回"的假口子。
   */
  @Post(':orderNo/pay/simulate')
  @HttpCode(200)
  async simulatePay(
    @Param('tenantCode') tenantCode: string,
    @Param('orderNo') orderNo: string,
  ) {
    const t = tenantOf(tenantCode);
    return this.orders.simulatePay(t, orderNo, requireUserId());
  }
}

/**
 * 地址簿。
 *
 * ⚠️ 地址的楼栋**不决定订单楼栋** —— 它只用于在提交订单时做跨楼栋校验（CS-10）。
 * 这条如果被误解成"选了地址就用地址的楼栋"，跨楼栋拦截就会失效，
 * 于是货会送到学生不在的那栋楼。
 */
@Controller('t/:tenantCode/api/addresses')
export class AddressController {
  constructor(@Inject(REPO_FACTORY) private readonly repos: RepoFactory) {}

  @Get()
  async list(@Param('tenantCode') tenantCode: string) {
    const t = tenantOf(tenantCode);
    return { items: await this.repos.tenant(t).listAddresses(requireUserId()) };
  }

  @Post()
  async create(
    @Param('tenantCode') tenantCode: string,
    @Body()
    body: {
      buildingId: number;
      floor?: string | null;
      room: string;
      contact?: string | null;
      phone?: string | null;
      tag?: string | null;
      isDefault?: boolean;
    },
  ) {
    const t = tenantOf(tenantCode);
    const userId = requireUserId();
    const repo = this.repos.tenant(t);

    const building = await repo.findBuilding(Number(body?.buildingId));
    if (!building) throw BizError.notFound(ERR.BUILDING_NOT_FOUND, `楼栋不存在：${body?.buildingId}`);

    // 房间号各校格式不一（302 / 3-302 / A302），不做正则强校验，
    // 只要求非空且长度合理 —— 强校验会把真实存在的写法挡在外面
    const room = String(body?.room ?? '').trim();
    if (!room) throw new BizError(ERR.VALIDATION_FAILED, '请填写房间号');
    if (room.length > 32) throw new BizError(ERR.VALIDATION_FAILED, '房间号过长');

    const existing = await repo.listAddresses(userId);
    return {
      address: await repo.createAddress({
        userId,
        buildingId: building.id,
        floor: body.floor?.trim() || null,
        room,
        contact: body.contact?.trim() || null,
        phone: body.phone?.trim() || null,
        tag: body.tag?.trim() || null,
        // 第一条地址自动成为默认，否则学生要多点一次"设为默认"
        isDefault: body.isDefault ?? existing.length === 0,
      }),
    };
  }

  @Patch(':id')
  async update(
    @Param('tenantCode') tenantCode: string,
    @Param('id', ParseIntPipe) id: number,
    @Body()
    body: Partial<{
      buildingId: number; floor: string | null; room: string;
      contact: string | null; phone: string | null; tag: string | null; isDefault: boolean;
    }>,
  ) {
    const t = tenantOf(tenantCode);
    const userId = requireUserId();
    const repo = this.repos.tenant(t);

    if (body.buildingId !== undefined) {
      const b = await repo.findBuilding(Number(body.buildingId));
      if (!b) throw BizError.notFound(ERR.BUILDING_NOT_FOUND, `楼栋不存在：${body.buildingId}`);
      body.buildingId = b.id;
    }
    if (body.room !== undefined && !String(body.room).trim()) {
      throw new BizError(ERR.VALIDATION_FAILED, '房间号不能为空');
    }
    return { address: await repo.updateAddress(userId, id, body as never) };
  }

  @Delete(':id')
  @HttpCode(200)
  async remove(@Param('tenantCode') tenantCode: string, @Param('id', ParseIntPipe) id: number) {
    const t = tenantOf(tenantCode);
    const userId = requireUserId();
    const repo = this.repos.tenant(t);
    const addr = await repo.findAddress(userId, id);
    if (!addr) throw BizError.notFound(ERR.ADDRESS_NOT_FOUND, '地址不存在');
    await repo.deleteAddress(userId, id);
    return { deleted: id };
  }
}
