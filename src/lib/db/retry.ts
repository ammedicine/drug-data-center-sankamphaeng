/**
 * Retrying a database write that lost a race.
 *
 * Fifteen รพ.สต. uploading at the same time all append to one table, and a pair
 * of those inserts can each end up holding what the other is waiting for. The
 * database picks one and rolls it back. Nothing is wrong with either request -
 * the loser only has to run its statement again.
 *
 * Measured on the isolated fifteen-agent harness against MySQL 8.4, where
 * InnoDB names the culprit exactly: both transactions were waiting for an
 * insert intention lock on the same page of the PRIMARY index of drug_usage.
 * That index is ordered by a bigint AUTO_INCREMENT id, so every writer is
 * appending to the same tail page no matter which สถานบริการ it belongs to.
 * That shape belongs to InnoDB's clustered B-tree; production runs on TiDB,
 * which distributes the primary key across regions and has never shown this.
 *
 * The retry is worth having either way: it is cheap, it is bounded, and any
 * engine can hand back a transient conflict under concurrency. Re-uploading
 * existing rows produced ER_LOCK_DEADLOCK on roughly one upload request in six
 * before this existed; the agent's durable queue meant nothing was ever lost,
 * but each one cost a round trip, a 500 in the log and a backoff at the far
 * end. It is far cheaper to run the statement again here, where the rows are
 * still in hand.
 *
 * This is deliberately narrow. Only errors the database itself declares
 * transient are retried; a constraint violation, a bad column, a syntax error
 * or an unknown failure is raised on the first attempt, because retrying those
 * only turns one error into several.
 */

/**
 * Driver error numbers that mean "this transaction lost a race; run it again".
 *
 * The MySQL pair is what the isolated harness produced and is what a local or
 * self-hosted MySQL will raise. The TiDB entries come from TiDB's documented
 * retryable set - production runs on TiDB Cloud, but this class of conflict
 * has never been observed there, so they are included on the strength of the
 * documentation rather than on a measurement of our own.
 */
const RETRYABLE_ERRNOS = new Map<number, string>([
  [1213, "ER_LOCK_DEADLOCK"],
  [1205, "ER_LOCK_WAIT_TIMEOUT"],
  [8022, "TIDB_COMMIT_FAILED"],
  [8028, "TIDB_INFO_SCHEMA_CHANGED"],
  [9007, "TIDB_WRITE_CONFLICT"],
]);

/** The same conditions as named by the driver rather than numbered. */
const RETRYABLE_CODES = new Set(["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"]);

/**
 * Waits between attempts, in order: three retries after the first attempt.
 *
 * Long enough that the winner has committed and released its locks, short
 * enough that the whole budget adds well under a second to a request Vercel
 * allows sixty of. Measured on the fifteen-agent harness, two retries rescued
 * 57% of conflicted requests and three rescued 68%, taking the failure rate
 * from 15.8% to 9.8%. Further attempts keep helping by less and cost latency
 * on every conflicted request, and the residue is the tail-page contention
 * described above rather than anything more attempts can fix.
 */
export const WRITE_CONFLICT_DELAYS_MS = [50, 150, 400] as const;

/**
 * Names the conflict if the error is one we may retry, otherwise null.
 * Exported so the classification can be tested on its own, without a database.
 */
export function writeConflictKind(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { errno?: unknown; code?: unknown };
  if (typeof candidate.errno === "number") {
    const named = RETRYABLE_ERRNOS.get(candidate.errno);
    if (named) return named;
  }
  if (typeof candidate.code === "string" && RETRYABLE_CODES.has(candidate.code)) {
    return candidate.code;
  }
  return null;
}

/** Identifies the write in a log line. Never carries a row, a name or a secret. */
export interface WriteContext {
  /** which statement lost, e.g. "drug_usage upsert" */
  statement: string;
  agentId?: string;
  facilityId?: string;
  batchRef?: string;
  rows?: number;
}

/**
 * Runs a write, and runs it again if the database says it lost a race.
 *
 * The work must be a single statement, or at least safely repeatable: every
 * caller here is an idempotent upsert keyed by a unique key, so re-running one
 * cannot double count. Anything that is not repeatable must not be wrapped.
 */
export async function withWriteConflictRetry<T>(
  context: WriteContext,
  work: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await work();
      if (attempt > 0) {
        console.warn("[ingest] write conflict cleared after retry", {
          ...context,
          attempts: attempt + 1,
        });
      }
      return result;
    } catch (error) {
      const kind = writeConflictKind(error);
      // Not a race, or the budget is gone: the caller sees the real error, and
      // the agent's own queue becomes the next line of defence.
      if (!kind || attempt >= WRITE_CONFLICT_DELAYS_MS.length) {
        if (kind) {
          console.error("[ingest] write conflict survived every retry", {
            ...context,
            kind,
            attempts: attempt + 1,
          });
        }
        throw error;
      }
      const base = WRITE_CONFLICT_DELAYS_MS[attempt];
      // Jittered, so two agents that collided do not collide again in step.
      const delay = Math.round(base * (0.5 + Math.random()));
      console.warn("[ingest] retrying after write conflict", {
        ...context,
        kind,
        attempt: attempt + 1,
        delayMs: delay,
      });
      await new Promise((done) => setTimeout(done, delay));
    }
  }
}
