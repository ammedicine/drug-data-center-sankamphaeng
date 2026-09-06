/**
 * The vocabulary the Agent, the Central API and the web pages all use to talk
 * about whether things are working.
 *
 * Kept free of node-only imports so client components can render these states
 * directly, and kept in one file so the Agent and the server cannot drift into
 * disagreeing about what "connected" means.
 *
 * The rule that matters: a link is CONNECTED only on evidence that it worked -
 * a successful authenticated exchange - and that evidence goes stale. Neither
 * "the process is alive" nor "the error looked retryable" is evidence.
 */

/** How often an Agent reports in. */
export const HEARTBEAT_INTERVAL_SECONDS = 30;

/**
 * How old the last acknowledgement may be before a link is no longer
 * described as connected. Three missed heartbeats: long enough to ride out one
 * slow round trip, short enough that a รพ.สต. PC going to sleep shows up
 * within a minute and a half rather than ten.
 */
export const STALE_AFTER_SECONDS = 90;

/** How often the web pages ask for fresh status while someone is looking. */
export const LIVE_POLL_SECONDS = 5;

/** Same, for a tab in the background - still current, far fewer requests. */
export const LIVE_POLL_HIDDEN_SECONDS = 30;

/**
 * The Agent's link to the Central API.
 *
 * AUTH_ERROR is separated from NETWORK_ERROR on purpose: one is fixed by
 * waiting or checking the internet, the other never fixes itself and needs an
 * administrator to re-enrol the machine.
 */
export type CentralLinkState =
  "CONNECTED" | "NETWORK_ERROR" | "AUTH_ERROR" | "STALE" | "UNKNOWN";

/** The Agent's link to its รพ.สต.'s JHCIS database. */
export type JhcisLinkState = "CONNECTED" | "UNREACHABLE" | "UNKNOWN";

/** Whether the Agent's background worker is running at all. */
export type WorkerState = "RUNNING" | "STOPPED" | "UNKNOWN";

/** What a sync run is doing right now. */
export type SyncPhase =
  "IDLE" | "READING" | "UPLOADING" | "VERIFYING" | "SUCCESS" | "ERROR";

export const CENTRAL_LINK_LABELS: Record<CentralLinkState, string> = {
  CONNECTED: "เชื่อมต่อแล้ว",
  NETWORK_ERROR: "ติดต่อไม่ได้",
  AUTH_ERROR: "สิทธิ์ถูกเพิกถอน",
  STALE: "ไม่ได้ติดต่อมานาน",
  UNKNOWN: "ยังไม่ทราบ",
};

export const JHCIS_LINK_LABELS: Record<JhcisLinkState, string> = {
  CONNECTED: "เชื่อมต่อแล้ว",
  UNREACHABLE: "ต่อไม่ได้",
  UNKNOWN: "ยังไม่ทราบ",
};

export const SYNC_PHASE_LABELS: Record<SyncPhase, string> = {
  IDLE: "ไม่ได้ทำงาน",
  READING: "กำลังอ่านจาก JHCIS",
  UPLOADING: "กำลังส่งขึ้นศูนย์กลาง",
  VERIFYING: "กำลังตรวจสอบความครบถ้วน",
  SUCCESS: "สำเร็จ",
  ERROR: "ผิดพลาด",
};

/** Tone for the status dot, so every screen colours a state the same way. */
export function linkTone(
  state: CentralLinkState | JhcisLinkState | WorkerState,
): "ok" | "warn" | "danger" | "muted" {
  switch (state) {
    case "CONNECTED":
    case "RUNNING":
      return "ok";
    case "STALE":
      return "warn";
    case "NETWORK_ERROR":
    case "AUTH_ERROR":
    case "UNREACHABLE":
    case "STOPPED":
      return "danger";
    default:
      return "muted";
  }
}

/**
 * Whether an acknowledgement is recent enough to still be believed.
 * Anything older is reported as STALE rather than as still working.
 */
export function isFresh(
  at: Date | string | null | undefined,
  now = Date.now(),
): boolean {
  if (!at) return false;
  const time = typeof at === "string" ? Date.parse(at) : at.getTime();
  if (Number.isNaN(time)) return false;
  return now - time <= STALE_AFTER_SECONDS * 1000;
}
