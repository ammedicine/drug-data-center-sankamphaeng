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
 * The states are separated by what fixes them, because that is what the person
 * reading the screen needs to know. NETWORK_ERROR waits. CREDENTIAL_REVOKED
 * needs an administrator. CLOCK_SKEW fixes itself once Windows knows the time.
 *
 * CLOCK_SKEW exists because it used to be reported as a revoked credential. A
 * รพ.สต. whose clock had drifted 41 minutes was told its Agent had been
 * cancelled and to contact the administrator - for a machine that was working
 * perfectly and needed its clock set. The signature check refuses a request
 * whose timestamp is outside the replay window, which is right, and that
 * refusal is a 401 like any other; only the error code tells them apart.
 *
 * AUTH_ERROR remains for a 401 or 403 we cannot classify further.
 */
export type CentralLinkState =
  | "CONNECTED"
  | "NETWORK_ERROR"
  | "CLOCK_SKEW"
  | "CREDENTIAL_REVOKED"
  | "AUTH_ERROR"
  | "STALE"
  | "UNKNOWN";

/** What the Agent believes about this PC's clock. */
export type ClockState =
  | "HEALTHY"
  | "WARNING"
  | "CLOCK_SKEW"
  | "SYNCING"
  | "CLOCK_SYNC_FAILED"
  | "UNKNOWN";

/**
 * How far this PC's clock may drift from Central before it matters.
 *
 * The replay window is +/-300 seconds and is a security control: it is not
 * widened to accommodate a badly synchronised PC, and nothing here changes it.
 * These thresholds sit inside it so the Agent repairs the clock before the
 * signature check starts refusing requests, rather than after.
 */
export const CLOCK_HEALTHY_SECONDS = 120;
export const CLOCK_SKEW_LIMIT_SECONDS = 300;

/** The error code Central returns when a request's timestamp is out of window. */
export const TIMESTAMP_SKEW_CODE = "TIMESTAMP_SKEW";

/** Codes that prove the credential itself is gone, rather than merely refused. */
export const REVOKED_AUTH_CODES = ["AGENT_DISABLED", "UNKNOWN_KEY", "CREDENTIAL_REVOKED"];

/**
 * Classifies a refusal from Central.
 *
 * Only an explicit code earns CREDENTIAL_REVOKED. Anything else that is
 * refused stays AUTH_ERROR - unhelpful, but honest, and it does not send
 * someone to re-enrol a machine that does not need it.
 */
export function classifyCentralFailure(input: {
  status: number;
  code?: string | null;
}): CentralLinkState {
  const code = input.code ?? "";
  if (code === TIMESTAMP_SKEW_CODE || code === "BAD_TIMESTAMP") return "CLOCK_SKEW";
  if (REVOKED_AUTH_CODES.includes(code)) return "CREDENTIAL_REVOKED";
  if (input.status === 401 || input.status === 403) return "AUTH_ERROR";
  return "NETWORK_ERROR";
}

/** Where an absolute skew falls in the policy above. */
export function clockStateFor(skewSeconds: number): ClockState {
  const skew = Math.abs(skewSeconds);
  if (skew < CLOCK_HEALTHY_SECONDS) return "HEALTHY";
  if (skew < CLOCK_SKEW_LIMIT_SECONDS) return "WARNING";
  return "CLOCK_SKEW";
}

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
  CLOCK_SKEW: "เวลาเครื่องไม่ตรง",
  CREDENTIAL_REVOKED: "สิทธิ์ของ Agent นี้ถูกยกเลิก",
  AUTH_ERROR: "ศูนย์กลางปฏิเสธคำขอ",
  STALE: "ไม่ได้ติดต่อมานาน",
  UNKNOWN: "ยังไม่ทราบ",
};

export const CLOCK_STATE_LABELS: Record<ClockState, string> = {
  HEALTHY: "ปกติ",
  WARNING: "คลาดเคลื่อนเล็กน้อย",
  CLOCK_SKEW: "เวลาเครื่องคลาดเคลื่อน",
  SYNCING: "กำลังซิงก์เวลา",
  CLOCK_SYNC_FAILED: "ซิงก์เวลา Windows ไม่สำเร็จ",
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
