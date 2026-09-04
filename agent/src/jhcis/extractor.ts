/**
 * Drug dispensing extraction (JHCIS_INTEGRATION sections 10, 11, 27).
 *
 * Only the columns needed for the "ปริมาณการจ่ายยา" report are selected -
 * never SELECT *, never patient identity. Every query is bound to this
 * installation's own pcucode and to an explicit date window.
 */
import type { RowDataPacket } from "mysql2/promise";

import type { DrugMasterRecord, DrugUsageRecord } from "@shared/canonical";

import type { JhcisConnection } from "./connection";
import type { SchemaMapping } from "./schema-inspector";

interface UsageRow extends RowDataPacket {
  visitno: number;
  drugcode: string;
  drugname: string | null;
  drugtype: string | null;
  quantity: number | string | null;
  unit: string | null;
  unitcode: string | null;
  clinic: string | null;
  usagedate: string;
}

export class UsageExtractor {
  constructor(
    private readonly db: JhcisConnection,
    private readonly mapping: SchemaMapping,
  ) {}

  /** SQL for one page of dispensing rows, ordered so paging is deterministic. */
  private buildQuery(): string {
    const m = this.mapping;
    const dateExpr = m.dateFromVisit ? "v.visitdate" : `vd.${m.dateColumn}`;
    const unitCodeExpr = m.unitColumn ? `c.${m.unitColumn}` : "NULL";
    // cdrug.unitsell holds a code (e.g. 027); the readable name lives in
    // cdrugunitsell. Fall back to the code when the lookup is unavailable.
    const unitNameExpr = m.unitColumn
      ? m.hasUnitLookup
        ? `COALESCE(us.unitsellname, c.${m.unitColumn})`
        : `c.${m.unitColumn}`
      : "NULL";
    const unitJoin =
      m.unitColumn && m.hasUnitLookup
        ? `LEFT JOIN cdrugunitsell us ON us.unitsellcode = c.${m.unitColumn}`
        : "";
    const typeExpr = m.hasDrugType ? "c.drugtype" : "NULL";
    const clinicExpr = m.hasClinic ? "vd.clinic" : "NULL";

    return `
      SELECT
        vd.visitno            AS visitno,
        vd.drugcode           AS drugcode,
        c.drugname            AS drugname,
        ${typeExpr}           AS drugtype,
        vd.${m.quantityColumn} AS quantity,
        ${unitNameExpr}       AS unit,
        ${unitCodeExpr}       AS unitcode,
        ${clinicExpr}         AS clinic,
        DATE_FORMAT(${dateExpr}, '%Y-%m-%d') AS usagedate
      FROM visitdrug vd
      JOIN visit v
        ON v.pcucode = vd.pcucode AND v.visitno = vd.visitno
      LEFT JOIN cdrug c
        ON c.drugcode = vd.drugcode
      ${unitJoin}
      WHERE vd.pcucode = ?
        AND ${dateExpr} >= ?
        AND ${dateExpr} <= ?
      ORDER BY ${dateExpr}, vd.visitno, vd.drugcode
      LIMIT ? OFFSET ?`;
  }

  /** Total rows in the window - used for progress and batch bookkeeping. */
  async countUsage(pcucode: string, from: string, to: string): Promise<number> {
    const dateExpr = this.mapping.dateFromVisit ? "v.visitdate" : `vd.${this.mapping.dateColumn}`;
    const row = await this.db.queryOne<RowDataPacket & { n: number }>(
      `SELECT COUNT(*) AS n
         FROM visitdrug vd
         JOIN visit v ON v.pcucode = vd.pcucode AND v.visitno = vd.visitno
        WHERE vd.pcucode = ? AND ${dateExpr} >= ? AND ${dateExpr} <= ?`,
      [pcucode, from, to],
    );
    return Number(row?.n ?? 0);
  }

  /** Streams the window in pages so memory stays flat on an initial sync. */
  async *streamUsage(
    pcucode: string,
    from: string,
    to: string,
    pageSize = 500,
  ): AsyncGenerator<DrugUsageRecord[]> {
    const sql = this.buildQuery();
    let offset = 0;

    for (;;) {
      const rows = await this.db.query<UsageRow>(sql, [pcucode, from, to, pageSize, offset]);
      if (!rows.length) return;

      yield rows.map((row) => ({
        visitNo: Number(row.visitno),
        drugCode: String(row.drugcode).trim(),
        drugName: row.drugname ? String(row.drugname).trim() : null,
        drugType: row.drugtype ? String(row.drugtype).trim() : null,
        quantity: row.quantity === null ? 0 : Number(row.quantity),
        unit: row.unit ? String(row.unit).trim() : null,
        unitCode: row.unitcode ? String(row.unitcode).trim() : null,
        clinic: row.clinic ? String(row.clinic).trim() : null,
        usageDate: String(row.usagedate),
      }));

      if (rows.length < pageSize) return;
      offset += pageSize;
    }
  }

  /** Drug master rows referenced by the window, so names stay in sync. */
  async fetchDrugMaster(limit = 2000): Promise<DrugMasterRecord[]> {
    const m = this.mapping;
    const sellName = m.hasUnitLookup ? "us.unitsellname" : "NULL";
    const usageName = m.hasUnitLookup ? "uu.unitsellname" : "NULL";
    const unitJoins = m.hasUnitLookup
      ? `LEFT JOIN cdrugunitsell us ON us.unitsellcode = c.unitsell
         LEFT JOIN cdrugunitsell uu ON uu.unitsellcode = c.unitusage`
      : "";
    const rows = await this.db.query<
      RowDataPacket & {
        drugcode: string;
        drugname: string | null;
        genericname: string | null;
        drugtype: string | null;
        drugtypesub: string | null;
        drugflag: string | null;
        unitsell: string | null;
        unitsellname: string | null;
        unitusage: string | null;
        unitusagename: string | null;
      }
    >(
      `SELECT
         c.drugcode                                  AS drugcode,
         c.drugname                                  AS drugname,
         ${m.hasGenericName ? "c.druggenericname" : "NULL"} AS genericname,
         ${m.hasDrugType ? "c.drugtype" : "NULL"}    AS drugtype,
         c.drugtypesub                               AS drugtypesub,
         c.drugflag                                  AS drugflag,
         c.unitsell                                  AS unitsell,
         ${sellName}                                 AS unitsellname,
         c.unitusage                                 AS unitusage,
         ${usageName}                                AS unitusagename
       FROM cdrug c
       ${unitJoins}
       ORDER BY c.drugcode
       LIMIT ?`,
      [limit],
    );

    return rows.map((row) => ({
      drugCode: String(row.drugcode).trim(),
      drugName: row.drugname ? String(row.drugname).trim() : String(row.drugcode).trim(),
      genericName: row.genericname ? String(row.genericname).trim() : null,
      drugType: row.drugtype ? String(row.drugtype).trim() : null,
      drugTypeSub: row.drugtypesub ? String(row.drugtypesub).trim() : null,
      drugFlag: row.drugflag ? String(row.drugflag).trim() : null,
      unitSell: row.unitsell ? String(row.unitsell).trim() : null,
      unitSellName: row.unitsellname ? String(row.unitsellname).trim() : null,
      unitUsage: row.unitusage ? String(row.unitusage).trim() : null,
      unitUsageName: row.unitusagename ? String(row.unitusagename).trim() : null,
    }));
  }

  /** Newest dispensing date available locally - the upper bound for a sync. */
  async maxUsageDate(pcucode: string): Promise<string | null> {
    const dateExpr = this.mapping.dateFromVisit ? "v.visitdate" : `vd.${this.mapping.dateColumn}`;
    const row = await this.db.queryOne<RowDataPacket & { d: string | null }>(
      `SELECT DATE_FORMAT(MAX(${dateExpr}), '%Y-%m-%d') AS d
         FROM visitdrug vd
         JOIN visit v ON v.pcucode = vd.pcucode AND v.visitno = vd.visitno
        WHERE vd.pcucode = ?`,
      [pcucode],
    );
    return row?.d ?? null;
  }

  /** Oldest dispensing date - the lower bound for an initial sync. */
  async minUsageDate(pcucode: string): Promise<string | null> {
    const dateExpr = this.mapping.dateFromVisit ? "v.visitdate" : `vd.${this.mapping.dateColumn}`;
    const row = await this.db.queryOne<RowDataPacket & { d: string | null }>(
      `SELECT DATE_FORMAT(MIN(${dateExpr}), '%Y-%m-%d') AS d
         FROM visitdrug vd
         JOIN visit v ON v.pcucode = vd.pcucode AND v.visitno = vd.visitno
        WHERE vd.pcucode = ?`,
      [pcucode],
    );
    return row?.d ?? null;
  }
}
