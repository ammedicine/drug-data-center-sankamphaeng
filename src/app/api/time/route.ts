import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/time — what time the centre thinks it is.
 *
 * An Agent whose Windows clock has drifted cannot sign a request the centre
 * will accept, so it cannot ask an authenticated endpoint what the time is:
 * the answer it needs is behind the door its wrong clock has locked. This one
 * is deliberately open, and deliberately empty of everything else. It says
 * only what a public HTTPS `Date` header already says, in a form that does not
 * depend on a proxy preserving that header.
 *
 * Nothing here is a secret and nothing identifies a facility, an agent or a
 * person, so there is nothing to leak and no reason to authenticate.
 */
export function GET() {
  const now = new Date();
  return NextResponse.json(
    { serverTime: now.toISOString(), serverUnixMs: now.getTime() },
    { headers: { "cache-control": "no-store, max-age=0" } },
  );
}
