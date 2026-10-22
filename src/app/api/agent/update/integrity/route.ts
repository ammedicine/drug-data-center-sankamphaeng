import { NextResponse } from "next/server";

import { lookupAgentReleaseIntegrity } from "@/lib/services/agent-release";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Exact release manifest, already checked against GitHub's published asset digest. */
export async function GET(request: Request) {
  const version = new URL(request.url).searchParams.get("version") ?? "";
  if (!/^\d+\.\d+\.\d+$/.test(version)) return NextResponse.json({ error: "invalid version" }, { status: 400 });
  const integrity = await lookupAgentReleaseIntegrity(version);
  if (!integrity) return NextResponse.json({ error: "verified manifest unavailable" }, { status: 503 });
  return NextResponse.json({
    version,
    assetName: integrity.manifestAssetName,
    sha256: integrity.manifestSha256,
    contentBase64: Buffer.from(integrity.manifestBytes).toString("base64"),
  }, { headers: { "cache-control": "no-store" } });
}
