/**
 * The order rows are written in.
 *
 * The agent reads JHCIS by visit date and visit number; record_key is a hash
 * of the identity, so within one uploaded chunk the keys arrive shuffled with
 * respect to the unique index the upsert touches. Writing them in key order
 * makes a re-sent chunk lock that index exactly as the first delivery did,
 * instead of in a fresh arbitrary order each time.
 *
 * To be clear about what this did and did not buy: it did not reduce the
 * deadlock rate on the fifteen-agent harness. InnoDB named the real contention
 * as insert intention locks on the PRIMARY index, which is ordered by an
 * AUTO_INCREMENT id and cannot be influenced from here. The ordering is kept
 * for determinism, and these tests exist to keep it honest.
 *
 * Sorting is only worth anything if it actually reaches the statement, so
 * these tests capture the rows at the database boundary rather than trusting
 * the code above it. What must not change is everything else: which rows are
 * accepted, which are rejected, the keys themselves, and the caller's own
 * array.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { drugUsage, drugs, syncBatches, syncRejects } from "@/lib/db/schema";

/** Rows as they were handed to the driver, in the order they were handed over. */
const writes: Array<{ table: unknown; rows: Array<Record<string, unknown>> }> = [];

vi.mock("@/lib/db", () => {
  const done = Promise.resolve(undefined);
  const capture = (table: unknown) => ({
    values: (rows: Array<Record<string, unknown>>) => {
      writes.push({ table, rows });
      // Awaited directly (sync_rejects) or after onDuplicateKeyUpdate (the
      // upserts), so it has to work both ways.
      return Object.assign(Promise.resolve(undefined), {
        onDuplicateKeyUpdate: () => done,
      });
    },
  });
  return {
    db: {
      insert: capture,
      update: () => ({ set: () => ({ where: () => done }) }),
      // The ingestion core asks whether the centre is still accepting this
      // agent's data before it writes anything. This mock answers RUNNING so
      // these tests stay about ordering - the barrier itself is covered in
      // tests/remote-pause.test.ts, against a real database.
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([{ state: "RUNNING", reason: null }]),
          }),
        }),
      }),
    },
  };
});

const { ingestUsageRecords, upsertDrugMaster } = await import("@/lib/services/sync");

/** The shape ingestUsageRecords reads off the authenticated agent. */
const agent = {
  agentId: "agent-1",
  facilityId: "fac-1",
  facilityCode: "TEST-001",
  keyId: "key-1",
};

function usageRecord(visitNo: number, drugCode: string) {
  return {
    visitNo,
    drugCode,
    drugName: `drug ${drugCode}`,
    drugType: "01",
    quantity: 1,
    unit: "เม็ด",
    unitCode: "027",
    clinic: "001",
    visitMissing: false,
    usageDate: "2026-08-08",
  };
}

const isAscending = (values: string[]) =>
  values.every((value, i) => i === 0 || values[i - 1] <= value);

beforeEach(() => {
  writes.length = 0;
});

describe("the order rows reach the database", () => {
  it("writes usage rows in record_key order, whatever order they arrived in", async () => {
    // Visit numbers ascending, which is exactly how the extractor emits them -
    // and tells us nothing about where each key lands in the index.
    const records = Array.from({ length: 60 }, (_, i) => usageRecord(1000 + i, `D${i}`));

    const result = await ingestUsageRecords({
      agent: agent as never,
      batchId: "batch-1",
      pcucode: "T0001",
      sourceVersion: "test",
      records,
    });

    const usageWrites = writes.filter((w) => w.table === drugUsage);
    expect(usageWrites).toHaveLength(1);
    const keys = usageWrites[0].rows.map((r) => String(r.recordKey));
    expect(keys).toHaveLength(60);
    expect(isAscending(keys), "record keys were not written in ascending order").toBe(true);

    // The sort is doing something: the arrival order was not already sorted,
    // so this test would pass trivially if the keys happened to be ordered.
    const arrival = usageWrites[0].rows.map((r) => String(r.visitNo));
    expect(isAscending(arrival)).toBe(false);

    expect(result.accepted).toBe(60);
    expect(result.rejected).toBe(0);
  });

  it("does not touch the array it was given", async () => {
    const records = [usageRecord(3, "C"), usageRecord(1, "A"), usageRecord(2, "B")];
    const before = records.map((r) => `${r.visitNo}:${r.drugCode}`);

    await ingestUsageRecords({
      agent: agent as never,
      batchId: "batch-1",
      pcucode: "T0001",
      sourceVersion: "test",
      records,
    });

    expect(records.map((r) => `${r.visitNo}:${r.drugCode}`)).toEqual(before);
  });

  it("keeps the same rows, the same keys and the same counts", async () => {
    // Ordering may only change the sequence of writes. The set of rows, the
    // keys derived for them and what the agent is told must all be identical.
    const records = [usageRecord(5, "E"), usageRecord(2, "B"), usageRecord(9, "Z")];

    const result = await ingestUsageRecords({
      agent: agent as never,
      batchId: "batch-1",
      pcucode: "T0001",
      sourceVersion: "test",
      records,
    });

    const rows = writes.find((w) => w.table === drugUsage)!.rows;
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.visitNo))).toEqual(new Set([5, 2, 9]));
    // Every row still carries the authenticated agent's facility, never the
    // request's own idea of it.
    expect(rows.every((r) => r.facilityId === "fac-1")).toBe(true);
    expect(rows.every((r) => r.agentId === "agent-1")).toBe(true);
    expect(rows.every((r) => r.sourcePcucode === "T0001")).toBe(true);
    expect(new Set(rows.map((r) => r.recordKey)).size).toBe(3);
    expect(result).toMatchObject({ accepted: 3, rejected: 0 });
  });

  it("still rejects a bad row on its own, and orders the rest", async () => {
    const records = [
      usageRecord(4, "D"),
      { ...usageRecord(5, ""), drugCode: "" }, // the empty drugcode JHCIS really contains
      usageRecord(1, "A"),
    ];

    const result = await ingestUsageRecords({
      agent: agent as never,
      batchId: "batch-1",
      pcucode: "T0001",
      sourceVersion: "test",
      records,
    });

    expect(result.accepted).toBe(2);
    expect(result.rejected).toBe(1);
    const keys = writes.find((w) => w.table === drugUsage)!.rows.map((r) => String(r.recordKey));
    expect(isAscending(keys)).toBe(true);
    expect(writes.some((w) => w.table === syncRejects)).toBe(true);
  });

  it("re-uploading the same chunk produces the same keys in the same order", async () => {
    // Idempotency has an ordering half: the second delivery of a chunk must
    // lock the index the same way the first did, or the retry reintroduces the
    // contention it was meant to remove.
    const records = [usageRecord(7, "G"), usageRecord(3, "C"), usageRecord(8, "H")];
    const run = () =>
      ingestUsageRecords({
        agent: agent as never,
        batchId: "batch-1",
        pcucode: "T0001",
        sourceVersion: "test",
        records,
      });

    await run();
    const first = writes.find((w) => w.table === drugUsage)!.rows.map((r) => r.recordKey);
    writes.length = 0;
    await run();
    const second = writes.find((w) => w.table === drugUsage)!.rows.map((r) => r.recordKey);

    expect(second).toEqual(first);
  });

  it("two facilities produce different keys, so neither can overwrite the other", async () => {
    const records = [usageRecord(1, "A"), usageRecord(2, "B")];
    await ingestUsageRecords({ agent: agent as never, batchId: "b", pcucode: "T0001", sourceVersion: null, records });
    const first = writes.find((w) => w.table === drugUsage)!.rows.map((r) => r.recordKey);

    writes.length = 0;
    const other = { ...agent, agentId: "agent-2", facilityId: "fac-2" };
    await ingestUsageRecords({ agent: other as never, batchId: "b", pcucode: "T0002", sourceVersion: null, records });
    const second = writes.find((w) => w.table === drugUsage)!.rows.map((r) => r.recordKey);

    expect(new Set([...first, ...second]).size).toBe(4);
    expect(isAscending(second.map(String))).toBe(true);
  });

  it("writes the drug master in drug_code order too", async () => {
    const master = ["D30", "D10", "D20", "D05"].map((drugCode) => ({
      drugCode,
      drugName: `ยา ${drugCode}`,
      genericName: null,
      drugType: "01",
      drugTypeSub: null,
      drugFlag: "1",
      unitSell: "027",
      unitSellName: "เม็ด",
      unitUsage: "027",
      unitUsageName: "เม็ด",
    }));
    const before = master.map((m) => m.drugCode);

    const count = await upsertDrugMaster(agent as never, master, "test");

    expect(count).toBe(4);
    const rows = writes.find((w) => w.table === drugs)!.rows;
    expect(rows.map((r) => String(r.drugCode))).toEqual(["D05", "D10", "D20", "D30"]);
    // and the caller's array is untouched
    expect(master.map((m) => m.drugCode)).toEqual(before);
  });

  it("still updates the batch counters once per upload", async () => {
    void syncBatches;
    const records = [usageRecord(1, "A")];
    await ingestUsageRecords({ agent: agent as never, batchId: "b", pcucode: "T0001", sourceVersion: null, records });
    // The counter update goes through db.update, not db.insert, so it is not
    // in `writes`; what matters here is that ordering did not disturb it.
    expect(writes.filter((w) => w.table === drugUsage)).toHaveLength(1);
  });
});
