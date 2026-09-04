/**
 * Agent enrollment (PROJECT_SPEC section 23).
 *
 * Flow: admin creates an agent -> server issues a ONE-TIME, expiring token ->
 * the token is typed into the installer -> the agent exchanges it for its own
 * long-lived credential. The token is stored hashed and burned on first use.
 */
import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/lib/db";
import { agentCredentials, agentEnrollmentTokens, agents, facilities } from "@/lib/db/schema";
import { newId, randomSecret, sha256 } from "@/lib/ids";

import { AgentAuthError } from "./verify";
import { encryptSecret } from "./crypto";

const DEFAULT_TTL_MINUTES = 60;

export interface EnrollmentTokenIssue {
  token: string;
  expiresAt: Date;
}

/** Issues a one-time enrollment token. The plaintext is returned only here. */
export async function issueEnrollmentToken(input: {
  agentId: string;
  facilityId: string;
  createdByUserId: string;
  ttlMinutes?: number;
}): Promise<EnrollmentTokenIssue> {
  const token = `ENR-${randomSecret(24)}`;
  const expiresAt = new Date(Date.now() + (input.ttlMinutes ?? DEFAULT_TTL_MINUTES) * 60_000);

  // Any previously issued, unused token for this agent is invalidated so only
  // the newest one can be redeemed.
  await db
    .update(agentEnrollmentTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(agentEnrollmentTokens.agentId, input.agentId), isNull(agentEnrollmentTokens.usedAt)));

  await db.insert(agentEnrollmentTokens).values({
    id: newId(),
    agentId: input.agentId,
    facilityId: input.facilityId,
    tokenHash: sha256(token),
    expiresAt,
    createdByUserId: input.createdByUserId,
  });

  return { token, expiresAt };
}

export interface EnrollmentResult {
  agentId: string;
  keyId: string;
  /** plaintext secret - returned exactly once, never logged, never stored raw */
  secret: string;
  facilityId: string;
  facilityCode: string;
  facilityName: string;
  expectedPcucode: string;
  syncIntervalMinutes: number;
  reprocessDays: number;
}

/**
 * Redeems an enrollment token and provisions the agent's own credential.
 * Rejects the exchange when the reported pcucode does not belong to the
 * facility the token was issued for.
 */
export async function redeemEnrollmentToken(input: {
  token: string;
  hostname: string;
  installationId: string;
  agentVersion: string;
  pcucode: string | null;
}): Promise<EnrollmentResult> {
  const tokenHash = sha256(input.token.trim());

  const rows = await db
    .select({
      tokenId: agentEnrollmentTokens.id,
      usedAt: agentEnrollmentTokens.usedAt,
      expiresAt: agentEnrollmentTokens.expiresAt,
      agentId: agents.id,
      agentStatus: agents.status,
      syncIntervalMinutes: agents.syncIntervalMinutes,
      reprocessDays: agents.reprocessDays,
      facilityId: facilities.id,
      facilityCode: facilities.code,
      facilityName: facilities.name,
      expectedPcucode: facilities.jhcisPcucode,
      facilityActive: facilities.isActive,
    })
    .from(agentEnrollmentTokens)
    .innerJoin(agents, eq(agents.id, agentEnrollmentTokens.agentId))
    .innerJoin(facilities, eq(facilities.id, agents.facilityId))
    .where(eq(agentEnrollmentTokens.tokenHash, tokenHash))
    .limit(1);

  const row = rows[0];
  if (!row) throw new AgentAuthError(401, "INVALID_TOKEN", "Enrollment token is not valid");
  if (row.usedAt) throw new AgentAuthError(409, "TOKEN_USED", "Enrollment token was already used");
  if (row.expiresAt.getTime() < Date.now()) {
    throw new AgentAuthError(410, "TOKEN_EXPIRED", "Enrollment token has expired");
  }
  if (!row.facilityActive || row.agentStatus === "DISABLED") {
    throw new AgentAuthError(403, "AGENT_DISABLED", "Agent or facility is disabled");
  }
  if (input.pcucode && input.pcucode.trim() !== row.expectedPcucode.trim()) {
    throw new AgentAuthError(
      403,
      "PCUCODE_MISMATCH",
      `JHCISDB pcucode ${input.pcucode} does not match facility ${row.facilityCode} (${row.expectedPcucode})`,
    );
  }

  // Burn the token first: a crash after this point is safer than a reusable token.
  const burn = await db
    .update(agentEnrollmentTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(agentEnrollmentTokens.id, row.tokenId), isNull(agentEnrollmentTokens.usedAt)));
  if ("affectedRows" in burn && Number(burn.affectedRows) === 0) {
    throw new AgentAuthError(409, "TOKEN_USED", "Enrollment token was already used");
  }

  // Rotate: any older credential for this agent is deactivated.
  await db
    .update(agentCredentials)
    .set({ isActive: false, revokedAt: new Date() })
    .where(and(eq(agentCredentials.agentId, row.agentId), eq(agentCredentials.isActive, true)));

  const keyId = `AK${newId().slice(0, 24)}`;
  const secret = randomSecret(32);
  await db.insert(agentCredentials).values({
    id: newId(),
    agentId: row.agentId,
    keyId,
    secretEnc: encryptSecret(secret),
  });

  await db
    .update(agents)
    .set({
      hostname: input.hostname.slice(0, 120),
      installationId: input.installationId.slice(0, 64),
      version: input.agentVersion.slice(0, 40),
      jhcisPcucode: input.pcucode?.trim() ?? row.expectedPcucode,
      status: "OFFLINE",
      enrolledAt: new Date(),
      revokedAt: null,
      lastError: null,
    })
    .where(eq(agents.id, row.agentId));

  return {
    agentId: row.agentId,
    keyId,
    secret,
    facilityId: row.facilityId,
    facilityCode: row.facilityCode,
    facilityName: row.facilityName,
    expectedPcucode: row.expectedPcucode,
    syncIntervalMinutes: row.syncIntervalMinutes,
    reprocessDays: row.reprocessDays,
  };
}
