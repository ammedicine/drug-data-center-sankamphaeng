import type { AgentConfigResponse } from "@shared/canonical";
import { isValidSyncStartDate } from "@shared/sync-control";

import { loadSettings, saveSettings } from "./config";
import { log } from "./logger";
import type { OfflineQueue } from "./queue/queue";

type ManagedPolicy = NonNullable<AgentConfigResponse["globalSyncStartDatePolicy"]>;

export type GlobalSyncStartDateApplyResult = {
  status: "NO_POLICY" | "INVALID" | "IGNORED" | "APPLIED";
  quarantinedRecords: number;
};

function validPolicy(value: unknown): value is ManagedPolicy {
  if (!value || typeof value !== "object") return false;
  const policy = value as Record<string, unknown>;
  if (policy.schemaVersion !== 1) return false;
  if (typeof policy.desiredDate !== "string" || !isValidSyncStartDate(policy.desiredDate)) {
    return false;
  }
  if (!Number.isSafeInteger(policy.desiredRevision) || Number(policy.desiredRevision) < 1) {
    return false;
  }
  if (!Number.isSafeInteger(policy.activeRevision) || Number(policy.activeRevision) < 0) {
    return false;
  }
  if (Number(policy.activeRevision) > Number(policy.desiredRevision)) return false;
  if (policy.activeDate === null) return policy.activeRevision === 0;
  return (
    typeof policy.activeDate === "string" &&
    isValidSyncStartDate(policy.activeDate) &&
    Number(policy.activeRevision) > 0
  );
}

/**
 * Applies only a newer desired policy. Queue work is completed before the
 * revision is persisted, so an acknowledgement can never claim a forward
 * floor landed while below-floor pending rows still remain uploadable.
 */
export function applyGlobalSyncStartDatePolicy(
  config: AgentConfigResponse,
  queue: OfflineQueue,
): GlobalSyncStartDateApplyResult {
  const raw = config.globalSyncStartDatePolicy;
  if (raw === undefined) return { status: "NO_POLICY", quarantinedRecords: 0 };
  if (!validPolicy(raw)) {
    log.warn("ไม่ใช้ Global Sync Start Date ที่ไม่ถูกต้องจากศูนย์กลาง");
    return { status: "INVALID", quarantinedRecords: 0 };
  }

  const settings = loadSettings();
  const applied = settings.globalSyncStartDateAppliedRevision ?? 0;
  if (raw.desiredRevision <= applied) {
    return { status: "IGNORED", quarantinedRecords: 0 };
  }

  const movingForward = raw.desiredDate > settings.syncStartDate;
  const quarantined = movingForward
    ? queue.quarantinePendingBelowFloor(raw.desiredDate).records
    : 0;

  saveSettings({
    syncStartDate: raw.desiredDate,
    syncStartDateAuthority: "CENTRAL",
    globalSyncStartDateAppliedRevision: raw.desiredRevision,
  });
  log.info("ใช้ Global Sync Start Date จากศูนย์กลางแล้ว", {
    desiredDate: raw.desiredDate,
    desiredRevision: raw.desiredRevision,
    quarantinedRecords: quarantined,
  });
  return { status: "APPLIED", quarantinedRecords: quarantined };
}

/** Absent in legacy/local mode: no remote policy means no fabricated ACK. */
export function globalSyncStartDateHeartbeatReport(): {
  appliedGlobalSyncStartDateRevision?: number;
} {
  const settings = loadSettings();
  const revision = settings.globalSyncStartDateAppliedRevision;
  if (settings.syncStartDateAuthority !== "CENTRAL" || revision === undefined) return {};
  return { appliedGlobalSyncStartDateRevision: revision };
}
