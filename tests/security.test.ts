/**
 * Security-critical unit tests (PROJECT_SPEC section 34).
 * These cover the rules that must never regress: facility isolation, agent
 * identity, replay-proof signing and idempotent record keys.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { encryptSecret, decryptSecret } from "@/lib/agent-auth/crypto";
import {
  ForbiddenError,
  canManageSystem,
  canViewAllFacilities,
  resolveDrugTypeScope,
  resolveFacilityScope,
} from "@/lib/auth/rbac";
import type { SessionUser } from "@/lib/auth/session";
import {
  buildSigningString,
  drugUsageRecordKey,
  signRequest,
} from "@/lib/shared/canonical";

const superAdmin: SessionUser = {
  userId: "u1",
  email: "admin@example.org",
  fullName: "Super",
  role: "SUPER_ADMIN",
  facilityId: null,
  epoch: 1,
};

const facilityAUser: SessionUser = {
  userId: "u2",
  email: "a@example.org",
  fullName: "A",
  role: "USER",
  facilityId: "FAC_A",
  epoch: 1,
};

const facilityAAdmin: SessionUser = { ...facilityAUser, userId: "u3", role: "FACILITY_ADMIN" };

/** district-wide read-only account */
const admin: SessionUser = {
  userId: "u4",
  email: "viewer@example.org",
  fullName: "Admin",
  role: "ADMIN",
  facilityId: null,
  epoch: 1,
};

describe("facility isolation", () => {
  it("pins a facility user to its own facility", () => {
    expect(resolveFacilityScope(facilityAUser).facilityIds).toEqual(["FAC_A"]);
  });

  it("rejects a user of facility A asking for facility B", () => {
    expect(() => resolveFacilityScope(facilityAUser, "FAC_B")).toThrow(ForbiddenError);
    expect(() => resolveFacilityScope(facilityAAdmin, "FAC_B")).toThrow(ForbiddenError);
  });

  it("does not silently fall back to the user's own facility", () => {
    // A silent fallback would hide an escalation attempt instead of failing it.
    try {
      resolveFacilityScope(facilityAUser, "FAC_B");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenError);
    }
  });

  it("treats ALL as the user's own facility, never as every facility", () => {
    expect(resolveFacilityScope(facilityAUser, "ALL").facilityIds).toEqual(["FAC_A"]);
  });

  it("lets a super admin read all facilities or pick one", () => {
    expect(resolveFacilityScope(superAdmin).facilityIds).toBeNull();
    expect(resolveFacilityScope(superAdmin, "FAC_B").facilityIds).toEqual(["FAC_B"]);
  });

  it("refuses a non-super-admin account with no facility binding", () => {
    expect(() => resolveFacilityScope({ ...facilityAUser, facilityId: null })).toThrow(
      ForbiddenError,
    );
  });
});

describe("ADMIN is read-everything, change-nothing", () => {
  it("reads every facility like a super admin", () => {
    expect(canViewAllFacilities(admin)).toBe(true);
    expect(resolveFacilityScope(admin).facilityIds).toBeNull();
    expect(resolveFacilityScope(admin, "FAC_B").facilityIds).toEqual(["FAC_B"]);
  });

  it("cannot manage the system", () => {
    expect(canManageSystem(admin)).toBe(false);
    expect(canManageSystem(facilityAAdmin)).toBe(false);
    expect(canManageSystem(superAdmin)).toBe(true);
  });

  it("does not grant facility users a wider view", () => {
    expect(canViewAllFacilities(facilityAUser)).toBe(false);
    expect(canViewAllFacilities(facilityAAdmin)).toBe(false);
  });
});

describe("drug category scope", () => {
  const PRIMARY = ["01", "05", "10"];

  it("defaults every role to the three medicine categories", () => {
    expect(resolveDrugTypeScope(facilityAUser).types).toEqual(PRIMARY);
    expect(resolveDrugTypeScope(admin).types).toEqual(PRIMARY);
    expect(resolveDrugTypeScope(superAdmin).types).toEqual(PRIMARY);
  });

  it("refuses to widen the scope for anyone but a super admin", () => {
    expect(resolveDrugTypeScope(facilityAUser, ["02", "11"]).types).toEqual(PRIMARY);
    expect(resolveDrugTypeScope(admin, ["02"]).types).toEqual(PRIMARY);
    expect(resolveDrugTypeScope(facilityAAdmin, ["01", "02"]).types).toEqual(["01"]);
  });

  it("lets a super admin add other categories", () => {
    expect(resolveDrugTypeScope(superAdmin, ["01", "02"]).types).toEqual(["01", "02"]);
    expect(resolveDrugTypeScope(superAdmin).canWiden).toBe(true);
    expect(resolveDrugTypeScope(admin).canWiden).toBe(false);
  });

  it("allows narrowing within the allowed categories", () => {
    expect(resolveDrugTypeScope(facilityAUser, ["05"]).types).toEqual(["05"]);
  });
});

describe("drug usage record key", () => {
  const base = { facilityId: "FAC_A", pcucode: "05957", visitNo: 132449, drugCode: "P76" };

  it("is stable across repeated uploads (idempotency)", () => {
    expect(drugUsageRecordKey(base)).toBe(drugUsageRecordKey({ ...base }));
  });

  it("ignores surrounding whitespace in the drug code", () => {
    expect(drugUsageRecordKey({ ...base, drugCode: " P76 " })).toBe(drugUsageRecordKey(base));
  });

  it("accepts the visit number as string or number", () => {
    expect(drugUsageRecordKey({ ...base, visitNo: "132449" })).toBe(drugUsageRecordKey(base));
  });

  it("separates the same JHCIS row belonging to different facilities", () => {
    expect(drugUsageRecordKey({ ...base, facilityId: "FAC_B" })).not.toBe(drugUsageRecordKey(base));
  });

  it("separates different drugs inside the same visit", () => {
    expect(drugUsageRecordKey({ ...base, drugCode: "P77" })).not.toBe(drugUsageRecordKey(base));
  });
});

describe("agent request signing", () => {
  const secret = "test-secret-value";
  const args = {
    method: "POST",
    path: "/api/agent/sync/upload",
    timestamp: "1780000000",
    nonce: "abcdef0123456789",
    body: JSON.stringify({ batchRef: "SYNC-20260904-000001" }),
  };

  it("produces the same signature for identical inputs", () => {
    expect(signRequest(secret, buildSigningString(args))).toBe(
      signRequest(secret, buildSigningString(args)),
    );
  });

  it("changes when the body changes (payload binding)", () => {
    const tampered = { ...args, body: JSON.stringify({ batchRef: "SYNC-20260904-000002" }) };
    expect(signRequest(secret, buildSigningString(tampered))).not.toBe(
      signRequest(secret, buildSigningString(args)),
    );
  });

  it("changes when the nonce or timestamp changes (replay binding)", () => {
    expect(signRequest(secret, buildSigningString({ ...args, nonce: "0000000000000000" }))).not.toBe(
      signRequest(secret, buildSigningString(args)),
    );
    expect(signRequest(secret, buildSigningString({ ...args, timestamp: "1780000001" }))).not.toBe(
      signRequest(secret, buildSigningString(args)),
    );
  });

  it("changes when the path changes (endpoint binding)", () => {
    expect(
      signRequest(secret, buildSigningString({ ...args, path: "/api/agent/heartbeat" })),
    ).not.toBe(signRequest(secret, buildSigningString(args)));
  });

  it("cannot be produced with another agent's secret", () => {
    expect(signRequest("other-secret", buildSigningString(args))).not.toBe(
      signRequest(secret, buildSigningString(args)),
    );
  });
});

describe("agent credential encryption", () => {
  beforeAll(() => {
    process.env.AGENT_SIGNING_SECRET = "0123456789abcdef0123456789abcdef0123456789";
  });

  it("round-trips the secret", () => {
    const secret = "s3cret-agent-value";
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it("never stores the plaintext in the envelope", () => {
    const secret = "s3cret-agent-value";
    expect(encryptSecret(secret)).not.toContain(secret);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("rejects a tampered envelope", () => {
    const envelope = encryptSecret("value");
    const parts = envelope.split(".");
    parts[3] = `${parts[3].slice(0, -2)}AA`;
    expect(() => decryptSecret(parts.join("."))).toThrow();
  });
});
