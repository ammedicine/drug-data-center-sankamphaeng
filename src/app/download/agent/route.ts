/**
 * Public download of the Agent installer.
 *
 * Deliberately outside the authenticated area: the person installing the Agent
 * on a รพ.สต. PC is often not the person with a dashboard account, and the
 * installer is not a secret - it contains no credentials and is useless until
 * it is enrolled with a one-time token issued by an administrator.
 *
 * What it does protect is the source: the repository is private, and this
 * route is the only thing holding a token for it. It takes no parameters, so
 * there is nothing to point somewhere else.
 */
import { NextResponse } from "next/server";

import { openAgentInstaller } from "@/lib/services/agent-release";
import { DOWNLOAD_RULE, rateLimit } from "@/lib/security/rate-limit";
import { clientIp } from "@/lib/services/audit";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const ip = clientIp(req.headers);
  const limit = rateLimit(`installer:${ip ?? "unknown"}`, DOWNLOAD_RULE);
  if (!limit.allowed) {
    return new NextResponse("ดาวน์โหลดถี่เกินไป กรุณารอสักครู่", {
      status: 429,
      headers: { "Retry-After": String(limit.retryAfterSeconds) },
    });
  }

  const installer = await openAgentInstaller();
  if (!installer) {
    return new NextResponse("ยังไม่มีไฟล์ติดตั้งเผยแพร่ กรุณาติดต่อผู้ดูแลระบบ", { status: 404 });
  }

  return new NextResponse(installer.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(installer.sizeBytes),
      "Content-Disposition": `attachment; filename="${installer.fileName}"`,
      "Cache-Control": "no-store",
    },
  });
}
