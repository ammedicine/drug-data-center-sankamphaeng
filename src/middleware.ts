import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE } from "@/lib/auth/session";

/** Paths that require a session. Everything else is public (login, register). */
const PROTECTED = ["/dashboard", "/reports", "/admin", "/sync"];

/**
 * The Content-Security-Policy has to be built per request, not declared in
 * next.config.ts, because Next.js renders its own inline bootstrap scripts on
 * every page: without a nonce for them, `script-src 'self'` blocks the
 * hydration payload and the browser shows a blank page. Next reads the nonce
 * back off the request header and stamps it onto the scripts it emits.
 *
 * 'strict-dynamic' then lets those trusted scripts pull in the chunks they
 * need, so no host allowlist is required. Styles still need 'unsafe-inline'
 * for Tailwind's runtime injection; scripts do not, which is what matters.
 */
function contentSecurityPolicy(nonce: string): string {
  const dev = process.env.NODE_ENV !== "production";
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "connect-src 'self'",
    // The dev overlay compiles with eval; production never gets it.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "upgrade-insecure-requests",
  ].join("; ");
}

/**
 * Cheap edge gate: unauthenticated requests never reach a protected page. Real
 * authorization (role + facility scope) is enforced again server-side in every
 * page and route handler - this is defence in depth, not the decision point.
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const csp = contentSecurityPolicy(nonce);

  const needsSession = PROTECTED.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
  if (needsSession && !req.cookies.get(SESSION_COOKIE)?.value) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    const redirect = NextResponse.redirect(url);
    redirect.headers.set("Content-Security-Policy", csp);
    return redirect;
  }

  // The request copy carries the nonce inward so the renderer can use it; the
  // response carries the policy outward so the browser enforces it.
  const headers = new Headers(req.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  // Everything except static assets: the policy has to reach the pages that
  // render scripts, which includes /login, not only the protected areas.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
