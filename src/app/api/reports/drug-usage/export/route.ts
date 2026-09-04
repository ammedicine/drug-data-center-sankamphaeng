import { NextResponse, type NextRequest } from "next/server";

import {
  ForbiddenError,
  requireApiUser,
  resolveDrugTypeScope,
  resolveFacilityScope,
  UnauthorizedError,
} from "@/lib/auth/rbac";
import { EXPORT_RULE, rateLimit } from "@/lib/security/rate-limit";
import { clientIp, writeAudit } from "@/lib/services/audit";
import { getUsageByDrug } from "@/lib/services/reports";
import { drugStatus, drugTypeLabel } from "@/lib/shared/canonical";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ROWS = 50_000;

function csvCell(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * GET /api/reports/drug-usage/export
 * CSV export of the aggregated report, scoped exactly like the on-screen table.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await requireApiUser();

    // An export is the cheapest way to pull a lot of data out at once, so it is
    // capped per account as well as logged.
    const limit = rateLimit(`export:${user.userId}`, EXPORT_RULE);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "ส่งออกข้อมูลบ่อยเกินไป กรุณารอสักครู่" },
        { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } },
      );
    }

    const url = new URL(req.url);

    const today = new Date().toISOString().slice(0, 10);
    const from = url.searchParams.get("from") ?? today;
    const to = url.searchParams.get("to") ?? today;
    const scope = resolveFacilityScope(user, url.searchParams.get("facility"));
    const requestedTypes = (url.searchParams.get("types") ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => /^\d{1,2}$/.test(item));
    const typeScope = resolveDrugTypeScope(user, requestedTypes);

    const { rows } = await getUsageByDrug(
      {
        facilityIds: scope.facilityIds,
        from,
        to,
        drugTypes: typeScope.types,
        search: url.searchParams.get("q"),
      },
      { page: 1, pageSize: MAX_ROWS },
    );

    const header = [
      "ลำดับ",
      "รหัสยา",
      "ชื่อยา",
      "ประเภท",
      "สถานะรหัส",
      "ครั้งที่จ่าย",
      "จำนวนจ่าย",
      "หน่วย",
    ];
    const body = rows.map((row, index) =>
      [
        index + 1,
        row.drugCode,
        row.drugName,
        drugTypeLabel(row.drugType),
        drugStatus(row.drugFlag).label,
        row.dispensingRows,
        row.totalQuantity,
        row.unit ?? "",
      ]
        .map(csvCell)
        .join(","),
    );

    await writeAudit({
      actorType: "USER",
      actorId: user.userId,
      actorLabel: user.email,
      action: "REPORT_EXPORT",
      resource: "drug_usage_report",
      facilityId: scope.single,
      ip: clientIp(req.headers),
      metadata: { from, to, rows: rows.length, drugTypes: typeScope.types },
    });

    // BOM so Excel on Windows opens the Thai text correctly.
    const csv = `﻿${[header.map(csvCell).join(","), ...body].join("\r\n")}`;

    return new NextResponse(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="drug-usage-${from}_${to}.csv"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof ForbiddenError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    console.error("[export] failed", error);
    return NextResponse.json({ error: "ไม่สามารถส่งออกรายงานได้" }, { status: 500 });
  }
}
