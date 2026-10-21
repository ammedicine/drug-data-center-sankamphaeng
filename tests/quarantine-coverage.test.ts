import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { dataDir } from "../agent/src/config";
import { OfflineQueue } from "../agent/src/queue/queue";

const root = dataDir();
const quarantine = join(root, "queue", "quarantined");
const coverage = {
  requestId: "request-current",
  batchRef: "SYNC-HISTORY-1",
  pcucode: "05957",
  from: "2024-10-01",
  to: "2024-12-31",
  coveredAt: "2026-10-21T00:00:00.000Z",
};

function parked(name: string, dates: string[], pcucode = "05957") {
  const path = join(quarantine, `${name}.json`);
  writeFileSync(path, JSON.stringify({
    batchRef: "old", sequence: 1, pcucode, floor: "2025-01-01",
    parkedAt: "2026-01-01T00:00:00.000Z",
    records: dates.map((usageDate, index) => ({ usageDate, visitNo: index + 1 })),
  }), "utf8");
  return path;
}

beforeEach(() => {
  rmSync(join(root, "queue"), { recursive: true, force: true });
  mkdirSync(quarantine, { recursive: true });
});

describe("additive quarantine coverage", () => {
  it("marks only a fully covered same-pcucode file and preserves records", () => {
    const file = parked("full", ["2024-10-01", "2024-12-31"]);
    const before = JSON.parse(readFileSync(file, "utf8"));
    const result = new OfflineQueue(root).markQuarantineCovered(coverage);
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(result).toEqual({ covered: 1, unresolvedRelevant: 0 });
    expect(after.records).toEqual(before.records);
    expect(after.coverage).toEqual({
      requestId: coverage.requestId,
      coveredByBatchRef: coverage.batchRef,
      coveredAt: coverage.coveredAt,
      coveredRange: { from: coverage.from, to: coverage.to },
    });
  });

  it("is byte-identical when the same coverage is applied twice", () => {
    const file = parked("repeat", ["2024-11-01"]);
    const queue = new OfflineQueue(root);
    queue.markQuarantineCovered({
      ...coverage,
      coveredAt: "2026-10-21T01:00:00.000Z",
    });
    const once = readFileSync(file);
    queue.markQuarantineCovered(coverage);
    expect(readFileSync(file)).toEqual(once);
  });

  it("refuses conflicting coverage without replacing it", () => {
    const file = parked("conflict", ["2024-11-01"]);
    const queue = new OfflineQueue(root);
    queue.markQuarantineCovered(coverage);
    const once = readFileSync(file);
    expect(() => queue.markQuarantineCovered({ ...coverage, requestId: "other" })).toThrow(/coverage conflict/i);
    expect(readFileSync(file)).toEqual(once);
  });

  it("leaves partial overlap unresolved and unrelated files visible but non-blocking", () => {
    parked("partial", ["2024-09-30", "2024-10-01"]);
    parked("outside", ["2025-01-01"]);
    parked("other-pcu", ["2024-11-01"], "99999");
    const result = new OfflineQueue(root).markQuarantineCovered(coverage);
    expect(result).toEqual({ covered: 0, unresolvedRelevant: 1 });
    expect(new OfflineQueue(root).quarantineSummary()).toEqual({ total: 3, covered: 0, unresolved: 3 });
  });

  it("counts unreadable quarantine as unresolved and never deletes it", () => {
    const file = join(quarantine, "broken.json");
    writeFileSync(file, "{not-json", "utf8");
    const queue = new OfflineQueue(root);
    expect(queue.markQuarantineCovered(coverage)).toEqual({ covered: 0, unresolvedRelevant: 1 });
    expect(queue.quarantineSummary()).toEqual({ total: 1, covered: 0, unresolved: 1 });
    expect(readFileSync(file, "utf8")).toBe("{not-json");
  });
});
