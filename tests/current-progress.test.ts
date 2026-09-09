/**
 * What "กำลังนำเข้าข้อมูล" is allowed to mean.
 *
 * An Agent imports one thing at a time. A worker stopped mid-run - a tray
 * closed, a PC restarted, an upgrade - leaves its batch UPLOADING for ever,
 * because nothing is left alive to close it. The page showed every such row
 * that had been touched in the last half hour, so รพ.สต.บ้านกอสะเลียม appeared
 * to be importing four different date ranges at once. Only one of them was
 * moving; the other three were wreckage from earlier workers.
 *
 * The rule these tests hold in place: the newest batch for an agent is the one
 * that is happening, older ones from the same agent have been superseded
 * whatever their status column says, and two batches genuinely being written
 * to at the same moment is a defect to report rather than a row to hide.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Rows the fake database will hand back, newest first. */
let rows: Array<Record<string, unknown>> = [];
const warnings: Array<{ message: string; detail: Record<string, unknown> }> = [];

vi.mock("@/lib/db", () => {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => rows,
  };
  return { db: { select: () => chain } };
});

const { listRunningBatches } = await import("@/lib/services/monitoring");

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

function batch(over: Partial<Record<string, unknown>> = {}) {
  return {
    agentId: "agent-1",
    agentName: "chaiya",
    facilityCode: "RPST-05957",
    facilityName: "รพ.สต.บ้านกอสะเลียม",
    batchRef: "SYNC-1",
    rangeFrom: "2026-08-01",
    rangeTo: "2026-09-09",
    startedAt: minutesAgo(5),
    updatedAt: minutesAgo(5),
    recordsRead: 1000,
    recordsAccepted: 100,
    recordsRejected: 0,
    ownerName: null,
    ...over,
  };
}

beforeEach(() => {
  rows = [];
  warnings.length = 0;
  vi.spyOn(console, "warn").mockImplementation((message: unknown, detail: unknown) => {
    warnings.push({
      message: String(message),
      detail: (detail ?? {}) as Record<string, unknown>,
    });
  });
});

describe("the current import card", () => {
  it("shows one row when a stale batch sits beside a live one", async () => {
    // Exactly production: an older run left UPLOADING, a newer run advancing.
    rows = [
      batch({ batchRef: "SYNC-000051", startedAt: minutesAgo(1), updatedAt: minutesAgo(0) }),
      batch({ batchRef: "SYNC-000050", startedAt: minutesAgo(20), updatedAt: minutesAgo(12) }),
    ];

    const running = await listRunningBatches(null);

    expect(running).toHaveLength(1);
    expect(running[0].batchRef).toBe("SYNC-000051");
    // A superseded row is not a defect, so nobody is alarmed about it.
    expect(warnings).toHaveLength(0);
  });

  it("shows one row even with several stale batches from earlier workers", async () => {
    // The four rows 05957 actually had.
    rows = [
      batch({ batchRef: "SYNC-000051", startedAt: minutesAgo(1), updatedAt: minutesAgo(0) }),
      batch({ batchRef: "SYNC-000050", startedAt: minutesAgo(18), updatedAt: minutesAgo(13) }),
      batch({ batchRef: "SYNC-000049", startedAt: minutesAgo(25), updatedAt: minutesAgo(14) }),
      batch({ batchRef: "SYNC-000048", startedAt: minutesAgo(28), updatedAt: minutesAgo(18) }),
    ];

    const running = await listRunningBatches(null);

    expect(running.map((r) => r.batchRef)).toEqual(["SYNC-000051"]);
  });

  it("reports two genuinely live batches instead of hiding one", async () => {
    // Both written to seconds ago: that is two workers, which cannot happen by
    // design, so it must be surfaced rather than tidied away.
    rows = [
      batch({ batchRef: "SYNC-000060", startedAt: minutesAgo(2), updatedAt: minutesAgo(0) }),
      batch({ batchRef: "SYNC-000059", startedAt: minutesAgo(3), updatedAt: minutesAgo(0) }),
    ];

    const running = await listRunningBatches(null);

    expect(running).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("MULTIPLE_ACTIVE_BATCHES");
    expect(warnings[0].detail.agentId).toBe("agent-1");
    expect(warnings[0].detail.batches).toEqual(["SYNC-000060", "SYNC-000059"]);
    // Safe metadata only - no credential, no payload, no personal data.
    expect(Object.keys(warnings[0].detail).sort()).toEqual(["agentId", "batches", "facilityCode"]);
  });

  it("still shows different agents at the same time", async () => {
    // Fifteen สถานบริการ importing at once is the normal case, not a defect.
    rows = [
      batch({ agentId: "agent-1", batchRef: "A-1", facilityCode: "TEST-001" }),
      batch({ agentId: "agent-2", batchRef: "B-1", facilityCode: "TEST-002" }),
      batch({ agentId: "agent-3", batchRef: "C-1", facilityCode: "TEST-003" }),
    ];

    const running = await listRunningBatches(null);

    expect(running).toHaveLength(3);
    expect(warnings).toHaveLength(0);
  });

  it("drops a batch nobody has touched for half an hour", async () => {
    rows = [batch({ batchRef: "SYNC-OLD", startedAt: minutesAgo(90), updatedAt: minutesAgo(45) })];
    expect(await listRunningBatches(null)).toHaveLength(0);
  });

  it("drops a batch that has already delivered everything it read", async () => {
    rows = [batch({ batchRef: "SYNC-DONE", recordsRead: 500, recordsAccepted: 500 })];
    expect(await listRunningBatches(null)).toHaveLength(0);
  });
});
