import { Inject, Injectable } from '@nestjs/common';
import { ERR, BizError } from '../core/errors';
import { REPO_FACTORY } from '../core/repo.factory';
import type { PlatformRepo, RepoFactory } from '../core/repository';
import type { TenantRecord, TenantStatus } from '../core/types';
import { LedgerService } from '../ledger/ledger.service';
import { DeployService } from './deploy.service';
import { PipelineService } from './pipeline.service';

/**
 * 租户管理服务（P-01 列表 / P-02 详情 / CP-07 停用恢复 / P-13 学校模板）。
 *
 * ## 关于 AC-13（房间号不出租户库）的一句设计说明
 *
 * 这里**没有任何一行代码去"过滤"房间号** —— 过滤是不需要的，因为这一层
 * 从头到尾就没读过租户库的订单表。平台侧看到的订单数据全部来自
 * `orderSummaries`（平台库里的账本侧投影：只有钱、没有人和地址）。
 *
 * 这个区别很重要：如果实现方式是"读出订单再删掉 roomNo 字段"，
 * 那么字段名一改（room_no / roomCode / dorm）过滤就静默失效了，
 * 而泄漏是无声的。**不读，就没有泄漏的可能。**
 */
@Injectable()
export class TenantAdminService {
  constructor(
    @Inject(REPO_FACTORY) private readonly repos: RepoFactory,
    private readonly ledger: LedgerService,
    private readonly pipeline: PipelineService,
    private readonly deploy: DeployService,
  ) {}

  private get platform(): PlatformRepo {
    return this.repos.platform();
  }

  /**
   * 租户详情。
   *
   * ⚠️ 本方法的出参会被控制器再过一道 `assertNoTenantPrivateFields` ——
   * 那不是多余的：这一层将来若有人"顺手"加一个订单明细进去，护栏会当场把它打回来。
   */
  async detail(tenantCode: string): Promise<Record<string, unknown>> {
    const t = await this.platform.findTenantByCode(tenantCode);
    if (!t) throw BizError.notFound(ERR.TENANT_NOT_FOUND, `租户不存在：${tenantCode}`);

    const [billing, buildings, pipeline, version, audits, summaries] = await Promise.all([
      this.ledger.billingView(tenantCode, { txnLimit: 20 }),
      this.repos.tenant(tenantCode).listBuildings(true),
      this.pipeline.ofTenant(tenantCode),
      this.deploy.ofTenant(tenantCode),
      this.platform.listAudits({ tenantCode, limit: 30 }),
      this.platform.listOrderSummaries(tenantCode, 50),
    ]);

    const gmvCents = summaries.reduce((s, o) => s + o.amountCents, 0);
    const feeCents = summaries.reduce((s, o) => s + o.feeCents, 0);

    return {
      basic: {
        tenantCode: t.tenantCode,
        shopName: t.shopName,
        orgName: t.orgName,
        appid: t.appid,
        mchId: t.mchId,
        region: t.region,
        contactName: t.contactName,
        contactPhone: t.contactPhone,
        dbName: t.dbName,
        status: t.status,
        createdAt: t.createdAt,
      },
      // 两个闸门**必须同屏**：只显示余额会让"订阅早过期了"这件事隐形（§3.4）
      gates: billing,
      // 楼栋只到楼栋级 —— 楼层 / 房间号属于租户库，平台侧不需要也不该看到
      buildings: buildings.map((b) => ({
        id: b.id,
        code: b.code,
        name: b.name,
        status: b.status,
        deliveryEnabled: b.deliveryEnabled,
        sort: b.sort,
      })),
      // 订单汇总：只有钱没有人和地址
      orderSummary: {
        orderCount: summaries.length,
        gmvCents,
        feeCents,
        // 抽查用的最近若干单，字段显式列出（不是 `...o` 展开）——
        // 展开的写法会让"投影多了一个字段"变成静默泄漏
        recent: summaries.slice(0, 20).map((o) => ({
          orderNo: o.orderNo,
          amountCents: o.amountCents,
          feeCents: o.feeCents,
          status: o.status,
          buildingCode: o.buildingCode,
          paidAt: o.paidAt,
          refundCents: o.refundCents,
        })),
      },
      pipeline,
      version,
      audits,
    };
  }

  /**
   * 强制停用 / 恢复（CP-07）。
   *
   * 停用是"立即锁单 + 前台提示"，**不是删数据**：
   * 数据保留是为了"恢复后还能接着用"，也让商户的账目与历史订单不会凭空消失。
   */
  async setStatus(tenantCode: string, action: 'suspend' | 'recover', reason: string | null, operator: string): Promise<TenantRecord> {
    const t = await this.platform.findTenantByCode(tenantCode);
    if (!t) throw BizError.notFound(ERR.TENANT_NOT_FOUND, `租户不存在：${tenantCode}`);

    const next: TenantStatus = action === 'suspend' ? 'suspended' : 'active';
    if (action === 'suspend' && t.status === 'suspended') {
      throw new BizError(ERR.VALIDATION_FAILED, `${t.shopName} 已经是停用状态`);
    }
    if (action === 'recover' && t.status === 'active') {
      throw new BizError(ERR.VALIDATION_FAILED, `${t.shopName} 已经是启用状态`);
    }
    if (action === 'suspend' && !String(reason ?? '').trim()) {
      // 停用商户是会影响人家生意的动作，"随手停一下"必须留下理由
      throw new BizError(ERR.VALIDATION_FAILED, '停用必须填写原因 —— 恢复时才知道当初为什么停');
    }

    const out = await this.platform.setTenantStatus(tenantCode, next);
    await this.platform.appendAudit({
      tenantCode,
      actor: operator,
      action: action === 'suspend' ? 'tenant.suspend' : 'tenant.recover',
      target: tenantCode,
      detail: reason ?? null,
    });
    return out;
  }

  /* ------------------------------------------------------- 学校与楼栋模板 */

  async listSchoolsWithTemplates(): Promise<Array<{ id: number; name: string; region: string; city: string | null; buildings: Array<{ id: number; name: string; sort: number }>; tenantCount: number }>> {
    const [schools, tenants] = await Promise.all([this.platform.listSchools(), this.platform.listTenants()]);
    return Promise.all(
      schools.map(async (s) => ({
        id: s.id,
        name: s.name,
        region: s.region,
        city: s.city,
        buildings: (await this.platform.listBuildingTemplates(s.id)).sort((a, b) => a.sort - b.sort || a.id - b.id),
        tenantCount: tenants.filter((t) => t.schoolId === s.id).length,
      })),
    );
  }

  async saveSchool(input: { id?: number; name: string; region: string; city?: string | null; buildingNames?: string[] }): Promise<{ id: number; name: string }> {
    const name = String(input.name ?? '').trim();
    const region = String(input.region ?? '').trim();
    if (!name) throw new BizError(ERR.VALIDATION_FAILED, '学校名称不能为空');
    if (!region) throw new BizError(ERR.VALIDATION_FAILED, '地区不能为空');

    const school = await this.platform.upsertSchool({
      id: input.id,
      name,
      region,
      city: input.city ?? null,
    });
    if (input.buildingNames) {
      // 整体替换 —— 模板只是建租户时的**初始值**，改动不影响已建租户的楼栋
      await this.platform.replaceBuildingTemplates(school.id, input.buildingNames.map((n) => String(n).trim()).filter(Boolean));
    }
    await this.platform.appendAudit({
      actor: 'platform',
      action: 'school.upsert',
      target: String(school.id),
      detail: `${name}（${region}）楼栋 ${input.buildingNames?.length ?? '未改'}`,
    });
    return { id: school.id, name: school.name };
  }

  /**
   * 删除学校模板。
   *
   * 已有租户引用时**拒绝删除**：学校字典是模板来源，删掉之后
   * 那些租户的 `school_id` 会指向一个不存在的行 —— 详情页显示空白，
   * 而没人会想到"是模板被删了"。
   */
  async deleteSchool(id: number): Promise<{ deleted: boolean; blockedBy?: number }> {
    const tenants = await this.platform.listTenants();
    const used = tenants.filter((t) => t.schoolId === id);
    if (used.length) {
      return { deleted: false, blockedBy: used.length };
    }
    const ok = await this.platform.deleteSchool(id);
    return { deleted: ok };
  }
}
