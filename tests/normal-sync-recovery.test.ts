import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NormalSyncRecoveryStore, legacyRecoveryManifest } from "../agent/src/recovery";

let home: string;

beforeEach(() => {
  home = mkdtempSync(resolve(tmpdir(), "sdc-normal-recovery-"));
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const manifest = {
  schemaVersion: 1 as const,
  intent: "NORMAL" as const,
  batchRef: "SYNC-20261021-000001",
  mode: "INCREMENTAL" as const,
  rangeFrom: "2026-08-01",
  rangeTo: "2026-10-21",
  pcucode: "05957",
  sourceVersion: "5.6.45",
  recordsRead: 5574,
  recordsSent: 5574,
  verifiedThrough: "2026-10-21",
  phase: "UPLOADING" as const,
  createdAt: "2026-10-21T07:13:54.000Z",
};

describe("durable normal-sync recovery manifest", () => {
  it("persists atomically and survives a fresh store instance", () => {
    const first = new NormalSyncRecoveryStore(home);
    first.save({ ...manifest, recordsSent: 2500 });

    expect(new NormalSyncRecoveryStore(home).load()).toEqual({ ...manifest, recordsSent: 2500 });
    expect(readFileSync(first.path(), "utf8")).not.toContain(".tmp");
  });

  it("keeps the manifest through completing and removes it only after durable success", () => {
    const store = new NormalSyncRecoveryStore(home);
    store.save(manifest);
    store.save({ ...manifest, phase: "COMPLETING" });
    expect(new NormalSyncRecoveryStore(home).load()?.phase).toBe("COMPLETING");

    store.clear();
    expect(store.load()).toBeNull();
    expect(existsSync(store.path())).toBe(false);
  });

  it("fails closed on malformed or mismatched evidence", () => {
    const store = new NormalSyncRecoveryStore(home);
    expect(() => store.save({ ...manifest, recordsRead: 5573 })).toThrow(
      /recordsRead.*recordsSent/i,
    );
    expect(store.load()).toBeNull();
  });

  it("adopts the exact For-dev legacy evidence but refuses any count mismatch", () => {
    const status = {
      batchRef: manifest.batchRef,
      rangeFrom: manifest.rangeFrom,
      rangeTo: manifest.rangeTo,
      recordsExpected: 5574,
      recordsExtracted: 5574,
      recordsQueued: 5574,
      recordsAccepted: 2500,
      recordsRejected: 0,
      syncStartedAt: manifest.createdAt,
    };
    const pending = [
      { batchRef: manifest.batchRef, pcucode: "05957", sourceVersion: "5.6.45", records: Array(3074).fill({}) },
    ] as never;
    expect(legacyRecoveryManifest(status as never, pending, 0)).toMatchObject({
      batchRef: manifest.batchRef,
      recordsRead: 5574,
      recordsSent: 5574,
      mode: "RETRY",
    });
    expect(() =>
      legacyRecoveryManifest({ ...status, recordsAccepted: 2499 } as never, pending, 0),
    ).toThrow(/does not exactly match/);
  });
});
