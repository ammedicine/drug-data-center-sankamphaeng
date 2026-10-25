/**
 * The one label that answers "is this machine's software OK right now?".
 *
 * Two different things were being conflated on the fleet screen: the CURRENT
 * software health of a machine, and the OUTCOME OF ITS LAST UPDATE COMMAND.
 * They diverge. On 05957 a command to install 1.1.11 failed on 2026-09-14;
 * the machine then reached 1.1.14 and 1.1.15 by other means, yet the newest
 * command row for it was still that FAILED 1.1.11 - so a healthy, current
 * machine read as "อัปเดตไม่สำเร็จ" in red.
 *
 * The rule here: current state wins. A failed command is only the current
 * problem while the machine has NOT yet reached the version that command was
 * trying to install. Once the running version is at or past that target - by
 * a later command, a scheduled update, or a manual install - the failure is
 * history, shown as a secondary note, never as the machine's current state.
 * Nothing about the command rows changes; they remain the immutable record.
 */
import { UPDATE_ERROR_LABELS, UPDATE_STATE_LABELS, type UpdateErrorCode } from "./update-command";
import { compareVersions, isNewerVersion } from "./version";

export interface FleetUpdateInput {
  /** effective online/offline, so a REQUESTED command on an off machine reads right */
  status: string;
  /** the version the agent currently reports running */
  version: string | null;
  /** the newest published release, or null when none is published */
  latestVersion: string | null;
  /** latestVersion is strictly newer than the running version */
  updateAvailable: boolean;
  /** whether this build can act on a centre command at all */
  supportsRemoteUpdate: boolean;
  /** the newest command row for this agent (the record), or null */
  command: {
    status: string;
    targetVersion: string | null;
    terminal: boolean;
    errorCode: string | null;
    completedAtLabel: string | null;
  } | null;
  /** persisted Agent updater snapshot; history until tied to current version */
  updater?: {
    state: string | null;
    targetVersion: string | null;
    succeededAtLabel: string | null;
    errorCode: string | null;
    errorAtLabel: string | null;
  } | null;
}

export type UpdateTone = "ok" | "warn" | "danger" | "muted";

export interface FleetUpdateStatus {
  /** the primary label - the machine's current update state */
  text: string;
  tone: UpdateTone;
  /** detail for an update error that is still current, never historical */
  currentError?: string;
  /** success time only when its target exactly matches the running version */
  successAtLabel?: string;
  /** a secondary, non-alarming note about superseded history, when any */
  history?: string;
}

/** True when a FAILED command has been left behind: the machine already reached or passed its target. */
function failedButSuperseded(input: FleetUpdateInput): boolean {
  const c = input.command;
  if (!c || c.status !== "FAILED" || !c.targetVersion || !input.version) return false;
  // The target is no longer ahead of what is running, so that failure is done.
  return !isNewerVersion(c.targetVersion, input.version);
}

function updaterFailureSuperseded(input: FleetUpdateInput): boolean {
  const u = input.updater;
  if (u?.state !== "FAILED" || !u.errorCode || !u.targetVersion || !input.version) return false;
  const comparison = compareVersions(input.version, u.targetVersion);
  return comparison !== null && comparison >= 0;
}

function currentSuccessAtLabel(input: FleetUpdateInput): string | undefined {
  if (!input.version) return undefined;

  const c = input.command;
  if (
    c?.status === "SUCCESS" &&
    c.completedAtLabel &&
    compareVersions(c.targetVersion, input.version) === 0
  ) {
    return c.completedAtLabel;
  }

  const u = input.updater;
  if (
    u?.state === "SUCCESS" &&
    u.succeededAtLabel &&
    compareVersions(u.targetVersion, input.version) === 0
  ) {
    return u.succeededAtLabel;
  }

  return undefined;
}

function historicalFailure(input: FleetUpdateInput, commandSuperseded: boolean, updaterSuperseded: boolean): string | undefined {
  const targets = new Set<string>();
  if (commandSuperseded && input.command?.targetVersion) targets.add(input.command.targetVersion);
  if (updaterSuperseded && input.updater?.targetVersion) targets.add(input.updater.targetVersion);
  if (!targets.size) return undefined;
  return [...targets].map((target) => `เคยอัปเดตไม่สำเร็จ (รุ่น ${target})`).join(" · ");
}

export function deriveUpdateStatus(input: FleetUpdateInput): FleetUpdateStatus {
  const c = input.command;
  const commandSuperseded = failedButSuperseded(input);
  const updaterSuperseded = updaterFailureSuperseded(input);
  const history = historicalFailure(input, commandSuperseded, updaterSuperseded);
  const successAtLabel = currentSuccessAtLabel(input);

  // 1. A command still in flight is the current state, whatever the history.
  if (c && !c.terminal) {
    if (c.status === "REQUESTED" && input.status === "OFFLINE") {
      return { text: UPDATE_STATE_LABELS.OFFLINE_REQUESTED, tone: "warn", history };
    }
    const label = UPDATE_STATE_LABELS[c.status as keyof typeof UPDATE_STATE_LABELS] ?? c.status;
    return { text: `${label} → ${c.targetVersion ?? "?"}`, tone: "warn", history };
  }

  // 2. A failed command is the current problem ONLY while the machine has not
  //    yet reached what it was trying to install. A superseded failure is not.
  if (c?.status === "FAILED" && !commandSuperseded) {
    const reason = c.errorCode ? (UPDATE_ERROR_LABELS[c.errorCode as UpdateErrorCode] ?? c.errorCode) : null;
    return {
      text: UPDATE_STATE_LABELS.FAILED,
      tone: "danger",
      currentError: reason ?? undefined,
      history,
    };
  }

  // 3. The persisted updater snapshot can describe a failure without a
  // command row (legacy/bootstrap path). It is current only while the Agent
  // has not positively demonstrated that it reached that target.
  const u = input.updater;
  if (u?.state === "FAILED" && u.errorCode && !updaterSuperseded) {
    const reason = UPDATE_ERROR_LABELS[u.errorCode as UpdateErrorCode] ?? u.errorCode;
    return {
      text: UPDATE_STATE_LABELS.FAILED,
      tone: "danger",
      currentError: `${reason}${u.errorAtLabel ? ` (${u.errorAtLabel})` : ""}`,
      history,
    };
  }

  // 4. From here the primary is the machine's current software state.
  if (!input.supportsRemoteUpdate) {
    return {
      text: "รุ่นนี้อัปเดตเองตามรอบ 30 นาที (ยังไม่รับคำสั่งจากศูนย์กลาง)",
      tone: "muted",
      history,
      successAtLabel,
    };
  }
  if (!input.updateAvailable) {
    const v = input.version ? ` · ${input.version}` : "";
    return { text: `${UPDATE_STATE_LABELS.ALREADY_UP_TO_DATE}${v}`, tone: "ok", history, successAtLabel };
  }
  // A newer version exists. A past SUCCESS of an older target is not "current".
  return { text: `มีรุ่น ${input.latestVersion} ให้อัปเดต`, tone: "warn", history, successAtLabel };
}
