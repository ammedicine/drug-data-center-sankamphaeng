/**
 * Stopping an Agent's data sync from the centre, without stopping the Agent.
 *
 * The distinction is the whole design. A รพ.สต. PC may be on a network nobody
 * at the district office can reach, so the only thing that can be relied on is
 * what the centre refuses to accept - not what the Agent agrees to stop doing.
 * An Agent that has been switched off, or is on an older build that has never
 * heard of any of this, must still be unable to put rows into Central once an
 * administrator has said no.
 *
 * So there are two separate ideas here and they must not be collapsed:
 *
 *   desired state   what the centre has decided (authoritative for ingest)
 *   effective state what the Agent reports it is actually doing
 *
 * The centre blocks on the first. The second only tells an operator whether
 * the Agent has caught up yet, and an Agent that never acknowledges is still
 * safely blocked.
 *
 * None of this touches credentials. Pausing is an operational instruction, not
 * a security event: the Agent stays enrolled, keeps authenticating, keeps
 * heartbeating, keeps fixing its clock and keeps taking software updates. A
 * paused Agent is ONLINE, and the screen must say so.
 */

/** What the centre has decided this Agent should be doing. */
export const SYNC_CONTROL_STATES = ["RUNNING", "PAUSED"] as const;
export type SyncControlState = (typeof SYNC_CONTROL_STATES)[number];

/**
 * What the Agent reports it is actually doing.
 *
 * PAUSE_REQUESTED is the honest middle: the instruction arrived while a chunk
 * was in flight, and the Agent is finishing that one unit before it stops.
 * Cutting a write in half to look responsive would be the wrong trade.
 */
export const EFFECTIVE_SYNC_STATES = ["RUNNING", "PAUSE_REQUESTED", "PAUSED"] as const;
export type EffectiveSyncState = (typeof EFFECTIVE_SYNC_STATES)[number];

/**
 * The refusal an Agent sees when the centre is not accepting its data.
 *
 * 503 and not 401/403, and this is not a stylistic choice - it was measured
 * against the released v1.1.7 client. CentralApiError treats 4xx (bar 408 and
 * 429) as permanent, and a permanent failure makes the upload loop rewrite
 * every pending chunk into failed/ in a single pass and report the link as an
 * authentication problem. On v1.1.6 and earlier the tray renders that as
 * "สิทธิ์ถูกเพิกถอน" - a รพ.สต. being told its credential was cancelled
 * because an administrator paused it. A 503 is retryable: the chunk stays
 * pending, the loop stops after this one, and nothing is swept anywhere.
 */
export const SYNC_PAUSED_CODE = "SYNC_PAUSED_BY_ADMIN";
export const SYNC_PAUSED_STATUS = 503;

/**
 * Seconds an Agent is asked to wait, and deliberately small.
 *
 * withRetry in the released client uses Retry-After verbatim as its sleep, so
 * this number decides how long an old Agent sits inside a single upload. It
 * makes five attempts with a sleep between each, which is four sleeps, and it
 * does all of that while holding sync.lock - whose stale-takeover window is
 * exactly five minutes. At 60 seconds that is 240 seconds of sleeping plus
 * five round trips, close enough to 300 that a slow link would let a second
 * worker seize the lock and run a concurrent sync, which is the one thing the
 * lock exists to prevent. 45 leaves 180 seconds and a real margin.
 *
 * An hour, by contrast, would park the Agent for five hours.
 */
export const SYNC_PAUSED_RETRY_AFTER_SECONDS = 45;

/**
 * The earliest dispensing date any Agent collects unless told otherwise.
 *
 * 1 October 2022 - 1 ตุลาคม 2565, the start of a Thai fiscal year. JHCIS at
 * these สถานบริการ holds dispensing back to 2006, and none of it is wanted:
 * the first full collection at 05957 carried 268,474 rows of which 252,698
 * predate this floor. It is a floor on the source query, not a filter applied
 * after reading, because reading two decades to throw most of it away is the
 * cost this exists to avoid.
 */
export const DEFAULT_SYNC_START_DATE = "2022-10-01";

/** ISO yyyy-mm-dd, and a real date - no timezone, no time component. */
export function isValidSyncStartDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return (
    parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d
  );
}

/**
 * The floor applied to a range the machine chose for itself.
 *
 * The schedule, a reconciliation, a repair and the empty-watermark case all
 * come through here, and raising their start date silently is right: nobody
 * asked for a particular day, they asked for "whatever is missing".
 *
 * A range an operator typed is different and must not come through here - see
 * MANUAL_RANGE_BEFORE_FLOOR_CODE. Quietly narrowing somebody's explicit
 * request produces a run that reports success over a period it never read.
 */
export function applySyncStartFloor(from: string, floor: string): string {
  return from < floor ? floor : from;
}

/**
 * Why an operator's own range was refused rather than narrowed.
 *
 * "Read from 2019" at a สถานบริการ configured to collect from 2022 cannot be
 * honoured, and cannot be quietly turned into 2022 either: the operator would
 * be told the backfill succeeded while three years they explicitly asked for
 * were never touched. Refusing says what happened and what to change.
 *
 * The floor is set locally, in the Tray, and stays the only authority. This
 * error exists to send the operator there rather than to offer a way around it
 * from the centre.
 */
export const MANUAL_RANGE_BEFORE_FLOOR_CODE = "MANUAL_RANGE_BEFORE_SYNC_START_DATE";

export interface ManualRangeRefusal {
  code: typeof MANUAL_RANGE_BEFORE_FLOOR_CODE;
  requestedFromDate: string;
  configuredSyncStartDate: string;
  message: string;
}

/**
 * Whether an operator's range may run, and the refusal when it may not.
 *
 * Both ends being below the floor and only the start being below it are the
 * same answer: the whole request is refused. Partially processing the
 * overlapping part would be the silent narrowing under another name.
 */
export function checkManualRange(
  from: string,
  floor: string,
): ManualRangeRefusal | null {
  if (from >= floor) return null;
  return {
    code: MANUAL_RANGE_BEFORE_FLOOR_CODE,
    requestedFromDate: from,
    configuredSyncStartDate: floor,
    message: manualRangeRefusalMessage(from, floor),
  };
}

/** The Thai wording, in one place so the tray, the CLI and the web agree. */
export function manualRangeRefusalMessage(from: string, floor: string): string {
  return [
    "วันที่เริ่มต้นที่เลือกอยู่ก่อนวันที่เริ่มเก็บข้อมูลของ Agent",
    `ช่วงที่ขอ: ${toThaiDate(from)}`,
    `Agent นี้กำหนดเริ่มเก็บข้อมูลตั้งแต่: ${toThaiDate(floor)}`,
    'กรุณาปรับ "วันที่เริ่มเก็บข้อมูล" ในการตั้งค่า Agent ก่อน แล้วจึงลองใหม่',
  ].join("\n");
}

/** True when a stored record predates the floor and must not be uploaded. */
export function isBelowSyncFloor(usageDate: string, floor: string): boolean {
  return usageDate < floor;
}

/**
 * Thai display for a date the operator sees, e.g. 2022-10-01 -> 01/10/2565.
 *
 * Presentation only. Everything stored, sent or compared stays ISO, because a
 * Buddhist-era string that reached a query would be off by 543 years and the
 * mistake would look like a data problem rather than a formatting one.
 */
export function toThaiDate(iso: string): string {
  if (!isValidSyncStartDate(iso)) return "-";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${Number(y) + 543}`;
}

/**
 * Whether the centre will accept sync-mutating traffic from this Agent.
 *
 * Deliberately takes the desired state alone. What the Agent believes, whether
 * it has acknowledged, and whether it is even switched on make no difference
 * to what the centre is willing to store.
 */
export function ingestAllowed(desired: SyncControlState): boolean {
  return desired === "RUNNING";
}

/**
 * How far an Agent has got with an instruction, for the fleet screen.
 *
 * Kept here rather than in the page so the wording cannot drift between the
 * table, the details drawer and the reset-readiness view.
 */
export type ControlAckState =
  | "IN_SYNC"
  | "PAUSE_PENDING"
  | "RESUME_PENDING"
  | "NEVER_ACKED"
  | "UNSUPPORTED";

export function controlAckState(input: {
  desired: SyncControlState;
  effective: EffectiveSyncState | null;
  controlRevision: number;
  appliedRevision: number | null;
  supportsRemotePause: boolean;
}): ControlAckState {
  if (!input.supportsRemotePause) return "UNSUPPORTED";
  if (input.appliedRevision === null) return "NEVER_ACKED";
  if (input.appliedRevision >= input.controlRevision && input.effective === input.desired) {
    return "IN_SYNC";
  }
  return input.desired === "PAUSED" ? "PAUSE_PENDING" : "RESUME_PENDING";
}
