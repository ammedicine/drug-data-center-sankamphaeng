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
  /** cdrug.drugtype values this query may read; resolved by resolveDrugTypeScope */
  drugTypes?: string[] | null;
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
  if (filters.drugTypes && filters.drugTypes.length) {
    parts.push(inArray(drugUsage.drugType, filters.drugTypes));
  }
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
  /** cdrug.drugflag: "1" active, "2" discontinued in JHCIS */
  drugFlag: string | null;
  /** first and last time this code was actually dispensed in the window */
  firstUsageDate: string | null;
  lastUsageDate: string | null;
}

export async function getUsageByDrug(
  filters: UsageFilters,
  paging: Paging,
  sort: "name" | "quantity" | "rows" | "code" = "name",
): Promise<{ rows: UsageByDrugRow[]; total: number }> {
  const where = whereClause(filters);

  // Aliased so ORDER BY can reference the aggregate without repeating it
  // (TiDB runs ONLY_FULL_GROUP_BY and compares expressions textually).
  const drugName = sql<string>`MAX(${drugUsage.drugNameSnapshot})`.as("drug_name");
  const totalQuantity = sql<number>`SUM(${drugUsage.quantity})`.as("total_quantity");
  const dispensingRows = sql<number>`COUNT(*)`.as("dispensing_rows");

  // A code switched off in JHCIS (drugflag = 2) still has history worth
  // reading, but nobody looks for it first - so it sinks below the codes still
  // in use. Then category, so the report reads as grouped sections, then the
  // requested order inside each category (ชื่อยา by default).
  const retired = sql`retired`;
  const orderBy =
    sort === "code"
      ? [retired, asc(drugUsage.drugType), asc(drugUsage.drugCode)]
      : sort === "rows"
        ? [retired, asc(drugUsage.drugType), sql`dispensing_rows desc`]
        : sort === "quantity"
          ? [retired, asc(drugUsage.drugType), sql`total_quantity desc`]
          : [retired, asc(drugUsage.drugType), sql`drug_name asc`];

  const rows = await db
    .select({
      drugCode: drugUsage.drugCode,
      drugName,
      drugType: drugUsage.drugType,
      unit: sql<string | null>`MAX(${drugUsage.unit})`,
      totalQuantity,
      dispensingRows,
      // A code can be switched off in JHCIS long after it was last dispensed,
      // so the flag comes from the master while the dates come from the facts.
      drugFlag: sql<string | null>`MAX(${drugs.drugFlag})`,
      retired: sql<number>`CASE WHEN MAX(${drugs.drugFlag}) = '1' THEN 0 WHEN MAX(${drugs.drugFlag}) = '2' THEN 2 ELSE 1 END`.as("retired"),
      firstUsageDate: sql<string | null>`DATE_FORMAT(MIN(${drugUsage.usageDate}), '%Y-%m-%d')`,
      lastUsageDate: sql<string | null>`DATE_FORMAT(MAX(${drugUsage.usageDate}), '%Y-%m-%d')`,
    })
    .from(drugUsage)
    .leftJoin(
      drugs,
      and(eq(drugs.facilityId, drugUsage.facilityId), eq(drugs.drugCode, drugUsage.drugCode)),
    )
    .where(where)
    .groupBy(drugUsage.drugCode, drugUsage.drugType)
    .orderBy(...orderBy)
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
      drugFlag: r.drugFlag ?? null,
      firstUsageDate: r.firstUsageDate ?? null,
      lastUsageDate: r.lastUsageDate ?? null,
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
  // Group and order by the SELECT alias, not by the expression: drizzle renders
  // the same sql`` template unqualified in SELECT but table-qualified in
  // GROUP BY, and TiDB runs with ONLY_FULL_GROUP_BY, which compares them
  // textually and rejects the mismatch.
  const format = granularity === "month" ? "%Y-%m" : "%Y-%m-%d";
  const period = sql<string>`DATE_FORMAT(${drugUsage.usageDate}, ${format})`.as("period");

  const rows = await db
    .select({
      period,
      totalQuantity: sql<number>`SUM(${drugUsage.quantity})`,
      dispensingRows: sql<number>`COUNT(*)`,
    })
    .from(drugUsage)
    .where(whereClause(filters))
    .groupBy(sql`period`)
    .orderBy(sql`period asc`);

  return rows.map((r) => ({
    period: String(r.period),
    totalQuantity: Number(r.totalQuantity ?? 0),
    dispensingRows: Number(r.dispensingRows ?? 0),
  }));
}

export interface DrugTypeUsageRow {
  drugType: string | null;
  distinctDrugs: number;
  dispensingRows: number;
  totalQuantity: number;
}

/** Per-category totals shown above the table so หมวดยา stay clearly separated. */
export async function getUsageByDrugType(filters: UsageFilters): Promise<DrugTypeUsageRow[]> {
  const rows = await db
    .select({
      drugType: drugUsage.drugType,
      distinctDrugs: sql<number>`COUNT(DISTINCT ${drugUsage.drugCode})`,
      dispensingRows: sql<number>`COUNT(*)`,
      totalQuantity: sql<number>`SUM(${drugUsage.quantity})`,
    })
    .from(drugUsage)
    .where(whereClause(filters))
    .groupBy(drugUsage.drugType)
    .orderBy(asc(drugUsage.drugType));

  return rows.map((r) => ({
    drugType: r.drugType,
    distinctDrugs: Number(r.distinctDrugs ?? 0),
    dispensingRows: Number(r.dispensingRows ?? 0),
    totalQuantity: Number(r.totalQuantity ?? 0),
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

export interface FacilityDrugRow extends UsageByDrugRow {
  facilityId: string;
}

/**
 * Every drug each facility dispensed in the window, in one query.
 *
 * The dashboard sends this to the browser once so picking a facility shows its
 * list instantly, without a request per click. Ordering matches the report:
 * codes still in use first, alphabetically, retired codes at the bottom.
 */
export async function getUsageByFacilityAndDrug(
  filters: UsageFilters,
  limit = 4000,
): Promise<FacilityDrugRow[]> {
  const drugName = sql<string>`MAX(${drugUsage.drugNameSnapshot})`.as("drug_name");
  const retired = sql<number>`CASE WHEN MAX(${drugs.drugFlag}) = '1' THEN 0 WHEN MAX(${drugs.drugFlag}) = '2' THEN 2 ELSE 1 END`.as(
    "retired",
  );

  const rows = await db
    .select({
      facilityId: drugUsage.facilityId,
      drugCode: drugUsage.drugCode,
      drugName,
      drugType: drugUsage.drugType,
      unit: sql<string | null>`MAX(${drugUsage.unit})`,
      totalQuantity: sql<number>`SUM(${drugUsage.quantity})`,
      dispensingRows: sql<number>`COUNT(*)`,
      drugFlag: sql<string | null>`MAX(${drugs.drugFlag})`,
      retired,
      firstUsageDate: sql<string | null>`DATE_FORMAT(MIN(${drugUsage.usageDate}), '%Y-%m-%d')`,
      lastUsageDate: sql<string | null>`DATE_FORMAT(MAX(${drugUsage.usageDate}), '%Y-%m-%d')`,
    })
    .from(drugUsage)
    .leftJoin(
      drugs,
      and(eq(drugs.facilityId, drugUsage.facilityId), eq(drugs.drugCode, drugUsage.drugCode)),
    )
    .where(whereClause(filters))
    .groupBy(drugUsage.facilityId, drugUsage.drugCode, drugUsage.drugType)
    .orderBy(drugUsage.facilityId, sql`retired`, sql`drug_name asc`)
    .limit(limit);

  return rows.map((r) => ({
    facilityId: r.facilityId,
    drugCode: r.drugCode,
    drugName: r.drugName ?? r.drugCode,
    drugType: r.drugType,
    unit: r.unit,
    totalQuantity: Number(r.totalQuantity ?? 0),
    dispensingRows: Number(r.dispensingRows ?? 0),
    drugFlag: r.drugFlag ?? null,
    firstUsageDate: r.firstUsageDate ?? null,
    lastUsageDate: r.lastUsageDate ?? null,
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
      unit: sql<string | null>`COALESCE(${drugs.unitSellName}, ${drugs.unitSell})`,
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
