/**
 * Retrying a database write that lost a race.
 *
 * Fifteen รพ.สต. uploading at the same time write to one table, and the rows
 * they write are keyed by a unique secondary index. Two multi-row upserts that
 * touch no row in common can still take each other's index locks in opposite
 * orders, and one of them is chosen as the victim. That is not a fault in
 * either request - the loser only has to try again.
 *
 * Measured on the isolated fifteen-agent harness: re-uploading rows that
 * already existed produced ER_LOCK_DEADLOCK on about 15% of upload requests.
 * No data was lost, because the agent's durable queue re-sent every chunk, but
 * each one cost a round trip, a 500 in the log, and an agent-side backoff. It
 * is far cheaper to lose the race and immediately run it again here, where the
 * rows are still in hand.
 *
 * This is deliberately narrow. Only errors the database itself declares
 * transient are retried; a constraint violation, a bad column, a syntax error
 * or an unknown failure is raised on the first attempt, because retrying those
 * only turns one error into three.
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
 * Waits between attempts, in order. Two retries after the first attempt: long
 * enough that the winner has committed and released its locks, short enough
 * that the agent waiting on the response never notices.
 */
export const WRITE_CONFLICT_DELAYS_MS = [50, 150] as const;

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
