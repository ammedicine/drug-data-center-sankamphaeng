/**
 * Server-side authorization. Facility isolation is enforced here and nowhere
 * else: UI code must never decide what data a user may read.
 *
 * Rule (PROJECT_SPEC section 5 / JHCIS_INTEGRATION section 21):
 * a facility id coming from the client is only ever a *request*; it is valid
 * only if resolveFacilityScope() says the session may read it.
 */
import { redirect } from "next/navigation";

import { PRIMARY_DRUG_TYPES } from "@/lib/shared/canonical";

import { checkSessionStillValid } from "./session-guard";
import { getSession, type SessionUser } from "./session";

/**
 * Which cdrug.drugtype values a session may read.
 *
 * USER / FACILITY_ADMIN / ADMIN are limited to the dispensed-medicine
 * categories (01 ยาแผนปัจจุบัน, 10 ยาสมุนไพร) - the rest of cdrug is supplies
 * and service items, and 05 วัคซีน belongs to EPI, which this system does not
 * report. SUPER_ADMIN defaults to the same set but may widen it (including to
 * 05), so the default view is comparable across roles.
 *
 * Like the facility scope, this is decided here and never taken from the
 * client, so a crafted query string cannot widen it.
 */
export function resolveDrugTypeScope(
  user: SessionUser,
  requested?: string[] | null,
): { types: string[]; canWiden: boolean } {
  const primary: string[] = [...PRIMARY_DRUG_TYPES];
  const canWiden = user.role === "SUPER_ADMIN";

  if (!requested || requested.length === 0) return { types: primary, canWiden };
  if (canWiden) return { types: requested, canWiden };

  const allowed = requested.filter((type) => primary.includes(type));
  return { types: allowed.length ? allowed : primary, canWiden };
}

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

/**
 * SUPER_ADMIN and ADMIN both read every facility; only SUPER_ADMIN may change
 * anything. Keeping "can see" and "can change" as separate predicates is what
 * makes ADMIN a genuinely read-only role instead of an honour system.
 */
export function canViewAllFacilities(user: SessionUser): boolean {
  return user.role === "SUPER_ADMIN" || user.role === "ADMIN";
}

/** Full administrative control: facilities, agents, users, settings. */
export function canManageSystem(user: SessionUser): boolean {
  return user.role === "SUPER_ADMIN";
}

export function canManageFacility(user: SessionUser, facilityId: string): boolean {
  if (isSuperAdmin(user)) return true;
  // ADMIN is read-only: it never manages, not even its own facility.
  return user.role === "FACILITY_ADMIN" && user.facilityId === facilityId;
}

export function canManageUsers(user: SessionUser): boolean {
  return user.role === "SUPER_ADMIN" || user.role === "FACILITY_ADMIN";
}

/**
 * Only SUPER_ADMIN may turn a self-registered account into a working one.
 *
 * Registration is open to anyone who can reach the site and the applicant picks
 * their own รหัสสถานบริการ, so the person approving has to be able to check that
 * claim against the district's records - which is the central administrator, not
 * an admin of the facility being claimed.
 */
export function canApproveRegistration(user: SessionUser): boolean {
  return user.role === "SUPER_ADMIN";
}

/**
 * Who may ask an agent to pull fresh data.
 *
 * Anyone bound to a facility may refresh their own facility - it only makes the
 * agent read its own JHCIS sooner, and waiting for the next scheduled run is a
 * poor reason to keep staff from up-to-date numbers. ADMIN is excluded because
 * it is a read-only district-wide role and would be acting on other people's
 * facilities.
 */
export function canTriggerSync(user: SessionUser, facilityId?: string | null): boolean {
  if (user.role === "SUPER_ADMIN") return true;
  if (user.role === "ADMIN") return false;
  if (!user.facilityId) return false;
  return !facilityId || facilityId === user.facilityId;
}

/**
 * Page-level guard: redirects to /login instead of throwing.
 *
 * The signed token is not trusted on its own - the account is re-checked
 * against the database, so disabling someone, resetting their password or
 * changing their role takes effect within seconds rather than when their token
 * happens to expire. The role and facility are taken from the database too, so
 * a token issued before a demotion cannot keep the old privileges.
 */
export async function requireUser(): Promise<SessionUser> {
  const session = await getSession();
  if (!session) redirect("/login");

  const check = await checkSessionStillValid(session);
  if (!check.valid) redirect("/login?reason=session-ended");

  return {
    ...session,
    role: (check.current?.role ?? session.role) as SessionUser["role"],
    facilityId: check.current?.facilityId ?? session.facilityId,
  };
}

export async function requireSuperAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (!isSuperAdmin(user)) redirect("/dashboard?error=forbidden");
  return user;
}

/** Pages that ADMIN may read but only SUPER_ADMIN may act on. */
export async function requireAllFacilityViewer(): Promise<SessionUser> {
  const user = await requireUser();
  if (!canViewAllFacilities(user)) redirect("/dashboard?error=forbidden");
  return user;
}

/** API-level guard: throws so the route handler can map it to a status code. */
export async function requireApiUser(): Promise<SessionUser> {
  const session = await getSession();
  if (!session) throw new UnauthorizedError();

  const check = await checkSessionStillValid(session);
  if (!check.valid) throw new UnauthorizedError("เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่");

  return {
    ...session,
    role: (check.current?.role ?? session.role) as SessionUser["role"],
    facilityId: check.current?.facilityId ?? session.facilityId,
  };
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
  if (canViewAllFacilities(user)) {
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
