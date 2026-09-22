import { Inject, Injectable } from '@nestjs/common';
import { ERR, BizError } from '../core/errors';
import { REPO_FACTORY } from '../core/repo.factory';
import type { PlatformRepo, RepoFactory } from '../core/repository';
import type { TicketCategory, TicketRecord, TicketStatus } from '../core/types';

/**
 * 工单服务（P-11 / CP-09）。
 *
 * 存在的意义只有一句话：**分类决定流向**。
 * 技术问题归我方，经营问题归合伙人 —— 没有分类字段的话，
 * 所有工单都会堆在同一个池子里，然后合伙人开始处理"推送失败"这种他做不了的事。
 */
@Injectable()
export class TicketService {
  constructor(@Inject(REPO_FACTORY) private readonly repos: RepoFactory) {}

  private get platform(): PlatformRepo {
    return this.repos.platform();
  }

  async create(input: {
    tenantCode?: string | null;
    title: string;
    category: TicketCategory;
    createdBy?: string;
    detail?: string;
  }): Promise<TicketRecord> {
    const title = String(input.title ?? '').trim();
    if (!title) throw new BizError(ERR.VALIDATION_FAILED, '工单标题不能为空');
    const allowed: TicketCategory[] = ['tech', 'operation', 'billing', 'other'];
    if (!allowed.includes(input.category)) {
      throw new BizError(ERR.VALIDATION_FAILED, `工单分类必须是 ${allowed.join(' / ')} 之一`);
    }

    const t = await this.platform.createTicket({
      tenantCode: input.tenantCode ?? null,
      title,
      category: input.category,
      createdBy: input.createdBy ?? 'platform',
    });
    if (input.detail?.trim()) {
      await this.platform.appendTicketLog(t.id, { by: t.createdBy, text: input.detail.trim() });
    }
    return t;
  }

  async list(opts: { status?: TicketStatus; tenantCode?: string } = {}): Promise<{
    items: Array<TicketRecord & { shopName: string | null }>;
    summary: Record<TicketStatus | 'partner', number>;
  }> {
    const [tickets, tenants] = await Promise.all([this.platform.listTickets(opts), this.platform.listTenants()]);
    const nameOf = new Map(tenants.map((t) => [t.tenantCode, t.shopName]));
    const items = tickets.map((t) => ({ ...t, shopName: t.tenantCode ? (nameOf.get(t.tenantCode) ?? null) : null }));
    return {
      items,
      summary: {
        open: items.filter((i) => i.status === 'open').length,
        doing: items.filter((i) => i.status === 'doing').length,
        closed: items.filter((i) => i.status === 'closed').length,
        // 合伙人手里的单 —— 这一项是给"分流"看的，不是给统计看的
        partner: items.filter((i) => i.assignee === 'partner' && i.status !== 'closed').length,
      },
    };
  }

  async detail(id: number): Promise<TicketRecord & { shopName: string | null }> {
    const t = await this.platform.findTicket(id);
    if (!t) throw BizError.notFound(ERR.VALIDATION_FAILED, `工单不存在：${id}`);
    const tenants = await this.platform.listTenants();
    return {
      ...t,
      shopName: t.tenantCode ? (tenants.find((x) => x.tenantCode === t.tenantCode)?.shopName ?? null) : null,
    };
  }

  async append(
    id: number,
    log: { by: string; text: string },
    patch?: { status?: TicketStatus; assignee?: 'platform' | 'partner' },
  ): Promise<TicketRecord> {
    const text = String(log.text ?? '').trim();
    if (!text) throw new BizError(ERR.VALIDATION_FAILED, '处理记录不能为空');
    return this.platform.appendTicketLog(id, { by: log.by, text }, patch);
  }
}
