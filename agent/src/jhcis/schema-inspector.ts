/**
 * SchemaInspector (JHCIS_INTEGRATION sections 3, 8, 9, 28).
 *
 * Nothing about the JHCIS schema is assumed. The inspector reads
 * information_schema, resolves which column actually holds the dispensed
 * amount, and produces a compatibility report that is sent to the central
 * server so an admin can see exactly what this installation supports.
 *
 * Verified on the reference database (JHCIS V5.1 / MySQL 5.6):
 *   visitdrug(pcucode, visitno, drugcode, unit, dose, clinic, dateupdate)
 *   visit(pcucode, visitno, visitdate)
 *   cdrug(drugcode, drugname, drugtype, drugflag, unitsell, unitusage)
 * There is no quantity column named "quantity": the dispensed amount is
 * visitdrug.unit, which is why candidates are probed in priority order.
 */
import type { RowDataPacket } from "mysql2/promise";

import type { SchemaReport } from "@shared/canonical";

import type { JhcisConnection } from "./connection";

/** Candidate columns for the dispensed amount, most specific first. */
const QUANTITY_CANDIDATES = ["unit", "qty", "quantity", "amount", "numberdrug", "drugamount"];
/** Candidate columns for the dispensing/service date on visitdrug itself. */
const VISITDRUG_DATE_CANDIDATES = ["dateservice", "datedispense", "dispensedate"];
/** Candidate unit-of-measure columns on cdrug. */
const UNIT_CANDIDATES = ["unitsell", "unitusage", "unitpacking"];

const REQUIRED_TABLES = ["cdrug", "visitdrug", "visit"];
/** unit codes in cdrug.unitsell are meaningless on their own: cdrugunitsell holds the names */
const UNIT_LOOKUP_TABLE = "cdrugunitsell";

export interface SchemaMapping {
  /** table.column holding the dispensed amount */
  quantityColumn: string;
  /** column on cdrug holding the unit of measure, if any */
  unitColumn: string | null;
  /** where the dispensing date comes from: a visitdrug column or visit.visitdate */
  dateColumn: string;
  dateFromVisit: boolean;
  hasClinic: boolean;
  hasDrugType: boolean;
  hasGenericName: boolean;
  /** cdrugunitsell(unitsellcode, unitsellname) is available for unit names */
  hasUnitLookup: boolean;
}

export class SchemaInspector {
  constructor(private readonly db: JhcisConnection) {}

  private async columnsOf(table: string): Promise<Set<string>> {
    const rows = await this.db.query<RowDataPacket & { COLUMN_NAME: string }>(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [table],
    );
    return new Set(rows.map((r) => String(r.COLUMN_NAME).toLowerCase()));
  }

  private async tableExists(table: string): Promise<boolean> {
    const row = await this.db.queryOne<RowDataPacket & { n: number }>(
      `SELECT COUNT(*) AS n FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [table],
    );
    return Number(row?.n ?? 0) > 0;
  }

  /** Reads this installation's own pcucode from office.offid (0000x is a placeholder). */
  async detectPcucode(): Promise<string | null> {
    if (await this.tableExists("office")) {
      const row = await this.db.queryOne<RowDataPacket & { offid: string }>(
        "SELECT offid FROM office WHERE offid IS NOT NULL AND offid <> '0000x' ORDER BY offid LIMIT 1",
      );
      if (row?.offid) return String(row.offid).trim();
    }
    // Fallback: the pcucode that actually owns the visit data.
    const row = await this.db.queryOne<RowDataPacket & { pcucode: string }>(
      "SELECT pcucode FROM visit GROUP BY pcucode ORDER BY COUNT(*) DESC LIMIT 1",
    );
    return row?.pcucode ? String(row.pcucode).trim() : null;
  }

  async detectFacilityName(pcucode: string | null): Promise<string | null> {
    if (!pcucode || !(await this.tableExists("chospital"))) return null;
    const row = await this.db.queryOne<RowDataPacket & { hosname: string }>(
      "SELECT hosname FROM chospital WHERE hoscode = ? LIMIT 1",
      [pcucode],
    );
    return row?.hosname ? String(row.hosname).trim() : null;
  }

  /** JHCIS does not expose a version table on every build; best effort only. */
  async detectJhcisVersion(): Promise<string | null> {
    for (const table of ["cversion", "sysversion", "cconfig"]) {
      if (!(await this.tableExists(table))) continue;
      try {
        const row = await this.db.queryOne<RowDataPacket>(`SELECT * FROM ${table} LIMIT 1`);
        if (!row) continue;
        for (const [key, value] of Object.entries(row)) {
          if (/version/i.test(key) && value) return String(value).slice(0, 40);
        }
      } catch {
        // ignore: the table exists but is not shaped as expected
      }
    }
    return null;
  }

  /** Full compatibility report + the mapping the extractor will use. */
  async inspect(): Promise<{ report: SchemaReport; mapping: SchemaMapping | null }> {
    const warnings: string[] = [];
    const tables: Record<string, boolean> = {};
    for (const table of REQUIRED_TABLES) {
      tables[table] = await this.tableExists(table);
      if (!tables[table]) warnings.push(`ไม่พบตาราง ${table} ใน JHCISDB`);
    }
    tables.office = await this.tableExists("office");

    // Unit names live in a lookup table; without it the report would show raw
    // codes like "027" instead of "เม็ด".
    const unitLookupCols = (await this.tableExists(UNIT_LOOKUP_TABLE))
      ? await this.columnsOf(UNIT_LOOKUP_TABLE)
      : new Set<string>();
    const hasUnitLookup =
      unitLookupCols.has("unitsellcode") && unitLookupCols.has("unitsellname");
    tables[UNIT_LOOKUP_TABLE] = hasUnitLookup;
    if (!hasUnitLookup) {
      warnings.push(
        `ไม่พบตาราง ${UNIT_LOOKUP_TABLE}(unitsellcode, unitsellname) - รายงานจะแสดงรหัสหน่วยแทนชื่อหน่วย`,
      );
    }

    const columns: Record<string, Record<string, boolean>> = {};
    const cdrugCols = tables.cdrug ? await this.columnsOf("cdrug") : new Set<string>();
    const visitdrugCols = tables.visitdrug ? await this.columnsOf("visitdrug") : new Set<string>();
    const visitCols = tables.visit ? await this.columnsOf("visit") : new Set<string>();

    columns.cdrug = {
      drugcode: cdrugCols.has("drugcode"),
      drugname: cdrugCols.has("drugname"),
      drugtype: cdrugCols.has("drugtype"),
      drugflag: cdrugCols.has("drugflag"),
      unitsell: cdrugCols.has("unitsell"),
    };
    columns.visitdrug = {
      pcucode: visitdrugCols.has("pcucode"),
      visitno: visitdrugCols.has("visitno"),
      drugcode: visitdrugCols.has("drugcode"),
    };
    columns.visit = {
      pcucode: visitCols.has("pcucode"),
      visitno: visitCols.has("visitno"),
      visitdate: visitCols.has("visitdate"),
    };

    const quantityColumn = QUANTITY_CANDIDATES.find((c) => visitdrugCols.has(c)) ?? null;
    if (quantityColumn) columns.visitdrug[quantityColumn] = true;
    else warnings.push(`ไม่พบคอลัมน์จำนวนจ่ายใน visitdrug (ตรวจหา: ${QUANTITY_CANDIDATES.join(", ")})`);

    const visitdrugDate = VISITDRUG_DATE_CANDIDATES.find((c) => visitdrugCols.has(c)) ?? null;
    const dateFromVisit = !visitdrugDate;
    const dateColumn = visitdrugDate ?? "visitdate";
    if (dateFromVisit && !visitCols.has("visitdate")) {
      warnings.push("ไม่พบทั้งวันที่จ่ายยาใน visitdrug และ visit.visitdate");
    }

    const unitColumn = UNIT_CANDIDATES.find((c) => cdrugCols.has(c)) ?? null;
    if (!unitColumn) warnings.push("ไม่พบคอลัมน์หน่วยนับใน cdrug - รายงานจะไม่มีหน่วย");

    const pcucode = tables.visit ? await this.detectPcucode() : null;
    const facilityName = await this.detectFacilityName(pcucode);

    const usable =
      Boolean(quantityColumn) &&
      tables.cdrug &&
      tables.visitdrug &&
      columns.visitdrug.visitno &&
      columns.visitdrug.drugcode &&
      (!dateFromVisit || (tables.visit && columns.visit.visitdate));

    const report: SchemaReport = {
      database: process.env.JHCIS_DB_DATABASE ?? "jhcisdb",
      mysqlVersion: await this.db.mysqlVersion(),
      jhcisVersion: await this.detectJhcisVersion(),
      pcucode,
      facilityName,
      tables,
      columns,
      capabilities: {
        supportsDrugUsage: Boolean(usable),
        supportsQuantity: Boolean(quantityColumn),
        supportsDispensedDate: dateFromVisit ? columns.visit.visitdate : true,
        supportsDrugType: cdrugCols.has("drugtype"),
        supportsUnitName: hasUnitLookup,
      },
      mapping: {
        quantityColumn: quantityColumn ? `visitdrug.${quantityColumn}` : null,
        unitColumn: unitColumn
          ? hasUnitLookup
            ? `cdrug.${unitColumn} -> ${UNIT_LOOKUP_TABLE}.unitsellname`
            : `cdrug.${unitColumn}`
          : null,
        dateColumn: dateFromVisit ? "visit.visitdate" : `visitdrug.${dateColumn}`,
      },
      warnings,
    };

    const mapping: SchemaMapping | null = usable
      ? {
          quantityColumn: quantityColumn as string,
          unitColumn,
          dateColumn,
          dateFromVisit,
          hasClinic: visitdrugCols.has("clinic"),
          hasDrugType: cdrugCols.has("drugtype"),
          hasGenericName: cdrugCols.has("druggenericname"),
          hasUnitLookup,
        }
      : null;

    return { report, mapping };
  }
}
