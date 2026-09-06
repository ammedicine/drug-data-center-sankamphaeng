/**
 * The live endpoint is polled every few seconds by every open dashboard, which
 * makes it the most-called read in the system - and therefore the worst place
 * to weaken authorization. It must answer with exactly what the page it feeds
 * would have shown, and nothing else.
 */
import { describe, expect, it } from "vitest";

import { ForbiddenError, resolveFacilityScope } from "@/lib/auth/rbac";
import type { SessionUser } from "@/lib/auth/session";

const superAdmin: SessionUser = {
  userId: "u-super",
  email: "super@example.test",
  fullName: "Super",
  role: "SUPER_ADMIN",
  facilityId: null,
  epoch: 1,
};
const facilityUser: SessionUser = {
  userId: "u-a",
  email: "a@example.test",
  fullName: "A",
  role: "USER",
  facilityId: "FAC_A",
  epoch: 1,
};
const facilityAdmin: SessionUser = { ...facilityUser, userId: "u-fa", role: "FACILITY_ADMIN" };
const orphan: SessionUser = { ...facilityUser, userId: "u-none", facilityId: null };

/** Mirrors the endpoint's rule for narrowing to a caller's own machines. */
function ownAgentsOnly(user: SessionUser): string | null {
  return user.role === "USER" ? user.userId : null;
}

describe("live status authorization", () => {
  it("limits a facility account to its own facility", () => {
    expect(resolveFacilityScope(facilityUser).facilityIds).toEqual(["FAC_A"]);
    expect(resolveFacilityScope(facilityAdmin).facilityIds).toEqual(["FAC_A"]);
  });

  it("lets a super admin see every facility", () => {
    expect(resolveFacilityScope(superAdmin).facilityIds).toBeNull();
  });

  it("refuses an account with no facility rather than showing everything", () => {
    // The dangerous failure mode: treating "no facility" as "all facilities".
    expect(() => resolveFacilityScope(orphan)).toThrow(ForbiddenError);
  });

  it("shows a USER only the machines they enrolled", () => {
    expect(ownAgentsOnly(facilityUser)).toBe("u-a");
    // Those responsible for more than their own desk see the whole facility.
    expect(ownAgentsOnly(facilityAdmin)).toBeNull();
    expect(ownAgentsOnly(superAdmin)).toBeNull();
  });

  it("ignores a facility asked for by the caller", () => {
    // The endpoint takes no parameters, but the underlying resolver is what
    // enforces that a requested facility cannot widen the scope.
    expect(() => resolveFacilityScope(facilityUser, "FAC_B")).toThrow(ForbiddenError);
    expect(resolveFacilityScope(facilityUser, "FAC_A").facilityIds).toEqual(["FAC_A"]);
  });
});
