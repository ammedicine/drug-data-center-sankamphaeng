/**
 * Drug dispensing extraction (JHCIS_INTEGRATION sections 10, 11, 27).
 *
 * Only the columns needed for the "ปริมาณการจ่ายยา" report are selected -
 * never SELECT *, never patient identity. Every query is bound to this
 * installation's own pcucode and to an explicit date window.
 *
 * How the data actually sits in JHCIS (confirmed against a live V5.1 database):
 *  - opening a queue creates a `visit` row carrying visitno + visitdate
 *  - the drugs keyed for that person land in `visitdrug`, one row per drug, in
 *    no particular physical order, each carrying its visitno
 *  - `visitdrug` is therefore the source of truth for dispensing and `visit`
 *    only supplies the service date
 *
 * Paging walks `visit` through its vs_date index and then reads each batch of
 * visits' drug rows through the visitdrug primary key. LIMIT/OFFSET is avoided
 * deliberately: with 265k rows a deep OFFSET re-scans everything before it and
 * turns a full sync into a crawl.
 */
import type { RowDataPacket } from "mysql2/promise";

import type { DrugMasterRecord, DrugUsageRecord } from "@shared/canonical";

import type { JhcisConnection } from "./connection";
import type { SchemaMapping } from "./schema-inspector";

/** Visits fetched per round trip; each yields roughly 1-3 drug rows. */
const VISIT_BATCH = 400;

interface VisitRow extends RowDataPacket {
  visitno: number;
  visitdate: string;
}

interface DrugRow extends RowDataPacket {
  visitno: number;
  drugcode: string;
  drugname: string | null;
  drugtype: string | null;
  quantity: number | string | null;
  unit: string | null;
  unitcode: string | null;
  clinic: string | null;
}

interface OrphanRow extends DrugRow {
  usagedate: string;
}

export class UsageExtractor {
  constructor(
    private readonly db: JhcisConnection,
    private readonly mapping: SchemaMapping,
  ) {}

  /** Date of a dispensing row: the visit date, or dateupdate when the visit is gone. */
  private dateExpr(): string {
    return this.mapping.dateFromVisit
      ? "COALESCE(v.visitdate, DATE(vd.dateupdate))"
      : `COALESCE(vd.${this.mapping.dateColumn}, v.visitdate, DATE(vd.dateupdate))`;
  }

  /** SELECT list + joins shared by the visit-driven and orphan queries. */
  private drugSelect(): { columns: string; joins: string } {
    const m = this.mapping;
    const unitCodeExpr = m.unitColumn ? `c.${m.unitColumn}` : "NULL";
    // cdrug.unitsell holds a code (e.g. 027); the readable name lives in
    // cdrugunitsell. Fall back to the code when the lookup is unavailable.
    const unitNameExpr = m.unitColumn
      ? m.hasUnitLookup
        ? `COALESCE(us.unitsellname, c.${m.unitColumn})`
        : `c.${m.unitColumn}`
      : "NULL";
    const typeExpr = m.hasDrugType ? "c.drugtype" : "NULL";
    const clinicExpr = m.hasClinic ? "vd.clinic" : "NULL";

    return {
      columns: `
        vd.visitno            AS visitno,
        vd.drugcode           AS drugcode,
        c.drugname            AS drugname,
        ${typeExpr}           AS drugtype,
        vd.${m.quantityColumn} AS quantity,
        ${unitNameExpr}       AS unit,
        ${unitCodeExpr}       AS unitcode,
        ${clinicExpr}         AS clinic`,
      joins: `
        LEFT JOIN cdrug c ON c.drugcode = vd.drugcode
        ${
          m.unitColumn && m.hasUnitLookup
            ? `LEFT JOIN cdrugunitsell us ON us.unitsellcode = c.${m.unitColumn}`
            : ""
        }`,
    };
  }

  private toRecord(row: DrugRow, usageDate: string, visitMissing: boolean): DrugUsageRecord {
    return {
      visitNo: Number(row.visitno),
      visitMissing,
      drugCode: String(row.drugcode).trim(),
      drugName: row.drugname ? String(row.drugname).trim() : null,
      drugType: row.drugtype ? String(row.drugtype).trim() : null,
      quantity: row.quantity === null ? 0 : Number(row.quantity),
      unit: row.unit ? String(row.unit).trim() : null,
      unitCode: row.unitcode ? String(row.unitcode).trim() : null,
      clinic: row.clinic ? String(row.clinic).trim() : null,
      usageDate,
    };
  }

  /** Total rows in the window - used for progress and batch bookkeeping. */
  async countUsage(pcucode: string, from: string, to: string): Promise<number> {
    const dateExpr = this.dateExpr();
    const row = await this.db.queryOne<RowDataPacket & { n: number }>(
      `SELECT COUNT(*) AS n
         FROM visitdrug vd
         LEFT JOIN visit v ON v.pcucode = vd.pcucode AND v.visitno = vd.visitno
        WHERE vd.pcucode = ? AND ${dateExpr} >= ? AND ${dateExpr} <= ?`,
      [pcucode, from, to],
    );
    return Number(row?.n ?? 0);
  }

  /**
   * Data-quality check: visitdrug rows whose visit record is gone. They are
   * still extracted (dated from dateupdate) - this count exists so an operator
   * can see how much of the data is in that state.
   */
  async countOrphanRows(pcucode: string): Promise<number> {
    const row = await this.db.queryOne<RowDataPacket & { n: number }>(
      `SELECT COUNT(*) AS n
         FROM visitdrug vd
         LEFT JOIN visit v ON v.pcucode = vd.pcucode AND v.visitno = vd.visitno
        WHERE vd.pcucode = ? AND v.visitno IS NULL`,
      [pcucode],
    );
    return Number(row?.n ?? 0);
  }

  /** Every visitdrug row for this facility, whether or not it joins to a visit. */
  async countAllRows(pcucode: string): Promise<number> {
    const row = await this.db.queryOne<RowDataPacket & { n: number }>(
      "SELECT COUNT(*) AS n FROM visitdrug WHERE pcucode = ?",
      [pcucode],
    );
    return Number(row?.n ?? 0);
  }

  /**
   * Streams the window as batches of dispensing rows.
   *
   * Ordering is (visitdate, visitno, drugcode), which is unique because the
   * visitdrug primary key is (pcucode, visitno, drugcode) - so no row is
   * skipped or repeated across batches even though visitdrug itself is stored
   * in no particular order.
   */
  async *streamUsage(
    pcucode: string,
    from: string,
    to: string,
    _pageSize = 500,
  ): AsyncGenerator<DrugUsageRecord[]> {
    const { columns, joins } = this.drugSelect();

    // 1. Walk the visits in the window through the vs_date index, keyset-style.
    let cursorDate = from;
    let cursorVisitNo = -1;

    for (;;) {
      const visits = await this.db.query<VisitRow>(
        `SELECT visitno, DATE_FORMAT(visitdate, '%Y-%m-%d') AS visitdate
           FROM visit
          WHERE pcucode = ?
            AND visitdate >= ? AND visitdate <= ?
            AND (visitdate > ? OR (visitdate = ? AND visitno > ?))
          ORDER BY visitdate, visitno
          LIMIT ?`,
        [pcucode, from, to, cursorDate, cursorDate, cursorVisitNo, VISIT_BATCH],
      );
      if (!visits.length) break;

      const dateByVisit = new Map<number, string>();
      for (const visit of visits) dateByVisit.set(Number(visit.visitno), String(visit.visitdate));

      const placeholders = visits.map(() => "?").join(",");
      const rows = await this.db.query<DrugRow>(
        `SELECT ${columns}
           FROM visitdrug vd
           ${joins}
          WHERE vd.pcucode = ? AND vd.visitno IN (${placeholders})
          ORDER BY vd.visitno, vd.drugcode`,
        [pcucode, ...visits.map((visit) => Number(visit.visitno))],
      );

      if (rows.length) {
        yield rows.map((row) =>
          this.toRecord(row, dateByVisit.get(Number(row.visitno)) ?? from, false),
        );
      }

      const last = visits[visits.length - 1];
      cursorDate = String(last.visitdate);
      cursorVisitNo = Number(last.visitno);
      if (visits.length < VISIT_BATCH) break;
    }

    // 2. Dispensing rows whose visit record was deleted. A pharmacist did key
    // them, so they are reported rather than dropped: dated from dateupdate and
    // flagged so the central side can tell them apart.
    const orphans = await this.db.query<OrphanRow>(
      `SELECT ${columns},
              DATE_FORMAT(DATE(vd.dateupdate), '%Y-%m-%d') AS usagedate
         FROM visitdrug vd
         LEFT JOIN visit v ON v.pcucode = vd.pcucode AND v.visitno = vd.visitno
         ${joins}
        WHERE vd.pcucode = ?
          AND v.visitno IS NULL
          AND DATE(vd.dateupdate) >= ? AND DATE(vd.dateupdate) <= ?
        ORDER BY vd.visitno, vd.drugcode`,
      [pcucode, from, to],
    );
    if (orphans.length) {
      yield orphans.map((row) => this.toRecord(row, String(row.usagedate), true));
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

  /**
   * Rows per month as JHCIS sees them. Compared against the same tally from the
   * central database to find windows that were never delivered in full.
   */
  async monthlyTally(
    pcucode: string,
    from: string,
    to: string,
  ): Promise<Array<{ month: string; rows: number }>> {
    const dateExpr = this.dateExpr();
    const rows = await this.db.query<RowDataPacket & { month: string; rows: number }>(
      `SELECT DATE_FORMAT(${dateExpr}, '%Y-%m') AS month, COUNT(*) AS rows
         FROM visitdrug vd
         LEFT JOIN visit v ON v.pcucode = vd.pcucode AND v.visitno = vd.visitno
        WHERE vd.pcucode = ? AND ${dateExpr} >= ? AND ${dateExpr} <= ?
        GROUP BY month
        ORDER BY month`,
      [pcucode, from, to],
    );
    return rows.map((row) => ({ month: String(row.month), rows: Number(row.rows) }));
  }

  /** Newest dispensing date available locally - the upper bound for a sync. */
  async maxUsageDate(pcucode: string): Promise<string | null> {
    const row = await this.db.queryOne<RowDataPacket & { d: string | null }>(
      `SELECT DATE_FORMAT(MAX(${this.dateExpr()}), '%Y-%m-%d') AS d
         FROM visitdrug vd
         LEFT JOIN visit v ON v.pcucode = vd.pcucode AND v.visitno = vd.visitno
        WHERE vd.pcucode = ?`,
      [pcucode],
    );
    return row?.d ?? null;
  }

  /** Oldest dispensing date - the lower bound for an initial sync. */
  async minUsageDate(pcucode: string): Promise<string | null> {
    const row = await this.db.queryOne<RowDataPacket & { d: string | null }>(
      `SELECT DATE_FORMAT(MIN(${this.dateExpr()}), '%Y-%m-%d') AS d
         FROM visitdrug vd
         LEFT JOIN visit v ON v.pcucode = vd.pcucode AND v.visitno = vd.visitno
        WHERE vd.pcucode = ?`,
      [pcucode],
    );
    return row?.d ?? null;
  }
}
