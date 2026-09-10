/**
 * Obeying the centre's instruction to stop syncing - and remembering it.
 *
 * Pausing does not stop this Agent. The tray stays open, the worker keeps its
 * rounds, the heartbeat keeps going, the clock keeps being repaired and
 * software updates keep arriving. Exactly one thing stops: reading JHCIS and
 * sending dispensing data. That is the point - an Agent that had been killed
 * could never be told to start again, and somebody would have to drive to the
 * สถานบริการ to undo a click made in the district office.
 *
 * Two rules matter more than the rest:
 *
 * It is written to disk. A paused machine that reboots must come back paused.
 * Held only in memory, every restart would open a window in which the Agent
 * believed it was free to collect - and during a reset the machine most likely
 * to be restarted is the one somebody is standing in front of.
 *
 * It fails closed. If the centre cannot be reached, the last instruction
 * stands. Treating silence as permission would mean a dropped connection could
 * restart collection at a สถานบริการ an administrator had deliberately
 * stopped, which is the one outcome this whole mechanism exists to prevent.
 */
import type { AgentConfigResponse } from "@shared/canonical";
import type { EffectiveSyncState, SyncControlState } from "@shared/sync-control";

import { loadState, saveState, writeStatus } from "./config";
import { log } from "./logger";

/**
 * Set while a run finishes the chunk it was in the middle of.
 *
 * An instruction that arrives mid-upload does not tear a write in half. The
 * current atomic unit finishes, and nothing new starts after it - which is
 * both safer and, for an operator watching, honest about what is happening.
 */
let pauseRequested = false;

/** What the centre last told this Agent, as persisted. */
export function desiredSyncState(): SyncControlState {
  return loadState().syncControlState ?? "RUNNING";
}

/** What this Agent is actually doing about it. */
export function effectiveSyncState(): EffectiveSyncState {
  if (desiredSyncState() === "RUNNING") return "RUNNING";
  return pauseRequested ? "PAUSE_REQUESTED" : "PAUSED";
}

/** True when this Agent must not read JHCIS or upload anything. */
export function syncPaused(): boolean {
  return desiredSyncState() === "PAUSED";
}

/**
 * True when a run that is already going should stop at the next safe point.
 *
 * Checked between chunks and between ranges rather than inside one, so a pause
 * never leaves a half-delivered unit behind.
 */
export function shouldStopForPause(): boolean {
  return syncPaused();
}

/** Marks that a run is winding down, for the screen and the heartbeat. */
export function beginPauseHandover(): void {
  if (!pauseRequested) {
    pauseRequested = true;
    log.info("ได้รับคำสั่งหยุดการซิงก์ระหว่างทำงาน จะหยุดหลังจบชุดข้อมูลปัจจุบัน");
  }
}

/** Clears the handover flag once the run has actually stopped. */
export function completePauseHandover(): void {
  pauseRequested = false;
}

/**
 * Applies whatever the centre said on this round.
 *
 * Idempotent by revision. The same PAUSED arrives on every heartbeat for as
 * long as it stands, and acting on each one would mean a log line and a status
 * write every thirty seconds for the whole time a สถานบริการ is stopped. Only
 * a revision higher than the one already applied is a new instruction.
 *
 * A response that carries no instruction at all - an older Central, or a
 * rollback - changes nothing. Silence is not permission to resume.
 */
export function applyControlInstruction(config: AgentConfigResponse): void {
  const desired = config.syncControlState;
  if (!desired) return;

  const state = loadState();
  const revision = config.controlRevision ?? 0;
  const applied = state.appliedControlRevision ?? -1;
  const current = state.syncControlState ?? "RUNNING";

  if (revision <= applied && desired === current) {
    // Same instruction, already obeyed. Nothing to do and nothing to say.
    return;
  }

  const appliedAt = new Date().toISOString();
  saveState({
    ...state,
    syncControlState: desired,
    appliedControlRevision: revision,
    controlAppliedAt: appliedAt,
    pauseReason: config.pauseReason ?? null,
  });

  if (desired === "PAUSED") {
    beginPauseHandover();
    log.warn("ผู้ดูแลระบบส่วนกลางสั่งหยุดการซิงก์", {
      revision,
      reason: config.pauseReason ?? null,
    });
  } else {
    completePauseHandover();
    log.info("ผู้ดูแลระบบส่วนกลางเปิดการซิงก์อีกครั้ง", { revision });
  }

  writeStatus({
    syncControlState: desired,
    controlRevision: revision,
    controlAppliedAt: appliedAt,
    pauseReason: config.pauseReason ?? null,
  });
}

/**
 * The reason shown when something is refused because of a pause.
 *
 * Never "credential revoked" and never "offline": the Agent is connected, its
 * credential is fine, and a person at the สถานบริการ pressing "ซิงก์ตอนนี้"
 * deserves to be told what actually happened rather than sent to look for a
 * fault that does not exist.
 */
export function pausedMessage(): string {
  const reason = loadState().pauseReason;
  return reason
    ? `การซิงก์ถูกหยุดโดยผู้ดูแลระบบส่วนกลาง (${reason})`
    : "การซิงก์ถูกหยุดโดยผู้ดูแลระบบส่วนกลาง";
}
