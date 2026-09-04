/**
 * Drug usage reporting. All aggregation happens in TiDB - never pull rows into
 * Node and reduce them there (PROJECT_SPEC section 28).
 *
 * Every query takes an already-resolved facility scope from resolveFacilityScope();
 * this module does not read the session and does not accept raw client input.
 */
import { and, asc, desc, eq, gte, inArray, like, lte, sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { drugUsage, drugs, facilities } from "@/lib/db/schema";

export interface UsageFilters {
  facilityIds: string[] | null; // null = all facilities (SUPER_ADMIN)
  from: string; // yyyy-mm-dd
  to: string; // yyyy-mm-dd
  drugType?: string | null;
  drugCode?: string | null;
  search?: string | null;
}

export interface Paging {
  page: number;
  pageSize: number;
}

function whereClause(filters: UsageFilters): SQL {
  const parts: SQL[] = [
    gte(drugUsage.usageDate, filters.from),
    lte(drugUsage.usageDate, filters.to),
  ];
  if (filters.facilityIds) parts.push(inArray(drugUsage.facilityId, filters.facilityIds));
  if (filters.drugType) parts.push(eq(drugUsage.drugType, filters.drugType));
  if (filters.drugCode) parts.push(eq(drugUsage.drugCode, filters.drugCode));
  if (filters.search) {
    const term = `%${filters.search.trim()}%`;
    parts.push(
      sql`(${drugUsage.drugCode} LIKE ${term} OR ${drugUsage.drugNameSnapshot} LIKE ${term})`,
    );
  }
  return and(...parts) as SQL;
}

export interface UsageSummary {
  dispensingRows: number;
  distinctDrugs: number;
  totalQuantity: number;
  distinctDrugTypes: number;
}

export async function getUsageSummary(filters: UsageFilters): Promise<UsageSummary> {
  const [row] = await db
    .select({
      dispensingRows: sql<number>`COUNT(*)`,
      distinctDrugs: sql<number>`COUNT(DISTINCT ${drugUsage.drugCode})`,
      totalQuantity: sql<number>`COALESCE(SUM(${drugUsage.quantity}), 0)`,
      distinctDrugTypes: sql<number>`COUNT(DISTINCT ${drugUsage.drugType})`,
    })
    .from(drugUsage)
    .where(whereClause(filters));

  return {
    dispensingRows: Number(row?.dispensingRows ?? 0),
    distinctDrugs: Number(row?.distinctDrugs ?? 0),
    totalQuantity: Number(row?.totalQuantity ?? 0),
    distinctDrugTypes: Number(row?.distinctDrugTypes ?? 0),
  };
}

export interface UsageByDrugRow {
  drugCode: string;
  drugName: string;
  drugType: string | null;
  unit: string | null;
  totalQuantity: number;
  dispensingRows: number;
}

export async function getUsageByDrug(
  filters: UsageFilters,
  paging: Paging,
  sort: "quantity" | "rows" | "code" = "quantity",
): Promise<{ rows: UsageByDrugRow[]; total: number }> {
  const where = whereClause(filters);

  const orderBy =
    sort === "code"
      ? asc(drugUsage.drugCode)
      : sort === "rows"
        ? desc(sql`COUNT(*)`)
        : desc(sql`SUM(${drugUsage.quantity})`);

  const rows = await db
    .select({
      drugCode: drugUsage.drugCode,
      drugName: sql<string>`MAX(${drugUsage.drugNameSnapshot})`,
      drugType: sql<string | null>`MAX(${drugUsage.drugType})`,
      unit: sql<string | null>`MAX(${drugUsage.unit})`,
      totalQuantity: sql<number>`SUM(${drugUsage.quantity})`,
      dispensingRows: sql<number>`COUNT(*)`,
    })
    .from(drugUsage)
    .where(where)
    .groupBy(drugUsage.drugCode)
    .orderBy(orderBy)
    .limit(paging.pageSize)
    .offset((paging.page - 1) * paging.pageSize);

  const [countRow] = await db
    .select({ total: sql<number>`COUNT(DISTINCT ${drugUsage.drugCode})` })
    .from(drugUsage)
    .where(where);

  return {
    rows: rows.map((r) => ({
      drugCode: r.drugCode,
      drugName: r.drugName ?? r.drugCode,
      drugType: r.drugType,
      unit: r.unit,
      totalQuantity: Number(r.totalQuantity ?? 0),
      dispensingRows: Number(r.dispensingRows ?? 0),
    })),
    total: Number(countRow?.total ?? 0),
  };
}

export interface TrendPoint {
  period: string;
  totalQuantity: number;
  dispensingRows: number;
}

export async function getUsageTrend(
  filters: UsageFilters,
  granularity: "day" | "month" = "day",
): Promise<TrendPoint[]> {
  const period =
    granularity === "month"
      ? sql<string>`DATE_FORMAT(${drugUsage.usageDate}, '%Y-%m')`
      : sql<string>`DATE_FORMAT(${drugUsage.usageDate}, '%Y-%m-%d')`;

  const rows = await db
    .select({
      period,
      totalQuantity: sql<number>`SUM(${drugUsage.quantity})`,
      dispensingRows: sql<number>`COUNT(*)`,
    })
    .from(drugUsage)
    .where(whereClause(filters))
    .groupBy(period)
    .orderBy(asc(period));

  return rows.map((r) => ({
    period: String(r.period),
    totalQuantity: Number(r.totalQuantity ?? 0),
    dispensingRows: Number(r.dispensingRows ?? 0),
  }));
}

export interface FacilityUsageRow {
  facilityId: string;
  facilityCode: string;
  facilityName: string;
  totalQuantity: number;
  dispensingRows: number;
  distinctDrugs: number;
}

/** Facility comparison - only ever called for SUPER_ADMIN scopes. */
export async function getUsageByFacility(filters: UsageFilters): Promise<FacilityUsageRow[]> {
  const rows = await db
    .select({
      facilityId: drugUsage.facilityId,
      facilityCode: facilities.code,
      facilityName: facilities.name,
      totalQuantity: sql<number>`SUM(${drugUsage.quantity})`,
      dispensingRows: sql<number>`COUNT(*)`,
      distinctDrugs: sql<number>`COUNT(DISTINCT ${drugUsage.drugCode})`,
    })
    .from(drugUsage)
    .innerJoin(facilities, eq(facilities.id, drugUsage.facilityId))
    .where(whereClause(filters))
    .groupBy(drugUsage.facilityId, facilities.code, facilities.name)
    .orderBy(desc(sql`SUM(${drugUsage.quantity})`));

  return rows.map((r) => ({
    facilityId: r.facilityId,
    facilityCode: r.facilityCode,
    facilityName: r.facilityName,
    totalQuantity: Number(r.totalQuantity ?? 0),
    dispensingRows: Number(r.dispensingRows ?? 0),
    distinctDrugs: Number(r.distinctDrugs ?? 0),
  }));
}

export interface DrugDetail {
  drugCode: string;
  drugName: string;
  genericName: string | null;
  drugType: string | null;
  drugFlag: string | null;
  unit: string | null;
}

export async function getDrugDetail(
  facilityIds: string[] | null,
  drugCode: string,
): Promise<DrugDetail | null> {
  const parts: SQL[] = [eq(drugs.drugCode, drugCode)];
  if (facilityIds) parts.push(inArray(drugs.facilityId, facilityIds));

  const [row] = await db
    .select({
      drugCode: drugs.drugCode,
      drugName: drugs.drugName,
      genericName: drugs.genericName,
      drugType: drugs.drugType,
      drugFlag: drugs.drugFlag,
      unit: drugs.unitSell,
    })
    .from(drugs)
    .where(and(...parts))
    .limit(1);

  return row ?? null;
}

/** Drug master lookup used by the report filter (typeahead). */
export async function searchDrugs(
  facilityIds: string[] | null,
  term: string,
  limit = 20,
): Promise<Array<{ drugCode: string; drugName: string; drugType: string | null }>> {
  const parts: SQL[] = [];
  if (facilityIds) parts.push(inArray(drugs.facilityId, facilityIds));
  if (term.trim()) {
    const q = `%${term.trim()}%`;
    parts.push(sql`(${drugs.drugCode} LIKE ${q} OR ${drugs.drugName} LIKE ${q})`);
  }

  return db
    .select({ drugCode: drugs.drugCode, drugName: drugs.drugName, drugType: drugs.drugType })
    .from(drugs)
    .where(parts.length ? (and(...parts) as SQL) : undefined)
    .orderBy(asc(drugs.drugCode))
    .limit(limit);
}

/** Distinct drug types present in the scope, for the filter dropdown. */
export async function getAvailableDrugTypes(
  facilityIds: string[] | null,
): Promise<Array<{ drugType: string; count: number }>> {
  const rows = await db
    .select({ drugType: drugs.drugType, count: sql<number>`COUNT(*)` })
    .from(drugs)
    .where(facilityIds ? inArray(drugs.facilityId, facilityIds) : undefined)
    .groupBy(drugs.drugType)
    .orderBy(asc(drugs.drugType));

  return rows
    .filter((r): r is { drugType: string; count: number } => Boolean(r.drugType))
    .map((r) => ({ drugType: r.drugType, count: Number(r.count) }));
}

/** Used by the report page's drug picker when the user types a name. */
export async function findDrugCodesByName(
  facilityIds: string[] | null,
  term: string,
): Promise<string[]> {
  const parts: SQL[] = [like(drugs.drugName, `%${term}%`)];
  if (facilityIds) parts.push(inArray(drugs.facilityId, facilityIds));
  const rows = await db
    .select({ drugCode: drugs.drugCode })
    .from(drugs)
    .where(and(...parts))
    .limit(200);
  return rows.map((r) => r.drugCode);
}
