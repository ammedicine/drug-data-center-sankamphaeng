import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { AgentStatus } from "./config";
import type { QueuedChunk } from "./queue/queue";

export interface NormalSyncRecoveryManifest {
  schemaVersion: 1;
  intent: "NORMAL";
  batchRef: string;
  mode: "INITIAL" | "INCREMENTAL" | "MANUAL_RANGE" | "RETRY";
  rangeFrom: string;
  rangeTo: string;
  pcucode: string;
  sourceVersion: string | null;
  recordsRead: number;
  recordsSent: number;
  verifiedThrough: string;
  phase: "UPLOADING" | "COMPLETING";
  createdAt: string;
}

function validate(value: NormalSyncRecoveryManifest): void {
  if (
    value.schemaVersion !== 1 ||
    value.intent !== "NORMAL" ||
    !value.batchRef ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.rangeFrom) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.rangeTo) ||
    value.rangeFrom > value.rangeTo ||
    !value.pcucode ||
    !Number.isInteger(value.recordsRead) ||
    !Number.isInteger(value.recordsSent) ||
    value.recordsRead < 0 ||
    value.recordsSent < 0 ||
    value.recordsSent > value.recordsRead ||
    (value.phase !== "UPLOADING" && value.phase !== "COMPLETING")
  ) {
    throw new Error("Invalid normal-sync recovery manifest: recordsRead/recordsSent or identity mismatch");
  }
}

/** One open normal batch per Agent, persisted independently from payload files. */
export class NormalSyncRecoveryStore {
  constructor(private readonly dataDirectory: string) {}

  path(): string {
    return resolve(this.dataDirectory, "queue", "normal-sync-recovery.json");
  }

  load(): NormalSyncRecoveryManifest | null {
    if (!existsSync(this.path())) return null;
    const value = JSON.parse(readFileSync(this.path(), "utf8")) as NormalSyncRecoveryManifest;
    validate(value);
    return value;
  }

  save(value: NormalSyncRecoveryManifest): void {
    validate(value);
    const target = this.path();
    mkdirSync(dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(value), "utf8");
    renameSync(temp, target);
  }

  clear(): void {
    rmSync(this.path(), { force: true });
  }
}

/** Adopts only the fully evidenced v1.1.17 interrupted-run shape. */
export function legacyRecoveryManifest(
  status: AgentStatus,
  pending: QueuedChunk[],
  failedCount: number,
): NormalSyncRecoveryManifest | null {
  if (!pending.length) return null;
  const refs = new Set(pending.map((chunk) => chunk.batchRef));
  const pendingRecords = pending.reduce((sum, chunk) => sum + chunk.records.length, 0);
  const exact =
    failedCount === 0 &&
    refs.size === 1 &&
    status.batchRef === pending[0].batchRef &&
    Boolean(status.rangeFrom && status.rangeTo) &&
    status.recordsExpected > 0 &&
    status.recordsExpected === status.recordsExtracted &&
    status.recordsExpected === status.recordsQueued &&
    status.recordsAccepted + status.recordsRejected + pendingRecords === status.recordsExpected;
  if (!exact) {
    throw new Error("Legacy queue evidence does not exactly match one interrupted batch");
  }
  return {
    schemaVersion: 1,
    intent: "NORMAL",
    batchRef: pending[0].batchRef,
    mode: "RETRY",
    rangeFrom: status.rangeFrom!,
    rangeTo: status.rangeTo!,
    pcucode: pending[0].pcucode,
    sourceVersion: pending[0].sourceVersion,
    recordsRead: status.recordsExpected,
    recordsSent: status.recordsExpected,
    verifiedThrough: status.rangeTo!,
    phase: "UPLOADING",
    createdAt: status.syncStartedAt ?? new Date().toISOString(),
  };
}
