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
import { listFacilityOptions } from "@/lib/services/facilities";
import { getAverageMonthlyDrugUsage } from "@/lib/services/reports";
import { parseReserveMonths, withReserve } from "@/lib/reports/consumption-rate";
import { buildConsumptionRateWorkbook } from "@/lib/reports/drug-consumption-rate-xlsx";
import { resolveMonthRange } from "@/lib/month-range";
import { drugTypeLabel } from "@/lib/shared/canonical";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** A filename safe for the ASCII `filename=` fallback (kept beside filename*). */
function asciiFallback(code: string, from: string, to: string): string {
  return `drug-consumption-rate_${code}_${from}_${to}.xlsx`.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * GET /api/reports/drug-consumption-rate/export
 * Excel (.xlsx) of the average monthly usage + recommended reserve, scoped and
 * validated exactly like the on-screen report.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await requireApiUser();

    const limit = rateLimit(`export:${user.userId}`, EXPORT_RULE);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "ส่งออกข้อมูลบ่อยเกินไป กรุณารอสักครู่" },
        { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } },
      );
    }

    const url = new URL(req.url);
    const startMonth = url.searchParams.get("startMonth");
    const endMonth = url.searchParams.get("endMonth");

    const range = resolveMonthRange(startMonth, endMonth);
    if (!range.ok) {
      return NextResponse.json({ error: range.error }, { status: 400 });
    }
    const reserve = parseReserveMonths(url.searchParams.get("reserveMonths"));
    if (!reserve.ok) {
      return NextResponse.json({ error: reserve.error }, { status: 400 });
    }

    // Authorization: identical to the page. A client facility id is a request.
    const scope = resolveFacilityScope(user, url.searchParams.get("facility"));
    const requestedTypes = (url.searchParams.get("types") ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => /^\d{1,2}$/.test(item));
    const typeScope = resolveDrugTypeScope(user, requestedTypes);

    const { rows } = await getAverageMonthlyDrugUsage(
      {
        facilityIds: scope.facilityIds,
        from: range.range.from,
        to: range.range.to,
        drugTypes: typeScope.types,
      },
      range.range.monthCount,
    );
    const reserveRows = withReserve(rows, reserve.value);

    // Facility label for the header (and filename): the one facility in scope,
    // or all facilities for an authorized district-wide view.
    let facilityLabel = "ทุกสถานบริการ";
    let filenameFacility = "ทุกสถานบริการ";
    if (scope.single) {
      const [facility] = await listFacilityOptions([scope.single]);
      if (facility) {
        facilityLabel = `${facility.code} · ${facility.name}`;
        filenameFacility = facility.code;
      }
    }

    const buffer = await buildConsumptionRateWorkbook({
      facilityLabel,
      startMonth: startMonth as string,
      endMonth: endMonth as string,
      monthCount: range.range.monthCount,
      reserveMonths: reserve.value,
      drugTypesLabel: typeScope.types.map((t) => drugTypeLabel(t)).join(", "),
      generatedAt: new Date(),
      rows: reserveRows,
    });

    await writeAudit({
      actorType: "USER",
      actorId: user.userId,
      actorLabel: user.email,
      action: "REPORT_EXPORT",
      resource: "drug_consumption_rate_report",
      facilityId: scope.single,
      ip: clientIp(req.headers),
      metadata: {
        startMonth,
        endMonth,
        monthCount: range.range.monthCount,
        reserveMonths: reserve.value,
        rows: reserveRows.length,
        drugTypes: typeScope.types,
        format: "xlsx",
      },
    });

    const niceName = `อัตราการใช้ยาเฉลี่ย_${filenameFacility}_${startMonth}_${endMonth}.xlsx`;
    const disposition = `attachment; filename="${asciiFallback(
      filenameFacility,
      startMonth as string,
      endMonth as string,
    )}"; filename*=UTF-8''${encodeURIComponent(niceName)}`;

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "content-type": XLSX_MIME,
        "content-disposition": disposition,
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
    console.error("[consumption-rate export] failed", error);
    return NextResponse.json({ error: "ไม่สามารถส่งออกรายงานได้" }, { status: 500 });
  }
}
