/**
 * The centre's refusal to accept data from a paused Agent.
 *
 * This is the barrier the whole remote-pause design rests on. An Agent may be
 * on a LAN nobody at the district office can reach, switched off, or running a
 * build that has never heard of pausing - and none of that may be allowed to
 * matter. What the centre will store is decided at the centre.
 *
 * So the check reads the desired state from the database on every mutating
 * request rather than trusting anything carried in from the client or cached
 * from an earlier one. It is a single indexed row read, and it is the cheapest
 * part of any request that is about to write thousands of rows.
 */
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { agents } from "@/lib/db/schema";
import {
  SYNC_PAUSED_CODE,
  SYNC_PAUSED_RETRY_AFTER_SECONDS,
  SYNC_PAUSED_STATUS,
  ingestAllowed,
} from "@/lib/shared/sync-control";

import { AgentAuthError } from "./verify";

/**
 * Refusal shaped so an Agent that predates all of this survives it.
 *
 * Measured against the released v1.1.7 client rather than assumed: a 4xx is
 * `permanent` there, which rewrites every pending chunk into failed/ in one
 * pass and reports the link as an authentication failure - on v1.1.6 the tray
 * renders that as "credential revoked". A 503 keeps the chunk pending, stops
 * the loop after one attempt, and reads as a temporary server problem, which
 * is exactly what it is.
 */
export class SyncPausedError extends AgentAuthError {
  readonly retryAfterSeconds = SYNC_PAUSED_RETRY_AFTER_SECONDS;

  constructor(reason: string | null) {
    super(
      SYNC_PAUSED_STATUS,
      SYNC_PAUSED_CODE,
      reason
        ? `ผู้ดูแลระบบส่วนกลางหยุดการซิงก์ของ Agent นี้ไว้: ${reason}`
        : "ผู้ดูแลระบบส่วนกลางหยุดการซิงก์ของ Agent นี้ไว้",
    );
    this.name = "SyncPausedError";
  }
}

/**
 * Throws unless the centre is currently willing to store this Agent's data.
 *
 * Called at the route, and again inside the ingestion core. That is not
 * redundancy for its own sake: routes are where a future endpoint is most
 * likely to be added without remembering the guard, and the core is the last
 * place a write can be stopped. A reset that depends on this must not depend
 * on nobody ever forgetting.
 */
export async function assertAgentSyncAllowed(agentId: string): Promise<void> {
  const rows = await db
    .select({
      state: agents.syncControlState,
      reason: agents.pauseReason,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  const row = rows[0];
  // An agent row that has gone missing is not something to write data for
  // either, but authentication has already established it exists - so the only
  // honest reading here is the state we found.
  if (!row) return;
  if (!ingestAllowed(row.state)) throw new SyncPausedError(row.reason);
}
