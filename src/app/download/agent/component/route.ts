import { NextResponse } from "next/server";

import { openAgentComponent } from "@/lib/services/agent-release";
import { DOWNLOAD_RULE, rateLimit } from "@/lib/security/rate-limit";
import { clientIp } from "@/lib/services/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const ip = clientIp(request.headers);
  const limit = rateLimit(`agent-component:${ip ?? "unknown"}`, DOWNLOAD_RULE);
  if (!limit.allowed) return new NextResponse("rate limited", { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } });
  const url = new URL(request.url);
  const version = url.searchParams.get("version") ?? "";
  const asset = url.searchParams.get("asset") ?? "";
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^SDCAgent-Component-[A-Za-z0-9._-]+$/.test(asset)) {
    return new NextResponse("invalid component", { status: 400 });
  }
  const component = await openAgentComponent(version, asset);
  if (!component) return new NextResponse("verified component unavailable", { status: 503 });
  return new NextResponse(component.body, { headers: {
    "Content-Type": "application/octet-stream",
    "Content-Length": String(component.sizeBytes),
    "Content-Disposition": `attachment; filename="${component.fileName}"`,
    "Cache-Control": "no-store",
  } });
}
