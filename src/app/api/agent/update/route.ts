import { NextResponse } from "next/server";

import { lookupLatestAgentRelease } from "@/lib/services/agent-release";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/agent/update — what the current published installer is.
 *
 * Everything an Agent needs to decide whether to update and to prove that what
 * it downloaded is what was published. It takes no parameters, so no caller
 * can point it at another repository, another release or another file; the
 * lookup is fixed at build time and runs server side with a token that never
 * leaves the server.
 *
 * Unauthenticated on purpose, and safe to be: it says only what is already
 * public on the download page, names no facility and carries no secret. An
 * Agent whose clock has drifted cannot sign a request, and refusing to tell it
 * about a fix it might need would be the wrong way round.
 *
 * `sha256` is the hash GitHub recorded when the asset was uploaded. When it is
 * absent the Agent must show the update and refuse to install it unattended -
 * `autoInstall` says so explicitly rather than leaving that to be inferred.
 */
export async function GET() {
  const lookup = await lookupLatestAgentRelease();

  if (lookup.status !== "ok") {
    return NextResponse.json(
      { available: false, reason: lookup.status },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const { release } = lookup;
  return NextResponse.json(
    {
      available: true,
      channel: "stable",
      version: release.version.replace(/^v/i, ""),
      tag: release.version,
      assetName: release.fileName,
      size: release.sizeBytes,
      sha256: release.sha256,
      // No hash, no unattended install. The Agent is told plainly rather than
      // having to work it out from a missing field.
      autoInstall: release.sha256 !== null,
      downloadUrl: "/download/agent",
      publishedAt: release.publishedAt,
      releaseUrl: `https://github.com/ammedicine/drug-data-center-sankamphaeng/releases/tag/${release.version}`,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
