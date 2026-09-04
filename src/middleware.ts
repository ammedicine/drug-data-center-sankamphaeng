import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE } from "@/lib/auth/session";

/**
 * Cheap edge gate: unauthenticated requests never reach a page. Real
 * authorization (role + facility scope) is enforced again server-side in every
 * page and route handler - this is defence in depth, not the decision point.
 */
export function middleware(req: NextRequest) {
  const hasSession = Boolean(req.cookies.get(SESSION_COOKIE)?.value);
  if (hasSession) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/dashboard/:path*", "/reports/:path*", "/admin/:path*", "/sync/:path*"],
};
