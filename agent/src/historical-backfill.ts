import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

import type {
  HistoricalBackfillContext,
  HistoricalBackfillCoverageReport,
  HistoricalBackfillInstruction,
} from "@shared/canonical";
export type { HistoricalBackfillContext } from "@shared/canonical";

import { dataDir } from "./config";
import type { OfflineQueue } from "./queue/queue";

export interface PersistedHistoricalBackfillContext extends HistoricalBackfillContext {
  coverageReport?: HistoricalBackfillCoverageReport;
}

export function historicalBackfillPath(): string {
  return resolve(dataDir(), "historical-backfill.json");
}

export function loadHistoricalBackfill(): PersistedHistoricalBackfillContext | null {
  const path = historicalBackfillPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(
      readFileSync(path, "utf8"),
    ) as PersistedHistoricalBackfillContext;
    if (
      !parsed.requestId ||
      !parsed.batchRef ||
      !Number.isSafeInteger(parsed.policyRevision) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(parsed.from) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(parsed.to)
    )
      return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveHistoricalBackfill(
  context: PersistedHistoricalBackfillContext,
): void {
  const target = historicalBackfillPath();
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(context, null, 2), "utf8");
    renameSync(temp, target);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      /* nothing durable was replaced */
    }
    throw error;
  }
}

/** Repeated heartbeat delivery reuses the immutable request and batch identity. */
export function adoptHistoricalBackfill(
  instruction: HistoricalBackfillInstruction,
  createBatchRef: () => string,
): PersistedHistoricalBackfillContext {
  const existing = loadHistoricalBackfill();
  if (existing?.requestId === instruction.requestId) {
    if (
      existing.policyRevision !== instruction.policyRevision ||
      existing.from !== instruction.from ||
      existing.to !== instruction.to ||
      (instruction.batchRef && instruction.batchRef !== existing.batchRef)
    )
      throw new Error(
        "Historical backfill instruction conflicts with persisted context",
      );
    return existing;
  }
  const context: HistoricalBackfillContext = {
    requestId: instruction.requestId,
    policyRevision: instruction.policyRevision,
    from: instruction.from,
    to: instruction.to,
    batchRef: instruction.batchRef ?? createBatchRef(),
  };
  saveHistoricalBackfill(context);
  return context;
}

/** Runs only after Central completion and persists the report before heartbeat. */
export function recordHistoricalBackfillCoverage(
  context: HistoricalBackfillContext,
  pcucode: string,
  queue: OfflineQueue,
  coveredAt = new Date().toISOString(),
): HistoricalBackfillCoverageReport {
  const persisted = loadHistoricalBackfill();
  if (!persisted || persisted.requestId !== context.requestId) {
    throw new Error("Historical backfill context is not current");
  }
  if (persisted.coverageReport) return persisted.coverageReport;
  const coverage = queue.markQuarantineCovered({
    requestId: context.requestId,
    batchRef: context.batchRef,
    pcucode,
    from: context.from,
    to: context.to,
    coveredAt,
  });
  const report: HistoricalBackfillCoverageReport = {
    ...context,
    covered: coverage.covered,
    unresolved: coverage.unresolvedRelevant,
  };
  saveHistoricalBackfill({ ...persisted, coverageReport: report });
  return report;
}

export function clearHistoricalBackfill(requestId: string): void {
  const current = loadHistoricalBackfill();
  if (!current || current.requestId !== requestId) return;
  try {
    unlinkSync(historicalBackfillPath());
  } catch {
    /* idempotent */
  }
}
