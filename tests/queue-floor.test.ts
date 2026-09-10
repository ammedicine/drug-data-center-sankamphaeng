/**
 * Rows already on disk when the collection floor moves forward.
 *
 * A สถานบริการ can have chunks queued from before its floor was set - the
 * canary had ten of them when its full history run was interrupted. Sending
 * those after the floor exists would put back precisely what the floor is for.
 * Deleting them would destroy local work with nothing to show for it, and no
 * way to tell afterwards how much there had been.
 *
 * So they are parked. These tests hold that line: nothing below the floor is
 * uploadable, nothing is lost, and a chunk straddling the floor is split
 * rather than sent whole or thrown away whole.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let home: string;
let counter = 0;

beforeEach(() => {
  home = mkdtempSync(resolve(tmpdir(), "sdc-qfloor-"));
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const queueModule = () => import(`../agent/src/queue/queue?q=${counter++}`);

function record(usageDate: string, drugCode: string) {
  return {
    visitNo: 1,
    drugCode,
    drugName: "ยาทดสอบ",
    drugType: "01",
    quantity: 1,
    unit: "เม็ด",
    unitCode: "027",
    clinic: null,
    usageDate,
  };
}

describe("a chunk entirely below the floor", () => {
  it("leaves the pending queue and is kept where it can still be read", async () => {
    const { OfflineQueue } = await queueModule();
    const queue = new OfflineQueue(home);
    queue.enqueue({
      batchRef: "SYNC-1",
      sequence: 1,
      pcucode: "05957",
      sourceVersion: null,
      records: [record("2019-01-01", "D1"), record("2020-06-30", "D2")],
    });

    const [chunk] = queue.list("PENDING");
    const result = queue.quarantineBelowFloor(chunk, "2022-10-01");

    expect(result).toEqual({ kept: 0, setAside: 2 });
    // Gone from pending: there is nothing left in it that may be sent.
    expect(queue.list("PENDING")).toHaveLength(0);
    // But not gone from the disk. Both rows are still there, with the floor
    // that excluded them recorded alongside.
    expect(queue.quarantinedCount()).toBe(1);
    const parked = readdirSync(join(home, "queue", "quarantined"));
    const saved = JSON.parse(readFileSync(join(home, "queue", "quarantined", parked[0]), "utf8"));
    expect(saved.records).toHaveLength(2);
    expect(saved.floor).toBe("2022-10-01");
    expect(saved.batchRef).toBe("SYNC-1");
    // Nothing was moved to failed/ - this is not a failure, it is a policy.
    expect(queue.list("FAILED")).toHaveLength(0);
  });
});

describe("a chunk straddling the floor", () => {
  it("keeps what may be sent and parks the rest, losing neither", async () => {
    const { OfflineQueue } = await queueModule();
    const queue = new OfflineQueue(home);
    queue.enqueue({
      batchRef: "SYNC-2",
      sequence: 3,
      pcucode: "05957",
      sourceVersion: null,
      records: [
        record("2019-01-01", "OLD1"),
        record("2022-10-01", "EDGE"), // exactly on the floor: collectable
        record("2024-05-05", "NEW1"),
        record("2021-12-31", "OLD2"),
      ],
    });

    const [chunk] = queue.list("PENDING");
    const result = queue.quarantineBelowFloor(chunk, "2022-10-01");

    expect(result).toEqual({ kept: 2, setAside: 2 });

    // The chunk is still pending, holding only the rows that may go up.
    const [rewritten] = queue.list("PENDING");
    expect(rewritten.records.map((r: { drugCode: string }) => r.drugCode).sort()).toEqual([
      "EDGE",
      "NEW1",
    ]);
    // The identity of the chunk survives the rewrite - same batch, same
    // sequence - so it still belongs to the batch that created it.
    expect(rewritten.batchRef).toBe("SYNC-2");
    expect(rewritten.sequence).toBe(3);

    // And the two old rows are readable, not deleted.
    const parked = readdirSync(join(home, "queue", "quarantined"));
    const saved = JSON.parse(readFileSync(join(home, "queue", "quarantined", parked[0]), "utf8"));
    expect(saved.records.map((r: { drugCode: string }) => r.drugCode).sort()).toEqual([
      "OLD1",
      "OLD2",
    ]);
  });
});

describe("a chunk entirely above the floor", () => {
  it("is left completely alone, with no quarantine folder created", async () => {
    const { OfflineQueue } = await queueModule();
    const queue = new OfflineQueue(home);
    queue.enqueue({
      batchRef: "SYNC-3",
      sequence: 1,
      pcucode: "05957",
      sourceVersion: null,
      records: [record("2024-01-01", "D1"), record("2025-01-01", "D2")],
    });

    const [chunk] = queue.list("PENDING");
    const before = readFileSync(chunk.file, "utf8");
    const result = queue.quarantineBelowFloor(chunk, "2022-10-01");

    expect(result).toEqual({ kept: 2, setAside: 0 });
    // Byte-identical: the ordinary path must not rewrite files for nothing.
    expect(readFileSync(chunk.file, "utf8")).toBe(before);
    expect(existsSync(join(home, "queue", "quarantined"))).toBe(false);
    expect(queue.quarantinedCount()).toBe(0);
  });
});
