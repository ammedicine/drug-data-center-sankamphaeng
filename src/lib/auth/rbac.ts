/**
 * Server-side authorization. Facility isolation is enforced here and nowhere
 * else: UI code must never decide what data a user may read.
 *
 * Rule (PROJECT_SPEC section 5 / JHCIS_INTEGRATION section 21):
 * a facility id coming from the client is only ever a *request*; it is valid
 * only if resolveFacilityScope() says the session may read it.
 */
import { redirect } from "next/navigation";

import { getSession, type SessionUser } from "./session";

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(message = "ไม่มีสิทธิ์เข้าถึงข้อมูลนี้") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class UnauthorizedError extends Error {
  readonly status = 401;
  constructor(message = "กรุณาเข้าสู่ระบบ") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export function isSuperAdmin(user: SessionUser): boolean {
  return user.role === "SUPER_ADMIN";
}

export function canManageFacility(user: SessionUser, facilityId: string): boolean {
  if (isSuperAdmin(user)) return true;
  return user.role === "FACILITY_ADMIN" && user.facilityId === facilityId;
}

export function canManageUsers(user: SessionUser): boolean {
  return user.role === "SUPER_ADMIN" || user.role === "FACILITY_ADMIN";
}

export function canTriggerSync(user: SessionUser): boolean {
  return user.role === "SUPER_ADMIN" || user.role === "FACILITY_ADMIN";
}

/** Page-level guard: redirects to /login instead of throwing. */
export async function requireUser(): Promise<SessionUser> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

export async function requireSuperAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (!isSuperAdmin(user)) redirect("/dashboard?error=forbidden");
  return user;
}

/** API-level guard: throws so the route handler can map it to a status code. */
export async function requireApiUser(): Promise<SessionUser> {
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  return session;
}

/**
 * Turns an optional, client-supplied facility id into the set of facilities the
 * query may actually touch.
 *
 * - SUPER_ADMIN: may pass one facility id, or nothing to mean "all facilities"
 * - everyone else: pinned to their own facility; any other id is a 403, never a
 *   silent fallback (a silent fallback would hide an escalation attempt)
 */
export function resolveFacilityScope(
  user: SessionUser,
  requestedFacilityId?: string | null,
): { facilityIds: string[] | null; single: string | null } {
  if (isSuperAdmin(user)) {
    if (requestedFacilityId && requestedFacilityId !== "ALL") {
      return { facilityIds: [requestedFacilityId], single: requestedFacilityId };
    }
    return { facilityIds: null, single: null }; // null = no facility filter
  }

  if (!user.facilityId) throw new ForbiddenError("บัญชีนี้ยังไม่ได้ผูกกับสถานบริการ");

  if (
    requestedFacilityId &&
    requestedFacilityId !== "ALL" &&
    requestedFacilityId !== user.facilityId
  ) {
    throw new ForbiddenError();
  }

  return { facilityIds: [user.facilityId], single: user.facilityId };
}
