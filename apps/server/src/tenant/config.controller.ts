import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { narrowBusinessHours, cutoffOf, parseHHmm } from '../core/config-resolver';
import { ERR, BizError } from '../core/errors';
import { assertNoTenantPrivateFields } from '../core/logger';
import { OwnerWriteGuard } from '../core/owner.guard';
import { tenantOf } from '../core/tenant-scope';
import { REPO_FACTORY } from '../core/repo.factory';
import type { RepoFactory } from '../core/repository';
import { evaluateOrderGate, localMinutesOf } from '../core/time-window';
import { CENTS } from '../core/types';
import { TenantService } from '../platform/tenant.service';
import { BuildingService } from './building.service';

/**
 * 配置下发（§2.3 配置优先原则）
 *
 * 「凡是能配置的，绝不要写进代码」—— 这个接口是那条铁律的落地点：
 * 商户日常运营（改价、改库存、加楼栋、调配送费、改时间窗）全部走它，**100% 不需要发版**。
 * 只有"业务规则变了、页面结构变了"才发版，目标频率每学期 1–3 次。
 */
@Controller('t/:tenantCode/api/config')
@UseGuards(OwnerWriteGuard)
export class ConfigController {
  constructor(
    @Inject(REPO_FACTORY) private readonly repos: RepoFactory,
    private readonly tenants: TenantService,
    private readonly buildings: BuildingService,
  ) {}

  @Get()
  async get(@Param('tenantCode') tenantCode: string, @Query('buildingId') buildingId?: string) {
    const t = tenantOf(tenantCode);
    const repo = this.repos.tenant(t);
    const shop = await repo.getShopConfig();
    const sub = await this.repos.platform().getSubscription(t);
    const wallet = await this.repos.platform().getWallet(t);

    const list = await this.buildings.listActiveResolved(t);
    const minutes = localMinutesOf(new Date());
    const current = buildingId ? list.find((b) => b.buildingId === Number(buildingId)) : undefined;

    const payload = {
      tenantCode: t,
      shop: {
        shopName: shop.shopName,
        logoUrl: shop.logoUrl,
        announcement: shop.announcement,
        themeScale: shop.themeScale,
        contactPhone: shop.contactPhone,
        shopOpen: shop.shopOpen,
        // 起送价与配送费：**商户设置页要回显当前值**，只给"能改"不给"现在是多少"，
        // 商户就只能凭记忆填 —— 而填错的代价是全场订单直接变了价
        minAmountCents: shop.minAmountCents,
        deliveryFeeCents: shop.deliveryFeeCents,
        themeNotice: shop.themeNotice,
        openTime: shop.openTime,
        closeTime: shop.closeTime,
        accessibleFrom: shop.accessibleFrom,
        accessibleTo: shop.accessibleTo,
        cutoffLeadMinutes: shop.cutoffLeadMinutes,
      },
      // 楼栋清单随配置下发 → 新增楼栋立即生效，不发版
      buildings: list,
      singleBuildingMode: list.length <= 1,
      gates: {
        subscriptionValid: !!sub?.periodEnd && new Date(sub.periodEnd).getTime() > Date.now(),
        subscriptionEndsAt: sub?.periodEnd ?? null,
        balanceOk: (wallet?.balanceCents ?? 0) > (wallet?.creditLimitCents ?? CENTS.CREDIT_LIMIT),
        balanceCents: wallet?.balanceCents ?? 0,
      },
      serverMinutesOfDay: minutes,
      /** 由服务端下发"现在几点" —— 前端本地时间只用于平滑倒计时，不作为判定依据（AC-14） */
      serverTime: new Date().toISOString(),
    };

    // 这个接口学生端直接可见 —— 出参绝不允许出现房间号 / 楼层
    const leaks = assertNoTenantPrivateFields(payload);
    if (leaks.length) throw new Error(`config 出参含租户私有字段，已阻断：${leaks.join(', ')}`);

    return payload;
  }

  /** 单楼栋此刻能否下单（服务端判定，AC-14） */
  @Get('gate')
  async gate(@Param('tenantCode') tenantCode: string, @Query('buildingId') buildingId: string) {
    const t = tenantOf(tenantCode);
    if (!buildingId) throw new BizError(ERR.VALIDATION_FAILED, '缺少 buildingId');
    return this.tenants.orderGateOf(t, Number(buildingId));
  }

  /** 保存店铺配置（含主题色护栏） */
  @Post()
  async save(
    @Param('tenantCode') tenantCode: string,
    @Body()
    body: Partial<{
      shopName: string;
      logoUrl: string | null;
      announcement: string | null;
      openTime: string | null;
      closeTime: string | null;
      minAmountCents: number;
      deliveryFeeCents: number;
      accessibleFrom: string | null;
      accessibleTo: string | null;
      cutoffLeadMinutes: number;
      contactPhone: string | null;
      shopOpen: boolean;
      themeColor: string;
    }>,
  ) {
    const t = tenantOf(tenantCode);
    const repo = this.repos.tenant(t);

    if (body.themeColor) {
      // 主题色不允许直通 —— 必须过 AC-06 护栏
      await this.tenants.setThemeColor(t, body.themeColor);
      delete (body as Record<string, unknown>).themeColor;
    }

    const patch: Record<string, unknown> = {};
    for (const k of [
      'shopName', 'announcement', 'openTime', 'closeTime', 'minAmountCents',
      'deliveryFeeCents', 'accessibleFrom', 'accessibleTo', 'cutoffLeadMinutes',
      'contactPhone', 'shopOpen', 'logoUrl',
    ] as const) {
      if (body[k] !== undefined) patch[k] = body[k];
    }

    // 营业时间必须落在门禁窗口内 —— 超出部分自动截断，界面上是"帮你改了"而非"你错了"
    if (patch.openTime !== undefined || patch.closeTime !== undefined || patch.accessibleFrom !== undefined || patch.accessibleTo !== undefined) {
      const cur = await repo.getShopConfig();
      const win = narrowBusinessHours(
        (patch.openTime ?? cur.openTime) as string | null,
        (patch.closeTime ?? cur.closeTime) as string | null,
        (patch.accessibleFrom ?? cur.accessibleFrom ?? '06:30') as string,
        (patch.accessibleTo ?? cur.accessibleTo ?? '22:30') as string,
      );
      patch.openTime = win.openTime;
      patch.closeTime = win.closeTime;
      patch.businessHoursNarrowed = undefined;
      void win;
    }

    const saved = await repo.saveShopConfig(patch as never);
    return {
      saved,
      cutoffTime: cutoffOf(saved.accessibleTo ?? '22:30', saved.cutoffLeadMinutes),
    };
  }
}

/**
 * 时间窗配置（CW-06）
 * 商户设门禁窗 → 系统自动算截单时间。**截单时间算出来、不可直填**（设计决策 6）：
 * 允许直填就等于允许"下了单送不到"，一条这样的订单够学生在群里骂一晚。
 */
@Controller('t/:tenantCode/api/time-window')
@UseGuards(OwnerWriteGuard)
export class TimeWindowController {
  constructor(
    @Inject(REPO_FACTORY) private readonly repos: RepoFactory,
    private readonly buildings: BuildingService,
  ) {}

  /** 预览：给定门禁窗与在途时间，算出截单时间与是否被截断 */
  @Get('preview')
  async preview(
    @Param('tenantCode') tenantCode: string,
    @Query('accessibleFrom') accessibleFrom?: string,
    @Query('accessibleTo') accessibleTo?: string,
    @Query('leadMinutes') leadMinutes?: string,
  ) {
    const t = tenantOf(tenantCode);
    const shop = await this.repos.tenant(t).getShopConfig();
    const from = accessibleFrom ?? shop.accessibleFrom ?? '06:30';
    const to = accessibleTo ?? shop.accessibleTo ?? '22:30';
    const lead = leadMinutes !== undefined ? Number(leadMinutes) : shop.cutoffLeadMinutes;

    if (parseHHmm(from) === null || parseHHmm(to) === null) {
      throw new BizError(ERR.VALIDATION_FAILED, '时间格式必须为 HH:mm');
    }
    if (Number.isNaN(lead) || lead < 0 || lead > 240) {
      throw new BizError(ERR.VALIDATION_FAILED, '在途预留时间需在 0–240 分钟之间');
    }

    const narrowed = narrowBusinessHours(shop.openTime, shop.closeTime, from, to);
    const cutoff = cutoffOf(to, lead);
    const gate = evaluateOrderGate({
      shopOpen: shop.shopOpen,
      buildingStatus: 'active',
      buildingDeliveryEnabled: true,
      subscriptionValid: true,
      balanceCents: 10000,
      creditLimitCents: CENTS.CREDIT_LIMIT,
      openTime: narrowed.openTime,
      closeTime: narrowed.closeTime,
      accessibleFrom: from,
      accessibleTo: to,
      cutoffTime: cutoff,
    });

    return {
      accessibleFrom: from,
      accessibleTo: to,
      leadMinutes: lead,
      cutoffTime: cutoff,
      /** 三层嵌套关系：门禁 ⊃ 营业时间 ⊃ 可下单区间 */
      layers: {
        gate: { from, to },
        business: { from: narrowed.openTime, to: narrowed.closeTime },
        orderable: { from: narrowed.openTime, to: cutoff },
      },
      businessHoursNarrowed: narrowed.narrowed,
      narrowedNotice: narrowed.narrowed ? '已按门禁时间自动收窄营业时间' : null,
      currentGate: gate,
    };
  }

  /** 一键配置全部楼栋（§4.3 常态操作）：填一次覆盖所有启用楼栋，只在需要差异时改单个楼栋 */
  @Post('bulk')
  async bulk(
    @Param('tenantCode') tenantCode: string,
    @Body()
    body: {
      accessibleFrom?: string | null;
      accessibleTo?: string | null;
      minAmountCents?: number | null;
      deliveryFeeCents?: number | null;
      notice?: string | null;
      clearOverrideKeys?: string[];
    },
  ) {
    const t = tenantOf(tenantCode);
    const affected = await this.repos.tenant(t).applyBulkConfig({
      minAmountCents: body.minAmountCents,
      deliveryFeeCents: body.deliveryFeeCents,
      accessibleFrom: body.accessibleFrom,
      accessibleTo: body.accessibleTo,
      notice: body.notice,
      clearOverrideKeys: body.clearOverrideKeys,
    });
    const list = await this.buildings.listActiveResolved(t);
    return {
      affected,
      buildings: list.map((b) => ({
        buildingCode: b.buildingCode,
        buildingName: b.buildingName,
        minAmountCents: b.minAmountCents,
        deliveryFeeCents: b.deliveryFeeCents,
        accessibleFrom: b.accessibleFrom,
        accessibleTo: b.accessibleTo,
        cutoffTime: b.cutoffTime,
        source: b.source,
      })),
    };
  }
}
