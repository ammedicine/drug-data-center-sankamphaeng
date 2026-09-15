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
import { isNewerVersion } from "./version";

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
}

export type UpdateTone = "ok" | "warn" | "danger" | "muted";

export interface FleetUpdateStatus {
  /** the primary label - the machine's current update state */
  text: string;
  tone: UpdateTone;
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

export function deriveUpdateStatus(input: FleetUpdateInput): FleetUpdateStatus {
  const c = input.command;
  const superseded = failedButSuperseded(input);
  const history = superseded && c?.targetVersion ? `เคยอัปเดตไม่สำเร็จ (รุ่น ${c.targetVersion})` : undefined;

  // 1. A command still in flight is the current state, whatever the history.
  if (c && !c.terminal) {
    if (c.status === "REQUESTED" && input.status === "OFFLINE") {
      return { text: UPDATE_STATE_LABELS.OFFLINE_REQUESTED, tone: "warn" };
    }
    const label = UPDATE_STATE_LABELS[c.status as keyof typeof UPDATE_STATE_LABELS] ?? c.status;
    return { text: `${label} → ${c.targetVersion ?? "?"}`, tone: "warn" };
  }

  // 2. A failed command is the current problem ONLY while the machine has not
  //    yet reached what it was trying to install. A superseded failure is not.
  if (c?.status === "FAILED" && !superseded) {
    const reason = c.errorCode ? (UPDATE_ERROR_LABELS[c.errorCode as UpdateErrorCode] ?? c.errorCode) : null;
    return { text: `${UPDATE_STATE_LABELS.FAILED}${reason ? ` · ${reason}` : ""}`, tone: "danger" };
  }

  // 3. From here the primary is the machine's current software state.
  if (!input.supportsRemoteUpdate) {
    return { text: "รุ่นนี้อัปเดตเองตามรอบ 30 นาที (ยังไม่รับคำสั่งจากศูนย์กลาง)", tone: "muted", history };
  }
  if (!input.updateAvailable) {
    const v = input.version ? ` · ${input.version}` : "";
    return { text: `${UPDATE_STATE_LABELS.ALREADY_UP_TO_DATE}${v}`, tone: "ok", history };
  }
  // A newer version exists. A past SUCCESS of an older target is not "current".
  return { text: `มีรุ่น ${input.latestVersion} ให้อัปเดต`, tone: "warn", history };
}
