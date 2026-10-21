import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AGENT_CAPABILITIES } from "../agent/src/config";
import { OfflineQueue } from "../agent/src/queue/queue";
import type { DrugUsageRecord } from "@/lib/shared/canonical";

let home: string;

beforeEach(() => {
  home = mkdtempSync(resolve(tmpdir(), "sdc-chunk-identity-"));
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

function record(drugCode = "D1"): DrugUsageRecord {
  return {
    visitNo: 1001,
    drugCode,
    drugName: "ยาทดสอบ",
    drugType: "01",
    quantity: 2,
    unit: "เม็ด",
    unitCode: "027",
    clinic: null,
    usageDate: "2026-10-01",
  };
}

describe("Agent upload-chunk identity", () => {
  it("advertises idempotent upload support", () => {
    expect(AGENT_CAPABILITIES.idempotentUploadChunk).toBe(true);
  });

  it("persists one chunkRef and payload hash before upload and keeps them across restart", () => {
    const queue = new OfflineQueue(home);
    queue.enqueue({
      batchRef: "SYNC-20261020-000001",
      sequence: 7,
      pcucode: "05957",
      sourceVersion: "5.6.45",
      records: [record()],
    });

    const first = queue.prepareForUpload(queue.list()[0]);
    expect(first.chunkRef).toBe("SYNC-20261020-000001:000007");
    expect(first.payloadSha256).toMatch(/^[0-9a-f]{64}$/);

    const saved = JSON.parse(readFileSync(first.file, "utf8"));
    expect(saved).toMatchObject({
      chunkRef: first.chunkRef,
      payloadSha256: first.payloadSha256,
    });

    const restarted = new OfflineQueue(home).prepareForUpload(new OfflineQueue(home).list()[0]);
    expect(restarted.chunkRef).toBe(first.chunkRef);
    expect(restarted.payloadSha256).toBe(first.payloadSha256);
  });

  it("upgrades a v1.1.16 queue file atomically without changing its records", () => {
    const pending = join(home, "queue", "pending");
    mkdirSync(pending, { recursive: true });
    const file = join(pending, "SYNC-LEGACY__000003.json");
    const legacy = {
      batchRef: "SYNC-LEGACY",
      sequence: 3,
      pcucode: "05957",
      sourceVersion: null,
      records: [record("OLD")],
      attempts: 2,
      lastError: "timeout",
    };
    writeFileSync(file, JSON.stringify(legacy), "utf8");

    const prepared = new OfflineQueue(home).prepareForUpload(new OfflineQueue(home).list()[0]);
    expect(prepared).toMatchObject({
      chunkRef: "SYNC-LEGACY:000003",
      attempts: 2,
      lastError: "timeout",
      records: legacy.records,
    });
    expect(prepared.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(file, "utf8")).not.toContain(".tmp");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      chunkRef: "SYNC-LEGACY:000003",
      payloadSha256: prepared.payloadSha256,
      records: legacy.records,
    });
  });

  it("keeps the prepared identity when a retryable upload fails and the process restarts", () => {
    const queue = new OfflineQueue(home);
    queue.enqueue({
      batchRef: "SYNC-20261021-000001",
      sequence: 6,
      pcucode: "05957",
      sourceVersion: "5.6.45",
      records: [record("RETRY")],
    });

    const prepared = queue.prepareForUpload(queue.list()[0]);
    queue.fail(prepared, "temporary network failure", false);

    const restarted = new OfflineQueue(home).list()[0];
    expect(restarted).toMatchObject({
      chunkRef: "SYNC-20261021-000001:000006",
      payloadSha256: prepared.payloadSha256,
      attempts: 1,
      lastError: "temporary network failure",
    });
    expect(new OfflineQueue(home).prepareForUpload(restarted).payloadSha256).toBe(
      prepared.payloadSha256,
    );
  });

  it("replays the same recovered sequence but fails closed when its payload changed", () => {
    const queue = new OfflineQueue(home);
    const original = {
      batchRef: "SYNC-RECOVERY",
      sequence: 1,
      pcucode: "05957",
      sourceVersion: null,
      records: [record("SAME")],
    };
    const file = queue.enqueue(original);
    expect(queue.enqueue(original)).toBe(file);
    expect(queue.list()).toHaveLength(1);
    expect(() => queue.enqueue({ ...original, records: [record("CHANGED")] })).toThrow(
      /payload changed during recovery/,
    );
  });

  it("keeps an acknowledged chunk receipt until the batch is durably completed", () => {
    const queue = new OfflineQueue(home);
    const original = {
      batchRef: "SYNC-PARTIAL-RECOVERY",
      sequence: 1,
      pcucode: "05957",
      sourceVersion: null,
      records: [record("ACKED")],
    };
    queue.enqueue(original);
    const prepared = queue.prepareForUpload(queue.list()[0]);
    queue.ack(prepared);

    expect(new OfflineQueue(home).list()).toHaveLength(0);
    expect(() => new OfflineQueue(home).enqueue(original)).not.toThrow();
    expect(new OfflineQueue(home).list()).toHaveLength(0);
    expect(() =>
      new OfflineQueue(home).enqueue({ ...original, records: [record("CHANGED")] }),
    ).toThrow(/Acknowledged chunk payload changed during recovery/);

    queue.clearReceipts(original.batchRef);
    queue.enqueue(original);
    expect(queue.list()).toHaveLength(1);
  });

  it("fails closed when an acknowledged receipt identity was corrupted", () => {
    const queue = new OfflineQueue(home);
    const original = {
      batchRef: "SYNC-RECEIPT-CONFLICT",
      sequence: 4,
      pcucode: "05957",
      sourceVersion: null,
      records: [record("RECEIPT")],
    };
    queue.enqueue(original);
    queue.ack(queue.prepareForUpload(queue.list()[0]));

    const receiptFile = join(
      home,
      "queue",
      "receipts",
      "SYNC-RECEIPT-CONFLICT__000004.json",
    );
    const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
    writeFileSync(receiptFile, JSON.stringify({ ...receipt, chunkRef: "wrong-ref" }), "utf8");

    expect(() => new OfflineQueue(home).enqueue(original)).toThrow(
      /Acknowledged chunk payload changed during recovery/,
    );
  });
});
