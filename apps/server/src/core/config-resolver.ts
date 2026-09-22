import type {
  BuildingConfigOverride,
  BuildingRecord,
  ResolvedBuildingConfig,
  ShopConfigRecord,
} from './types';

/* ============================================================================
 * ConfigResolver —— 楼栋级配置与店铺级配置的唯一合并入口
 * ----------------------------------------------------------------------------
 * 铁律 5：楼栋级差异一律进 config_override，**缺省即继承店铺**。
 * 因此「加新配置项不用改表」；代价是**所有读取都必须走这里**，
 * 任何业务代码自行 fallback 都会让这条铁律失效（也就等于埋了改表的雷）。
 * ==========================================================================*/

const DEFAULT_ACCESSIBLE_FROM = '06:30';
const DEFAULT_ACCESSIBLE_TO = '22:30';

/** 'HH:mm' → 距 00:00 的分钟数；非法输入返回 null */
export function parseHHmm(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 23 || mm > 59) return null;
  return h * 60 + mm;
}

/** 分钟数 → 'HH:mm'（跨天自动回绕） */
export function formatHHmm(totalMinutes: number): string {
  const t = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
  const h = Math.floor(t / 60);
  const m = t % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 截单时间 = 可进入时间窗结束 − 在途预留。**必须早于窗口结束**（D14 / 细节 12） */
export function cutoffOf(accessibleTo: string, leadMinutes: number): string {
  const end = parseHHmm(accessibleTo) ?? parseHHmm(DEFAULT_ACCESSIBLE_TO)!;
  return formatHHmm(end - Math.max(0, leadMinutes));
}

function overrideOf(b: BuildingRecord): BuildingConfigOverride {
  return (b.configOverride ?? {}) as BuildingConfigOverride;
}

function pick<T>(
  buildingValue: T | null | undefined,
  shopValue: T,
): { value: T; from: 'building' | 'shop' } {
  // 楼栋值为 null / undefined / 空字符串 → 继承店铺
  if (buildingValue === null || buildingValue === undefined || buildingValue === '') {
    return { value: shopValue, from: 'shop' };
  }
  return { value: buildingValue, from: 'building' };
}

/** 解析单个楼栋的有效配置 */
export function resolveBuildingConfig(
  building: BuildingRecord,
  shop: ShopConfigRecord,
): ResolvedBuildingConfig {
  const ov = overrideOf(building);

  // 楼栋自身列优先，其次 config_override，最后店铺 —— 三级 fallback 只为兼容历史数据形状
  const minAmount = pick(
    building.minAmountCents ?? (ov.minAmountCents as number | null | undefined),
    shop.minAmountCents,
  );
  const deliveryFee = pick(
    building.deliveryFeeCents ?? (ov.deliveryFeeCents as number | null | undefined),
    shop.deliveryFeeCents,
  );
  const accFrom = pick(
    building.accessibleFrom ?? (ov.accessibleFrom as string | null | undefined),
    shop.accessibleFrom || DEFAULT_ACCESSIBLE_FROM,
  );
  const accTo = pick(
    building.accessibleTo ?? (ov.accessibleTo as string | null | undefined),
    shop.accessibleTo || DEFAULT_ACCESSIBLE_TO,
  );
  const notice = pick(
    building.notice ?? (ov.notice as string | null | undefined),
    null as string | null,
  );

  let accessibleFrom = accFrom.value as string;
  let accessibleTo = accTo.value as string;

  // 门禁窗口是硬约束：起止任一非法则整组回落到店铺 / 默认值
  if (parseHHmm(accessibleFrom) === null || parseHHmm(accessibleTo) === null) {
    accessibleFrom = shop.accessibleFrom || DEFAULT_ACCESSIBLE_FROM;
    accessibleTo = shop.accessibleTo || DEFAULT_ACCESSIBLE_TO;
  }

  return {
    buildingId: building.id,
    buildingCode: building.code,
    buildingName: building.name,
    status: building.status,
    isDefault: building.isDefault,
    deliveryEnabled: building.deliveryEnabled,
    minAmountCents: minAmount.value,
    deliveryFeeCents: deliveryFee.value,
    accessibleFrom,
    accessibleTo,
    cutoffTime: cutoffOf(accessibleTo, shop.cutoffLeadMinutes ?? 30),
    notice: notice.value,
    source: {
      minAmountCents: minAmount.from,
      deliveryFeeCents: deliveryFee.from,
      accessibleFrom: accFrom.from,
      accessibleTo: accTo.from,
      notice: notice.from,
    },
  };
}

/**
 * 营业时间收窄：商户填的营业时间必须落在可进入时间窗内，超出部分**自动截断**。
 * 不报错 —— 界面上是「帮你改了」，不是「你错了」（对应设计稿的时间窗琥珀提示）。
 */
export function narrowBusinessHours(
  openTime: string | null,
  closeTime: string | null,
  accessibleFrom: string,
  accessibleTo: string,
): { openTime: string; closeTime: string; narrowed: boolean } {
  const winFrom = parseHHmm(accessibleFrom) ?? parseHHmm(DEFAULT_ACCESSIBLE_FROM)!;
  const winTo = parseHHmm(accessibleTo) ?? parseHHmm(DEFAULT_ACCESSIBLE_TO)!;
  const curFrom = parseHHmm(openTime) ?? winFrom;
  const curTo = parseHHmm(closeTime) ?? winTo;

  const from = Math.max(curFrom, winFrom);
  const to = Math.min(curTo, winTo);
  return {
    openTime: formatHHmm(from),
    closeTime: formatHHmm(to <= from ? from : to),
    narrowed: from !== curFrom || to !== curTo,
  };
}

/** 一键配置全部楼栋：把一份配置覆盖到所有**启用**楼栋（常态操作，§4.3） */
export function bulkOverride(override: BuildingConfigOverride): BuildingConfigOverride {
  // 只保留显式提供的键；未提供的键一律删除 → 重新回到"继承店铺"
  const cleaned: BuildingConfigOverride = {};
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined) continue;
    if (v === null || v === '') {
      // 显式传空 = 清除该覆盖项，恢复继承
      continue;
    }
    cleaned[k] = v;
  }
  return cleaned;
}
