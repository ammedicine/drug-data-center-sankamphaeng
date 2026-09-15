/**
 * What this Agent remembers about updating itself - on disk, across restarts.
 *
 * Two processes take part and neither can see the other's memory: the worker,
 * which heartbeats as the signed-in user and is told about a command; and the
 * SYSTEM scheduled task, which is the only thing allowed to run the installer.
 * They share exactly one file, `update-command.json` in the data directory,
 * written atomically, and that file is the truth on this machine. The centre's
 * command row is the truth for the district; the worker keeps the two in step
 * by reporting this file's contents whenever they change.
 *
 * The installer replaces the program mid-command. The new build reads this
 * file on its first start, sees INSTALLING with a target equal to its own
 * version, and closes the command as SUCCESS - which is how "installed"
 * survives the very restart that installing causes.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentUpdateReport } from "@shared/canonical";
import { MAX_UPDATE_ATTEMPTS, type UpdateCommandState, type UpdateErrorCode } from "@shared/update-command";
import { compareVersions } from "@shared/version";

import { AGENT_VERSION, dataDir } from "./config";
import { log } from "./logger";

/** The file, as persisted. */
export interface LocalUpdateCommand {
  /** null for the scheduled check's own runs, an id for a centre command */
  commandId: string | null;
  targetVersion: string;
  assetName: string;
  size: number | null;
  sha256: string;
  state: UpdateCommandState;
  /** how many times an install attempt has started on this command */
  attempts: number;
  errorCode: UpdateErrorCode | null;
  errorMessage: string | null;
  errorAt: string | null;
  receivedAt: string;
  updatedAt: string;
  succeededAt: string | null;
}

/** The updater's own health, read by the SYSTEM run and reported by the worker. */
export interface UpdaterTaskHealth {
  present: boolean;
  cadence: string | null;
  runAs: string | null;
  lastRun: string | null;
  lastResult: string | null;
  startWhenAvailable: boolean | null;
  allowOnBatteries: boolean | null;
  slot: string | null;
  checkedAt: string;
  repaired?: boolean;
  error?: string | null;
}

const FILE = "update-command.json";
const HEALTH_FILE = "updater-task.json";
const HANDOFF_FILE = "install-handoff.json";

/**
 * The install this Agent handed to a helper and walked away from.
 *
 * The updater is `runtime\node.exe`, and the installer has to replace that
 * very file - so the updater cannot stay to watch, and it must not let the
 * installer start while it is still holding node.exe. It launches a helper
 * (Windows PowerShell, not the installed runtime) that waits for the updater
 * to exit, proves it is gone, and only then runs the installer; the updater
 * writes this record and exits. `resultPath` is where the helper writes its
 * outcome, so the next run - 30 minutes later, or the freshly installed
 * build - can tell "still installing" from "the installer is gone and the
 * version did not move", and why.
 */
export interface InstallHandoff {
  version: string;
  installerPath: string;
  /** the helper (powershell) process that waits for the updater and runs the installer */
  helperPid: number;
  /** the updater process the helper waits to exit before it starts the installer */
  updaterPid: number;
  /** where the helper writes its outcome */
  resultPath: string;
  startedAt: string;
  logPath: string;
}

/** What the helper concluded. Written by run-installer.ps1, read on the next run. */
export interface HandoffResult {
  outcome: "INSTALLED" | "UPDATER_ALIVE" | "INSTALLER_FAILED" | "HELPER_ERROR";
  exit?: number;
  message?: string;
  at?: string;
}

export function loadHandoffResult(handoff: InstallHandoff | null): HandoffResult | null {
  if (!handoff?.resultPath || !existsSync(handoff.resultPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(handoff.resultPath, "utf8")) as HandoffResult;
    return parsed && typeof parsed.outcome === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function updateCommandPath(): string {
  return join(dataDir(), FILE);
}

export function loadUpdateCommand(): LocalUpdateCommand | null {
  const path = updateCommandPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as LocalUpdateCommand;
    return parsed && typeof parsed.targetVersion === "string" ? parsed : null;
  } catch {
    // A half-written file is not a command. It will be rewritten whole.
    return null;
  }
}

function writeAtomic(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), "utf8");
  renameSync(temp, path);
}

export function saveUpdateCommand(command: LocalUpdateCommand): void {
  writeAtomic(updateCommandPath(), { ...command, updatedAt: new Date().toISOString() });
}

/**
 * Records a command the centre handed down.
 *
 * Idempotent by id: the same command arrives on every heartbeat until it is
 * closed, and the second arrival changes nothing. A different id replaces a
 * command that has already finished; it does not replace one still in flight,
 * because two installs cannot be allowed to race for the same program files.
 */
export function acceptUpdateCommand(incoming: {
  id: string;
  targetVersion: string;
  assetName: string;
  size: number | null;
  sha256: string;
}): { accepted: boolean; reason: string } {
  const current = loadUpdateCommand();
  if (current?.commandId === incoming.id) return { accepted: false, reason: "already held" };
  if (current && current.commandId && !isTerminal(current.state)) {
    return { accepted: false, reason: `command ${current.commandId} still ${current.state}` };
  }
  if ((compareVersions(incoming.targetVersion, AGENT_VERSION) ?? 0) <= 0) {
    // Nothing to do and nothing to install: say so and close it at once.
    saveUpdateCommand({
      commandId: incoming.id,
      targetVersion: incoming.targetVersion,
      assetName: incoming.assetName,
      size: incoming.size,
      sha256: incoming.sha256,
      state: "SUCCESS",
      attempts: 0,
      errorCode: null,
      errorMessage: null,
      errorAt: null,
      receivedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      succeededAt: new Date().toISOString(),
    });
    return { accepted: true, reason: "already at or above target" };
  }
  saveUpdateCommand({
    commandId: incoming.id,
    targetVersion: incoming.targetVersion,
    assetName: incoming.assetName,
    size: incoming.size,
    sha256: incoming.sha256,
    state: "DELIVERED",
    attempts: 0,
    errorCode: null,
    errorMessage: null,
    errorAt: null,
    receivedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    succeededAt: null,
  });
  log.info("ได้รับคำสั่งอัปเดตจากศูนย์กลาง", { commandId: incoming.id, target: incoming.targetVersion });
  return { accepted: true, reason: "stored" };
}

export function isTerminal(state: UpdateCommandState): boolean {
  return state === "SUCCESS" || state === "FAILED" || state === "CANCELLED" || state === "SUPERSEDED";
}

/** Moves the held command to a new state and writes it down. */
export function advanceUpdateCommand(
  state: UpdateCommandState,
  detail: { errorCode?: UpdateErrorCode | null; errorMessage?: string | null; attempt?: boolean } = {},
): LocalUpdateCommand | null {
  const current = loadUpdateCommand();
  if (!current) return null;
  const now = new Date().toISOString();
  const next: LocalUpdateCommand = {
    ...current,
    state,
    attempts: current.attempts + (detail.attempt ? 1 : 0),
    updatedAt: now,
    ...(state === "FAILED"
      ? { errorCode: detail.errorCode ?? null, errorMessage: detail.errorMessage ?? null, errorAt: now }
      : {}),
    ...(state === "SUCCESS" ? { succeededAt: now, errorCode: null, errorMessage: null } : {}),
  };
  saveUpdateCommand(next);
  return next;
}

/**
 * What a freshly started process concludes from the file it inherited.
 *
 *  - INSTALLING (or any in-flight state) and this build is at or above the
 *    target: the install happened. SUCCESS.
 *  - In flight, this build is still below the target, and fewer than the
 *    allowed attempts have been used: the machine was probably switched off
 *    mid-way. Back to DELIVERED so the SYSTEM task tries again.
 *  - Attempts exhausted: FAILED with INSTALL_INCOMPLETE, so a person is told.
 *
 * Runs on every worker start and every SYSTEM run; harmless when there is
 * nothing to reconcile.
 */
export function reconcileUpdateCommandAfterRestart(): LocalUpdateCommand | null {
  const current = loadUpdateCommand();
  if (!current || isTerminal(current.state)) return current;
  const reached = (compareVersions(AGENT_VERSION, current.targetVersion) ?? -1) >= 0;
  if (reached) {
    log.info("อัปเดตสำเร็จ (ยืนยันหลังเริ่มโปรแกรมใหม่)", {
      commandId: current.commandId,
      target: current.targetVersion,
      running: AGENT_VERSION,
    });
    // Reaching the target IS success, and it must be written down before any
    // cleanup - the incident on 05957 was cleanup (an rm the user-session
    // worker had no permission for) throwing here and taking SUCCESS with it,
    // so the machine sat on the new version while the command said INSTALLING
    // and the worker crash-looped. Cleanup is best-effort and comes after.
    const next = advanceUpdateCommand("SUCCESS");
    clearInstallHandoff();
    return next;
  }
  if (current.state === "INSTALLING" || current.state === "VERIFYING" || current.state === "DOWNLOADING") {
    // A hand-off this program made may still be in flight - the helper is
    // waiting for the old updater to exit, or the installer is mid-copy. The
    // worker restarts within seconds of the tray coming back, long before a
    // slow disk is done, so leave an in-progress hand-off alone.
    const handoff = loadInstallHandoff();
    if (current.state === "INSTALLING" && handoffInProgress(handoff)) {
      log.info("การติดตั้งยังทำงานอยู่ รอให้เสร็จก่อน", { commandId: current.commandId, target: current.targetVersion });
      return current;
    }
    // The hand-off has finished (or there was none) and yet this build is not
    // at the target: the install did not take. The helper's result says why.
    const result = loadHandoffResult(handoff);
    clearInstallHandoff();
    const reason =
      result?.outcome === "UPDATER_ALIVE"
        ? "ตัวอัปเดตตัวเก่ายังไม่ปิด ตัวช่วยจึงไม่เริ่มติดตั้ง"
        : result?.outcome === "INSTALLER_FAILED"
          ? `ตัวติดตั้งจบด้วยรหัส ${result.exit ?? "?"}`
          : result?.outcome === "HELPER_ERROR"
            ? `ตัวช่วยติดตั้งผิดพลาด: ${(result.message ?? "").slice(0, 120)}`
            : null;
    if (current.attempts >= MAX_UPDATE_ATTEMPTS) {
      return advanceUpdateCommand("FAILED", {
        errorCode: "INSTALL_INCOMPLETE",
        errorMessage: reason ?? `ติดตั้งไม่จบหลังพยายาม ${current.attempts} ครั้ง`,
      });
    }
    log.warn("การอัปเดตยังไม่สำเร็จ จะลองใหม่", { commandId: current.commandId, state: current.state, reason });
    return advanceUpdateCommand("DELIVERED");
  }
  return current;
}

/* ------------------------------------------------------ the hand-off file */

export function saveInstallHandoff(handoff: InstallHandoff): void {
  writeAtomic(join(dataDir(), HANDOFF_FILE), handoff);
}

export function loadInstallHandoff(): InstallHandoff | null {
  const path = join(dataDir(), HANDOFF_FILE);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as InstallHandoff;
    return parsed && typeof parsed.helperPid === "number" && typeof parsed.version === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Removes the hand-off artifacts. Best-effort by construction.
 *
 * The result file is written by the SYSTEM helper into the administrators-only
 * updates directory, so the user-session worker may have no permission to
 * delete it - and a delete that throws must never crash the caller (this is
 * what took down the worker on 05957 after a good install). So every removal
 * is guarded, and the durable hand-off record is only forgotten once its
 * result file is actually gone: if the user worker could not delete a
 * SYSTEM-owned result, the record is kept so the next privileged run (the
 * SYSTEM updater, which can delete it) finishes the cleanup. No throw ever
 * leaves here.
 */
export function clearInstallHandoff(): void {
  const handoff = loadInstallHandoff();
  const resultGone = handoff?.resultPath ? tryRemove(handoff.resultPath) : true;
  if (resultGone) tryRemove(join(dataDir(), HANDOFF_FILE));
}

/** Deletes a path if it can; returns whether it is now gone. Never throws. */
function tryRemove(path: string): boolean {
  try {
    rmSync(path, { force: true }); // force ignores "not found", not permission errors
    return true;
  } catch (error) {
    log.warn("ลบไฟล์การส่งต่อการติดตั้งไม่ได้ (จะข้ามไปก่อน)", {
      path,
      code: (error as { code?: string }).code ?? null,
    });
    return false;
  }
}

/**
 * Whether a hand-off is still in flight.
 *
 * Finished the moment the helper writes its result - that file is the
 * authoritative "done", success or not. Before then, the helper must still
 * be alive: it is the process waiting for the updater and running the
 * installer. A pid on its own is not proof, since Windows reuses pids, so the
 * process behind it must still be powershell (the helper's image); a recycled
 * number pointing at anything else reads as gone, which ends the wait rather
 * than blocking the next attempt for ever.
 */
export function handoffInProgress(handoff: InstallHandoff | null): boolean {
  if (!handoff || !(handoff.helperPid > 0)) return false;
  if (loadHandoffResult(handoff)) return false;
  try {
    process.kill(handoff.helperPid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "win32") return true;
  try {
    const csv = execFileSync("tasklist", ["/FI", `PID eq ${handoff.helperPid}`, "/FO", "CSV", "/NH"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    const image = /^"([^"]+)"/.exec(csv.trim())?.[1] ?? "";
    return image.toLowerCase().startsWith("powershell");
  } catch {
    // tasklist unavailable: the live pid is the best evidence there is.
    return true;
  }
}

/* ------------------------------------------------------- task health file */

export function saveUpdaterTaskHealth(health: UpdaterTaskHealth): void {
  writeAtomic(join(dataDir(), HEALTH_FILE), health);
}

export function loadUpdaterTaskHealth(): UpdaterTaskHealth | null {
  const path = join(dataDir(), HEALTH_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as UpdaterTaskHealth;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------- the report */

/**
 * The heartbeat's `update` field, built from the two files.
 *
 * Sent only when it differs from what was last sent (the caller keeps the
 * fingerprint), so an idle fleet reports nothing and costs the centre nothing.
 */
export function buildUpdateReport(extra: { checkedAt?: string | null } = {}): AgentUpdateReport {
  const command = loadUpdateCommand();
  const task = loadUpdaterTaskHealth();
  return {
    commandId: command?.commandId ?? null,
    state: command?.state ?? null,
    targetVersion: command?.targetVersion ?? null,
    errorCode: command?.errorCode ?? null,
    errorMessage: command?.errorMessage ?? null,
    errorAt: command?.errorAt ?? null,
    succeededAt: command?.succeededAt ?? null,
    checkedAt: extra.checkedAt ?? null,
    task: task ? (task as unknown as Record<string, unknown>) : null,
  };
}

export function reportFingerprint(report: AgentUpdateReport): string {
  // checkedAt moves every half hour on its own; it is reported when it moves,
  // which is the intended "last check" liveness, but nothing else is.
  return JSON.stringify(report);
}
