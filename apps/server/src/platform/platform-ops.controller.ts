import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { MonitorService } from './monitor.service';
import { SecretService } from './secret.service';
import { TicketService } from './ticket.service';
import type { SecretKind, TicketCategory, TicketStatus } from '../core/types';

/**
 * 密钥管理（P-12 / CP-08）。
 *
 * 这一组接口的形状本身就是设计：
 *   · 有 `POST /secrets`（写入 / 替换）
 *   · 有 `POST /secrets/:kind/invalidate`（标记失效）
 *   · **没有** `GET /secrets/:id/reveal`，也永远不会有
 * 不是"暂时不做"，是服务端手上只有密文 —— 加也加不出来。
 */
@Controller('api/platform/secrets')
export class PlatformSecretController {
  constructor(private readonly secrets: SecretService) {}

  @Get()
  async list(@Query('tenantCode') tenantCode?: string) {
    return this.secrets.list(tenantCode);
  }

  /** 写入或替换（替换即覆盖，不留旧副本） */
  @Post()
  @HttpCode(200)
  async put(
    @Body() body: { tenantCode: string; kind: SecretKind; value: string; remark?: string | null; operator?: string },
  ) {
    return this.secrets.put(body?.tenantCode ?? '', body?.kind, body?.value ?? '', {
      remark: body?.remark ?? null,
      operator: body?.operator ?? 'platform',
    });
  }

  /**
   * 标记失效（如商户重置了上传密钥）。
   * 对应 R9：不做这一步，表现是"推送突然全失败"而原因只能靠猜。
   */
  @Post(':tenantCode/:kind/invalidate')
  @HttpCode(200)
  async invalidate(
    @Param('tenantCode') tenantCode: string,
    @Param('kind') kind: SecretKind,
    @Body() body: { reason: string },
  ) {
    return this.secrets.markInvalid(tenantCode, kind, body?.reason ?? '商户重置密钥');
  }
}

/** 监控告警（P-10 / CP-11） */
@Controller('api/platform/alerts')
export class PlatformAlertController {
  constructor(private readonly monitor: MonitorService) {}

  @Get()
  async list(@Query('open') open?: string, @Query('tenantCode') tenantCode?: string) {
    // 只有显式要"待处理"时才过滤 —— 把 `open` 无脑传成 false 再在仓储里解释成"全部"，
    // 会让"筛选条件"这件事变得不可读（读代码的人得跳到仓储才知道 false 是什么意思）
    return this.monitor.list({
      ...(open === '1' || open === 'true' ? { open: true } : {}),
      ...(tenantCode ? { tenantCode } : {}),
    });
  }

  /**
   * 手动跑一次巡检。`now` 可注入 —— 否则"连续 7 天无订单"这类告警
   * 只能靠等一周来验证，等于永远没被验证过。
   */
  @Post('scan')
  @HttpCode(200)
  async scan(@Body() body: { now?: string }) {
    return this.monitor.scan(body?.now ? new Date(body.now) : new Date());
  }

  @Post(':id/ack')
  @HttpCode(200)
  async ack(@Param('id') id: string, @Body() body: { by?: string }) {
    return this.monitor.ack(Number(id), body?.by ?? 'platform');
  }
}

/** 工单（P-11 / CP-09） */
@Controller('api/platform/tickets')
export class PlatformTicketController {
  constructor(private readonly tickets: TicketService) {}

  @Get()
  async list(@Query('status') status?: TicketStatus, @Query('tenantCode') tenantCode?: string) {
    return this.tickets.list({ status, tenantCode });
  }

  @Get(':id')
  async detail(@Param('id') id: string) {
    return this.tickets.detail(Number(id));
  }

  @Post()
  @HttpCode(200)
  async create(
    @Body() body: { tenantCode?: string | null; title: string; category: TicketCategory; detail?: string; createdBy?: string },
  ) {
    return this.tickets.create({
      tenantCode: body?.tenantCode ?? null,
      title: body?.title ?? '',
      category: body?.category,
      detail: body?.detail,
      createdBy: body?.createdBy ?? 'platform',
    });
  }

  /** 追加处理记录（追加式，不改历史） */
  @Patch(':id')
  @HttpCode(200)
  async append(
    @Param('id') id: string,
    @Body() body: { by: string; text: string; status?: TicketStatus; assignee?: 'platform' | 'partner' },
  ) {
    return this.tickets.append(Number(id), { by: body?.by ?? 'platform', text: body?.text ?? '' }, {
      status: body?.status,
      assignee: body?.assignee,
    });
  }
}
