import { existsSync, rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  adoptHistoricalBackfill,
  clearHistoricalBackfill,
  historicalBackfillPath,
  loadHistoricalBackfill,
  recordHistoricalBackfillCoverage,
} from "../agent/src/historical-backfill";
import type { OfflineQueue } from "../agent/src/queue/queue";

const instruction = {
  requestId: "backfill-request-1",
  policyRevision: 7,
  from: "2024-10-01",
  to: "2024-12-31",
};

afterEach(() => rmSync(historicalBackfillPath(), { force: true }));

describe("persisted historical backfill intent", () => {
  it("persists identity and batch before execution and reuses both after reload", () => {
    let generated = 0;
    const first = adoptHistoricalBackfill(
      instruction,
      () => `SYNC-20261021-${++generated}`,
    );
    const again = adoptHistoricalBackfill(
      instruction,
      () => `SYNC-20261021-${++generated}`,
    );
    expect(first).toEqual({ ...instruction, batchRef: "SYNC-20261021-1" });
    expect(again).toEqual(first);
    expect(loadHistoricalBackfill()).toEqual(first);
    expect(generated).toBe(1);
  });

  it("fails closed if a repeated request changes revision, range, or linked batch", () => {
    adoptHistoricalBackfill(instruction, () => "SYNC-20261021-1");
    expect(() =>
      adoptHistoricalBackfill(
        { ...instruction, to: "2025-01-01" },
        () => "other",
      ),
    ).toThrow(/conflicts/);
    expect(() =>
      adoptHistoricalBackfill(
        { ...instruction, batchRef: "different" },
        () => "other",
      ),
    ).toThrow(/conflicts/);
  });

  it("clears only the matching request and is idempotent", () => {
    adoptHistoricalBackfill(instruction, () => "SYNC-20261021-1");
    clearHistoricalBackfill("older-request");
    expect(existsSync(historicalBackfillPath())).toBe(true);
    clearHistoricalBackfill(instruction.requestId);
    clearHistoricalBackfill(instruction.requestId);
    expect(loadHistoricalBackfill()).toBeNull();
  });

  it("persists post-completion coverage for retry until Central acknowledges it", () => {
    const context = adoptHistoricalBackfill(instruction, () => "SYNC-20261021-1");
    let calls = 0;
    const queue = {
      markQuarantineCovered: () => {
        calls += 1;
        return { covered: 2, unresolvedRelevant: 1 };
      },
    } as unknown as OfflineQueue;

    const first = recordHistoricalBackfillCoverage(
      context,
      "05957",
      queue,
      "2026-10-21T00:00:00.000Z",
    );
    const repeated = recordHistoricalBackfillCoverage(
      context,
      "05957",
      queue,
      "2026-10-21T01:00:00.000Z",
    );

    expect(first).toEqual({ ...context, covered: 2, unresolved: 1 });
    expect(repeated).toEqual(first);
    expect(loadHistoricalBackfill()?.coverageReport).toEqual(first);
    expect(calls).toBe(1);
  });
});
