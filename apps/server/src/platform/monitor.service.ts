import { Inject, Injectable } from '@nestjs/common';
import { ERR, BizError } from '../core/errors';
import { REPO_FACTORY } from '../core/repo.factory';
import type { PlatformRepo, RepoFactory } from '../core/repository';
import type { AlertRecord } from '../core/types';

/**
 * 监控告警服务（P-10 / CP-11）。
 *
 * 五类告警不是"越多越好"，而是**覆盖那些没人主动看就会出事的地方**：
 *   · 活跃度   —— 商户悄悄不用了，等发现时学期已经过半
 *   · 订单量   —— 骤降往往是"闸门锁单了"或"版本挂了"的表象
 *   · 支付异常 —— 待扣队列积压 = 每日任务没跑 = 钱没扣
 *   · 审核卡点 —— 流水线超期（直接复用流水线的 overdue 判定，不另立一套标准）
 *   · 密钥失效 —— 不告警就会表现为"推送莫名全失败"
 *
 * 全部带 `dedupeKey`：巡检每 30 分钟跑一次，没有幂等键的话一天能刷出 48 条一样的告警，
 * 看板上真正的异常会被埋掉。
 */
@Injectable()
export class MonitorService {
  /** 活跃度阈值：连续 7 天没有支付成功订单 */
  static readonly IDLE_DAYS = 7;
  /** 待扣积压阈值：超过 3 天还没结算 */
  static readonly PENDING_STALE_DAYS = 3;

  constructor(@Inject(REPO_FACTORY) private readonly repos: RepoFactory) {}

  private get platform(): PlatformRepo {
    return this.repos.platform();
  }

  /**
   * 巡检一次。`now` 可注入 —— 否则"连续 7 天无订单"这种告警就只能靠等 7 天来验证。
   */
  async scan(now: Date = new Date()): Promise<{
    created: AlertRecord[];
    checked: { tenants: number; idle: number; volumeDrop: number; pendingStale: number; overdue: number; secretInvalid: number };
  }> {
    const tenants = await this.platform.listTenants();
    const day = bizDate(now);
    const created: AlertRecord[] = [];
    const push = async (a: Parameters<PlatformRepo['raiseAlert']>[0]) => {
      const r = await this.platform.raiseAlert(a);
      if (r.created) created.push(r.alert);
    };

    let idle = 0;
    let volumeDrop = 0;
    let pendingStale = 0;
    let overdue = 0;
    let secretInvalid = 0;

    for (const t of tenants) {
      if (t.status === 'suspended') continue;

      const summaries = await this.platform.listOrderSummaries(t.tenantCode, 500);
      const paidAt = summaries.map((s) => (s.settledAt ? s.createdAt : s.createdAt)).filter(Boolean);
      const lastAt = paidAt.length ? paidAt.reduce((a, b) => (a > b ? a : b)) : null;
      const idleDays = lastAt ? Math.floor((now.getTime() - new Date(lastAt).getTime()) / 86_400_000) : null;

      // ① 活跃度：从来没订单的新户不算异常（还在流水线里），只看"曾经有过单、现在断了"
      if (lastAt && idleDays !== null && idleDays >= MonitorService.IDLE_DAYS) {
        idle += 1;
        await push({
          tenantCode: t.tenantCode,
          kind: 'tenant_activity',
          level: idleDays >= 14 ? 'danger' : 'warn',
          title: `${t.shopName} 已 ${idleDays} 天没有订单`,
          detail: `最后一次订单在 ${lastAt.slice(0, 10)}。先确认是"放假了"还是"闸门被锁 / 版本挂了" —— 骤停和自然淡季要分清。`,
          dedupeKey: `tenant_activity:${t.tenantCode}:${day}`,
        });
      }

      // ② 订单量异常：近 3 天 vs 前 7 天日均，跌幅 > 60%
      const recent = countIn(summaries, now, 3);
      const base = countIn(summaries, now, 10) - recent;
      const avg = base / 7;
      if (avg >= 3 && recent < avg * 0.4) {
        volumeDrop += 1;
        await push({
          tenantCode: t.tenantCode,
          kind: 'order_volume',
          level: 'warn',
          title: `${t.shopName} 近 3 天订单量骤降`,
          detail: `近 3 天 ${recent} 单，此前 7 天日均 ${Math.round(avg * 10) / 10} 单。`,
          dedupeKey: `order_volume:${t.tenantCode}:${day}`,
        });
      }

      // ③ 支付异常：待扣队列里躺着超过 3 天的单 —— 说明每日扣减任务没跑
      const pending = await this.platform.listPendingOrders(t.tenantCode);
      const stale = pending.filter((p) => now.getTime() - new Date(p.createdAt).getTime() > MonitorService.PENDING_STALE_DAYS * 86_400_000);
      if (stale.length) {
        pendingStale += 1;
        await push({
          tenantCode: t.tenantCode,
          kind: 'pay_anomaly',
          level: stale.length >= 10 ? 'danger' : 'warn',
          title: `${t.shopName} 有 ${stale.length} 笔待扣订单超过 ${MonitorService.PENDING_STALE_DAYS} 天未结算`,
          detail: `最早一笔在 ${stale[0].createdAt.slice(0, 10)}。待扣积压 = 每日扣减任务没跑或跑失败，钱没扣进来。`,
          dedupeKey: `pay_anomaly:${t.tenantCode}:${day}`,
        });
      }

      // ⑤ 密钥失效
      const secrets = await this.platform.listSecrets(t.tenantCode);
      const bad = secrets.filter((s) => s.status === 'invalid');
      if (bad.length) {
        secretInvalid += 1;
        await push({
          tenantCode: t.tenantCode,
          kind: 'secret_invalid',
          level: 'danger',
          title: `${t.shopName} 的${bad.map((b) => (b.kind === 'upload_key' ? '代码上传密钥' : '支付证书')).join('、')}已失效`,
          detail: bad.map((b) => b.invalidReason ?? '未说明原因').join('；') + ' —— 不换密钥，下一次推送必然失败。',
          dedupeKey: `secret_invalid:${t.tenantCode}:${bad.map((b) => b.kind).join('_')}`,
        });
      }
    }

    // ④ 审核卡点：复用流水线的 overdue 判定，**不另立一套标准** ——
    // 两处各算一遍"超期"必然会分叉，然后没人知道该信哪个
    const pipeline = await this.platform.listAllPipeline();
    const byTenant = new Map<string, typeof pipeline>();
    for (const p of pipeline) {
      const list = byTenant.get(p.tenantCode) ?? [];
      list.push(p);
      byTenant.set(p.tenantCode, list);
    }
    for (const [tenantCode, stages] of byTenant) {
      const t = tenants.find((x) => x.tenantCode === tenantCode);
      if (!t || t.status === 'active' || t.status === 'suspended') continue;
      const cur = [...stages].sort((a, b) => a.stageNo - b.stageNo).find((s) => s.status !== 'done');
      if (!cur || cur.status !== 'doing') continue;
      const stuck = businessDaysSince(cur.startAt ?? cur.rejectedAt, now);
      if (stuck > 7) {
        overdue += 1;
        await push({
          tenantCode,
          kind: 'audit_stuck',
          level: cur.owner === 'renter' && stuck > 20 ? 'danger' : 'warn',
          title: `${t.shopName} 卡在第 ${cur.stageNo} 阶段 ${stuck} 个工作日`,
          detail: `${cur.stageName}（责任方：${cur.owner}）。推动权不在我们手上时，唯一能做的是记录触达 —— 催了吗、上次什么时候。`,
          dedupeKey: `audit_stuck:${tenantCode}:${cur.stageNo}:${day}`,
        });
      }
    }

    return { created, checked: { tenants: tenants.length, idle, volumeDrop, pendingStale, overdue, secretInvalid } };
  }

  async list(opts: { open?: boolean; tenantCode?: string } = {}): Promise<{
    items: AlertRecord[];
    summary: { open: number; danger: number; warn: number; info: number };
  }> {
    const items = await this.platform.listAlerts({ ...opts, limit: 300 });
    const open = items.filter((i) => i.ackAt === null);
    return {
      items,
      summary: {
        open: open.length,
        danger: open.filter((i) => i.level === 'danger').length,
        warn: open.filter((i) => i.level === 'warn').length,
        info: open.filter((i) => i.level === 'info').length,
      },
    };
  }

  async ack(id: number, by: string): Promise<AlertRecord> {
    return this.platform.ackAlert(id, by);
  }
}

/* ------------------------------------------------------------------ 工具 */

/** 按中国时区取自然日（与账本用同一个口径） */
export function bizDate(at: Date): string {
  return new Date(at.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

function countIn(summaries: Array<{ createdAt: string }>, now: Date, days: number): number {
  const from = now.getTime() - days * 86_400_000;
  return summaries.filter((s) => new Date(s.createdAt).getTime() >= from).length;
}

function businessDaysSince(from: string | null, to: Date): number {
  if (!from) return 0;
  const a = new Date(from);
  if (Number.isNaN(a.getTime())) return 0;
  let days = 0;
  const cur = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate()));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  while (cur.getTime() < end.getTime()) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) days += 1;
  }
  return days;
}
