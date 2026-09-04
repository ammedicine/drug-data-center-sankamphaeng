/**
 * Agent request authentication (PROJECT_SPEC section 4).
 *
 * Every agent call carries:
 *   X-Agent-Key        public credential id
 *   X-Agent-Timestamp  unix seconds
 *   X-Agent-Nonce      random, single use
 *   X-Agent-Signature  HMAC-SHA256 over METHOD\npath\nts\nnonce\nsha256(body)
 *
 * The facility is *derived* from the credential - a facility id in the body is
 * never trusted. Replay is blocked by a timestamp window plus a nonce table.
 */
import { and, eq, lt } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { db } from "@/lib/db";
import {
  agentCredentials,
  agentRequestNonces,
  agents,
  facilities,
} from "@/lib/db/schema";
import { safeEqual, sha256 } from "@/lib/ids";
import { decryptSecret } from "./crypto";
import {
  AGENT_HEADERS,
  buildSigningString,
  signRequest,
} from "@/lib/shared/canonical";

export class AgentAuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentAuthError";
  }
}

export interface AuthenticatedAgent {
  agentId: string;
  agentName: string;
  facilityId: string;
  facilityCode: string;
  facilityName: string;
  expectedPcucode: string;
  syncIntervalMinutes: number;
  reprocessDays: number;
  lastSyncedVisitDate: string | null;
  disabled: boolean;
  syncRequested: boolean;
  verifyRequested: boolean;
}

function maxSkewSeconds(): number {
  return Number(process.env.AGENT_SIGNATURE_MAX_SKEW_SECONDS ?? 300);
}

/**
 * Verifies the signature and returns the agent + its facility.
 * `rawBody` must be the exact string the agent signed.
 */
export async function authenticateAgent(
  req: NextRequest,
  rawBody: string,
): Promise<AuthenticatedAgent> {
  const keyId = req.headers.get(AGENT_HEADERS.key);
  const timestamp = req.headers.get(AGENT_HEADERS.timestamp);
  const nonce = req.headers.get(AGENT_HEADERS.nonce);
  const signature = req.headers.get(AGENT_HEADERS.signature);

  if (!keyId || !timestamp || !nonce || !signature) {
    throw new AgentAuthError(401, "MISSING_AUTH_HEADERS", "Missing agent authentication headers");
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    throw new AgentAuthError(401, "BAD_TIMESTAMP", "Invalid timestamp");
  }
  const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (skew > maxSkewSeconds()) {
    throw new AgentAuthError(401, "TIMESTAMP_SKEW", "Request timestamp outside allowed window");
  }
  if (nonce.length < 16 || nonce.length > 64) {
    throw new AgentAuthError(401, "BAD_NONCE", "Invalid nonce");
  }

  const rows = await db
    .select({
      credentialId: agentCredentials.id,
      secretEnc: agentCredentials.secretEnc,
      credentialActive: agentCredentials.isActive,
      agentId: agents.id,
      agentName: agents.name,
      agentStatus: agents.status,
      revokedAt: agents.revokedAt,
      syncIntervalMinutes: agents.syncIntervalMinutes,
      reprocessDays: agents.reprocessDays,
      lastSyncedVisitDate: agents.lastSyncedVisitDate,
      syncRequestedAt: agents.syncRequestedAt,
      verifyRequestedAt: agents.verifyRequestedAt,
      lastSyncAt: agents.lastSyncAt,
      facilityId: facilities.id,
      facilityCode: facilities.code,
      facilityName: facilities.name,
      expectedPcucode: facilities.jhcisPcucode,
      facilityActive: facilities.isActive,
    })
    .from(agentCredentials)
    .innerJoin(agents, eq(agents.id, agentCredentials.agentId))
    .innerJoin(facilities, eq(facilities.id, agents.facilityId))
    .where(and(eq(agentCredentials.keyId, keyId), eq(agentCredentials.isActive, true)))
    .limit(1);

  const row = rows[0];
  if (!row) {
    throw new AgentAuthError(401, "UNKNOWN_CREDENTIAL", "Unknown or revoked agent credential");
  }
  if (row.revokedAt || row.agentStatus === "DISABLED") {
    throw new AgentAuthError(403, "AGENT_REVOKED", "Agent has been revoked");
  }
  if (!row.facilityActive) {
    throw new AgentAuthError(403, "FACILITY_DISABLED", "Facility is disabled");
  }

  // The secret is stored encrypted at rest; decrypt it only to recompute the
  // expected signature, never to return it anywhere.
  const url = new URL(req.url);
  const expected = signRequest(
    decryptSecret(row.secretEnc),
    buildSigningString({
      method: req.method,
      path: url.pathname,
      timestamp,
      nonce,
      body: rawBody,
    }),
  );
  if (!safeEqual(expected, signature)) {
    throw new AgentAuthError(401, "BAD_SIGNATURE", "Signature verification failed");
  }

  await consumeNonce(row.agentId, nonce);

  await db
    .update(agentCredentials)
    .set({ lastUsedAt: new Date() })
    .where(eq(agentCredentials.id, row.credentialId));

  return {
    agentId: row.agentId,
    agentName: row.agentName,
    facilityId: row.facilityId,
    facilityCode: row.facilityCode,
    facilityName: row.facilityName,
    expectedPcucode: row.expectedPcucode,
    syncIntervalMinutes: row.syncIntervalMinutes,
    reprocessDays: row.reprocessDays,
    lastSyncedVisitDate: row.lastSyncedVisitDate ? String(row.lastSyncedVisitDate) : null,
    // status DISABLED is rejected above, so an authenticated agent may always run
    disabled: false,
    syncRequested: Boolean(
      row.syncRequestedAt &&
        (!row.lastSyncAt || row.syncRequestedAt.getTime() > row.lastSyncAt.getTime()),
    ),
    verifyRequested: Boolean(
      row.verifyRequestedAt &&
        (!row.lastSyncAt || row.verifyRequestedAt.getTime() > row.lastSyncAt.getTime()),
    ),
  };
}

/** Stores the nonce; a duplicate means the request is a replay. */
async function consumeNonce(agentId: string, nonce: string): Promise<void> {
  const key = sha256(`${agentId}:${nonce}`);
  try {
    await db.insert(agentRequestNonces).values({ nonce: key, agentId, seenAt: new Date() });
  } catch {
    throw new AgentAuthError(409, "REPLAY_DETECTED", "Nonce already used");
  }
  // Opportunistic cleanup so the table does not grow without bound.
  if (Math.random() < 0.02) {
    const cutoff = new Date(Date.now() - maxSkewSeconds() * 2000);
    await db.delete(agentRequestNonces).where(lt(agentRequestNonces.seenAt, cutoff));
  }
}

/**
 * The agent reports the pcucode it read from its own JHCISDB (office.offid).
 * It must match the facility the credential belongs to, otherwise an agent
 * could push another facility's data (PROJECT_SPEC section 4).
 */
export function assertPcucodeMatches(agent: AuthenticatedAgent, pcucode: string | null): void {
  if (!pcucode) {
    throw new AgentAuthError(400, "MISSING_PCUCODE", "pcucode is required");
  }
  if (pcucode.trim() !== agent.expectedPcucode.trim()) {
    throw new AgentAuthError(
      403,
      "PCUCODE_MISMATCH",
      `pcucode ${pcucode} does not belong to facility ${agent.facilityCode}`,
    );
  }
}
