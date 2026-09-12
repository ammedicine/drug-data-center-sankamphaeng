/**
 * What an Agent is, beyond the three numbers in its version.
 *
 * Central could only ever see agentVersion, and during v1.1.7 that turned out
 * to be useless at exactly the moment it mattered. Several intermediate builds
 * all reported "1.1.7" - one with a charset bug that destroyed Thai text, one
 * whose tray strangled its own worker with an unread pipe, and the released
 * one. Two production machines both said "1.1.7" and there was no way, from
 * the centre, to tell which of those three each was running. Deciding whether
 * a fleet-wide auto-update was safe came down to guessing.
 *
 * So an Agent now says which build it is and what it can do. The build id is a
 * short commit - not a secret, and not an identifier of anything but source.
 * The capabilities are what the centre needs to reason about before it asks
 * fifteen สถานบริการ to do something: whether an Agent can be paused remotely
 * at all, whether it honours a collection floor, whether it can update itself.
 *
 * Absent capabilities mean "no". An older Agent sends none of this, and every
 * flag reads false - which is the correct answer for a build that predates the
 * feature, and lets the centre fall back to its own authority rather than to
 * an assumption about the client.
 */

/** Capabilities a build declares. Anything missing is false, never unknown. */
export interface AgentCapabilities {
  /** downloads and installs verified updates through the SYSTEM task */
  autoUpdate: boolean;
  /** understands PAUSE/RESUME and reports an effective state */
  remotePause: boolean;
  /** honours a configured earliest dispensing date */
  syncStartDate: boolean;
  /** asserts the JHCIS session really is on a UTF-8 family before reading */
  charsetGate: boolean;
  /** one worker per data directory, enforced by a lock */
  workerLock: boolean;
  /** drains the worker's console into a bounded file */
  boundedWorkerLog: boolean;
  /**
   * Acts on an update command handed down in the heartbeat response, and
   * reports the command's progress back. Absent on 1.1.7 - 1.1.9, which only
   * ever update on their own scheduled task.
   */
  remoteUpdate: boolean;
}

export const NO_CAPABILITIES: AgentCapabilities = {
  autoUpdate: false,
  remotePause: false,
  syncStartDate: false,
  charsetGate: false,
  workerLock: false,
  boundedWorkerLog: false,
  remoteUpdate: false,
};

/**
 * Reads whatever an Agent sent into a complete, safe shape.
 *
 * Tolerant on purpose: this is parsing a report from a machine that may be
 * older than this code, and the honest reading of a field it never sent is
 * "cannot do that", not a rejected heartbeat.
 */
export function parseCapabilities(raw: unknown): AgentCapabilities {
  if (!raw || typeof raw !== "object") return { ...NO_CAPABILITIES };
  const source = raw as Record<string, unknown>;
  const flag = (name: keyof AgentCapabilities) => source[name] === true;
  return {
    autoUpdate: flag("autoUpdate"),
    remotePause: flag("remotePause"),
    syncStartDate: flag("syncStartDate"),
    charsetGate: flag("charsetGate"),
    workerLock: flag("workerLock"),
    boundedWorkerLog: flag("boundedWorkerLog"),
    remoteUpdate: flag("remoteUpdate"),
  };
}

/**
 * A build identifier is a short commit hash and nothing else.
 *
 * Validated rather than trusted: it is displayed on an operator's screen, and
 * a field an Agent controls should never be able to carry markup, a path, or
 * anything long enough to be interesting.
 */
export function parseBuildId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(value) ? value : null;
}

/** How a build is shown next to its version: "1.1.8 (02eec74)". */
export function describeBuild(version: string | null, buildId: string | null): string {
  if (!version) return "ไม่ทราบเวอร์ชัน";
  return buildId ? `${version} (${buildId.slice(0, 7)})` : version;
}
