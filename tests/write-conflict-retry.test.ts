/**
 * Retrying a write that lost a lock race.
 *
 * Fifteen agents uploading at once produced ER_LOCK_DEADLOCK on roughly one
 * upload request in seven, measured on the isolated fleet harness. Nothing was
 * lost - the agent re-sent from its durable queue - but every one of those was
 * a 500 in the log and a backoff at the far end, for a condition whose entire
 * remedy is "run the statement again".
 *
 * What has to stay true is the shape of the retry rather than the fact of it:
 * only conditions the database calls transient, a budget that always ends, and
 * a real pause between attempts. A retry that fires on a constraint violation,
 * or one with no ceiling, would turn a visible failure into a hidden one.
 */
import { describe, expect, it, vi } from "vitest";

import {
  WRITE_CONFLICT_DELAYS_MS,
  withWriteConflictRetry,
  writeConflictKind,
} from "@/lib/db/retry";

/** A driver error as mysql2 actually raises it. */
function driverError(code: string, errno: number): Error {
  return Object.assign(new Error(code), { code, errno, sqlState: "40001" });
}

const context = { statement: "drug_usage upsert", agentId: "A1", facilityId: "F1", rows: 500 };

describe("classifying a database write error", () => {
  it("names the conditions that mean the write lost a race", () => {
    // The one actually observed, and its close relative.
    expect(writeConflictKind(driverError("ER_LOCK_DEADLOCK", 1213))).toBe("ER_LOCK_DEADLOCK");
    expect(writeConflictKind(driverError("ER_LOCK_WAIT_TIMEOUT", 1205))).toBe("ER_LOCK_WAIT_TIMEOUT");
    // TiDB reports its own conflicts by number rather than by a MySQL name.
    expect(writeConflictKind({ errno: 9007 })).toBe("TIDB_WRITE_CONFLICT");
    expect(writeConflictKind({ errno: 8022 })).toBe("TIDB_COMMIT_FAILED");
    expect(writeConflictKind({ errno: 8028 })).toBe("TIDB_INFO_SCHEMA_CHANGED");
  });

  it("CASE E: refuses to call a data or schema problem transient", () => {
    // These are the ones a retry could only make worse: the same statement
    // will fail the same way, three times instead of once.
    expect(writeConflictKind(driverError("ER_DUP_ENTRY", 1062))).toBeNull();
    expect(writeConflictKind(driverError("ER_BAD_FIELD_ERROR", 1054))).toBeNull();
    expect(writeConflictKind(driverError("ER_PARSE_ERROR", 1064))).toBeNull();
    expect(writeConflictKind(driverError("ER_NO_SUCH_TABLE", 1146))).toBeNull();
    expect(writeConflictKind(driverError("ER_ACCESS_DENIED_ERROR", 1045))).toBeNull();
    expect(writeConflictKind(driverError("ER_DATA_TOO_LONG", 1406))).toBeNull();
    expect(writeConflictKind(new Error("connection lost"))).toBeNull();
    expect(writeConflictKind(null)).toBeNull();
    expect(writeConflictKind("ER_LOCK_DEADLOCK")).toBeNull();
  });
});

describe("running the write again", () => {
  it("CASE A: one conflict, then success - the caller never sees the error", async () => {
    const work = vi
      .fn()
      .mockRejectedValueOnce(driverError("ER_LOCK_DEADLOCK", 1213))
      .mockResolvedValue({ accepted: 500 });

    const result = await withWriteConflictRetry(context, work);

    expect(result).toEqual({ accepted: 500 });
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("CASE B: two conflicts still fit inside the budget", async () => {
    const work = vi
      .fn()
      .mockRejectedValueOnce(driverError("ER_LOCK_DEADLOCK", 1213))
      .mockRejectedValueOnce(driverError("ER_LOCK_WAIT_TIMEOUT", 1205))
      .mockResolvedValue("ok");

    await expect(withWriteConflictRetry(context, work)).resolves.toBe("ok");
    expect(work).toHaveBeenCalledTimes(3);
  });

  it("CASE C: a conflict that never clears is raised, not swallowed", async () => {
    // The important half of the policy. If the row cannot be written, the
    // request must fail so the agent keeps the chunk in its queue and sends it
    // again. Reporting success here would lose data silently.
    const work = vi.fn().mockRejectedValue(driverError("ER_LOCK_DEADLOCK", 1213));

    await expect(withWriteConflictRetry(context, work)).rejects.toMatchObject({ errno: 1213 });
    expect(work).toHaveBeenCalledTimes(WRITE_CONFLICT_DELAYS_MS.length + 1);
  });

  it("CASE D: a permanent error is raised on the first attempt", async () => {
    const work = vi.fn().mockRejectedValue(driverError("ER_DUP_ENTRY", 1062));

    await expect(withWriteConflictRetry(context, work)).rejects.toMatchObject({ errno: 1062 });
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("CASE F: attempts are spaced, so a conflict cannot become a spin", async () => {
    const work = vi.fn().mockRejectedValue(driverError("ER_LOCK_DEADLOCK", 1213));
    const started = Date.now();

    await expect(withWriteConflictRetry(context, work)).rejects.toThrow();
    const elapsed = Date.now() - started;

    // Jitter is half to one and a half of each delay, so the floor is half the
    // sum. The ceiling is what matters for the far end: three attempts must
    // never add up to something an agent would time out on.
    const nominal = WRITE_CONFLICT_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(elapsed).toBeGreaterThanOrEqual(nominal * 0.5 - 15);
    expect(elapsed).toBeLessThan(nominal * 1.5 + 250);
    expect(work).toHaveBeenCalledTimes(WRITE_CONFLICT_DELAYS_MS.length + 1);

    // And the whole budget stays far inside the sixty seconds Vercel allows a
    // request, so tuning it can never turn a conflict into a timeout.
    expect(nominal).toBeLessThan(5_000);
  });

  it("does not touch a write that simply succeeds", async () => {
    const work = vi.fn().mockResolvedValue(1);
    await expect(withWriteConflictRetry(context, work)).resolves.toBe(1);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("CASE A/idempotency: the retried write is the same write", async () => {
    // The retry re-runs the caller's closure verbatim; it must not rebuild,
    // re-slice or re-key anything, because that is how a retry turns into a
    // duplicate. Proven by the arguments being identical across attempts.
    const seen: unknown[][] = [];
    let attempts = 0;
    const rows = [{ recordKey: "k1" }, { recordKey: "k2" }];
    const work = async () => {
      seen.push([...rows]);
      if (++attempts < 2) throw driverError("ER_LOCK_DEADLOCK", 1213);
      return rows.length;
    };

    await expect(withWriteConflictRetry(context, work)).resolves.toBe(2);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(seen[1]);
  });
});
