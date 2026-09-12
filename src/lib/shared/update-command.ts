/**
 * Remote software updates - the words both sides use.
 *
 * A SUPER_ADMIN presses "Update Now" for one or many Agents. Each press
 * becomes one durable command row per Agent in TiDB, and nothing else: no
 * process memory, no queue in a Vercel function, because there is no Vercel
 * process that lives long enough to hold it. The Agent hears about the
 * command on the channel it already calls - the heartbeat - and reports back
 * on the same channel. Central never reaches into a clinic.
 *
 * The state machine below is shared verbatim by the Central service, the
 * heartbeat route, the Agent's updater and the screen, so that "INSTALLING"
 * means one thing everywhere. Transitions are a table, not a habit; a report
 * that does not fit the table is refused and logged rather than stored.
 */

export const UPDATE_COMMAND_STATES = [
  "REQUESTED",
  "DELIVERED",
  "WAITING_FOR_IDLE",
  "CHECKING",
  "DOWNLOADING",
  "VERIFYING",
  "INSTALLING",
  "SUCCESS",
  "FAILED",
  "CANCELLED",
  "SUPERSEDED",
] as const;

export type UpdateCommandState = (typeof UPDATE_COMMAND_STATES)[number];

/** States in which nothing more will happen to the command. */
export const TERMINAL_UPDATE_STATES: readonly UpdateCommandState[] = [
  "SUCCESS",
  "FAILED",
  "CANCELLED",
  "SUPERSEDED",
];

/** States the Agent itself reports; the others are decided at the centre. */
export const AGENT_REPORTED_STATES: readonly UpdateCommandState[] = [
  "WAITING_FOR_IDLE",
  "CHECKING",
  "DOWNLOADING",
  "VERIFYING",
  "INSTALLING",
  "SUCCESS",
  "FAILED",
];

/**
 * States that hold one of the rollout slots.
 *
 * A fleet-wide "update all" must not become fifteen simultaneous downloads and
 * fifteen simultaneous restarts. Commands are all REQUESTED at once, durably,
 * but only this many may be past REQUESTED at any moment; the rest are handed
 * out as slots free up. WAITING_FOR_IDLE holds a slot too - an Agent that is
 * syncing will install the moment it finishes, and giving its slot away would
 * let a third install start on top of that.
 */
export const ROLLOUT_ACTIVE_STATES: readonly UpdateCommandState[] = [
  "DELIVERED",
  "WAITING_FOR_IDLE",
  "CHECKING",
  "DOWNLOADING",
  "VERIFYING",
  "INSTALLING",
];

/** How many Agents may be actively updating at once, fleet-wide. */
export const MAX_ACTIVE_ROLLOUT = 2;

/**
 * A slot held longer than this is presumed abandoned - a PC switched off
 * mid-download - and no longer counts against the bound. The command itself
 * is not failed by this; the Agent may still finish when it comes back.
 */
export const ROLLOUT_SLOT_STALE_MINUTES = 45;

/**
 * A command that has not reached a terminal state after this long is failed
 * by the centre with UPDATE_TIMED_OUT, so the screen never shows "installing"
 * for a week about a machine that was unplugged.
 */
export const UPDATE_COMMAND_TIMEOUT_HOURS = 24;

const RANK: Record<UpdateCommandState, number> = {
  REQUESTED: 0,
  DELIVERED: 1,
  WAITING_FOR_IDLE: 2,
  CHECKING: 2,
  DOWNLOADING: 3,
  VERIFYING: 4,
  INSTALLING: 5,
  SUCCESS: 9,
  FAILED: 9,
  CANCELLED: 9,
  SUPERSEDED: 9,
};

/**
 * Whether a command may move from one state to another.
 *
 *  - Terminal states never move.
 *  - REQUESTED becomes DELIVERED (the centre handed it out), CANCELLED (an
 *    operator withdrew it) or SUPERSEDED (a newer target replaced it).
 *  - Once delivered, the Agent drives it. Reports may skip forward - an Agent
 *    that found the installer already verified goes straight to INSTALLING -
 *    and may fall back to WAITING_FOR_IDLE from anywhere, because a sync can
 *    start at any point before the installer runs. They may repeat a state
 *    (a second download attempt). They may not go backwards otherwise.
 *  - SUCCESS or FAILED may be reported from any delivered state.
 *  - CANCELLED is only possible before delivery: once an Agent has the
 *    command there is no reliable way to take it back, and pretending there
 *    is would be worse than saying so.
 */
export function canTransition(from: UpdateCommandState, to: UpdateCommandState): boolean {
  if (TERMINAL_UPDATE_STATES.includes(from)) return false;
  if (from === "REQUESTED") return to === "DELIVERED" || to === "CANCELLED" || to === "SUPERSEDED";
  if (to === "REQUESTED" || to === "DELIVERED" || to === "CANCELLED") return false;
  if (to === "SUPERSEDED") return false;
  if (to === "WAITING_FOR_IDLE") return true;
  if (to === "SUCCESS" || to === "FAILED") return true;
  return RANK[to] >= RANK[from];
}

/** Error codes an Agent or the centre may attach to a FAILED command. */
export const UPDATE_ERROR_CODES = [
  "TARGET_NOT_NEWER",
  "TARGET_NOT_AVAILABLE",
  "ASSET_NAME_INVALID",
  "SIZE_MISMATCH",
  "DIGEST_MISMATCH",
  "DIGEST_MISSING",
  "DOWNLOAD_FAILED",
  "INSTALLER_FAILED",
  "INSTALL_INCOMPLETE",
  "UPDATE_TIMED_OUT",
  "UNSUPPORTED_CLIENT",
  "CENTRAL_UNAVAILABLE",
] as const;
export type UpdateErrorCode = (typeof UPDATE_ERROR_CODES)[number];

/** Which failures are worth another attempt without a person looking. */
export function isTransientUpdateError(code: string | null | undefined): boolean {
  return code === "DOWNLOAD_FAILED" || code === "CENTRAL_UNAVAILABLE" || code === "INSTALL_INCOMPLETE";
}

/** Attempts an Agent makes on one command before giving up on it. */
export const MAX_UPDATE_ATTEMPTS = 3;

/**
 * Thai for the screen. One place, so the fleet page and the details drawer
 * never disagree about what a state is called.
 */
export const UPDATE_STATE_LABELS: Record<UpdateCommandState | "OFFLINE_REQUESTED" | "ALREADY_UP_TO_DATE", string> = {
  REQUESTED: "รอ Agent รับคำสั่ง",
  OFFLINE_REQUESTED: "รอเครื่องออนไลน์",
  DELIVERED: "Agent รับคำสั่งแล้ว",
  WAITING_FOR_IDLE: "รอการซิงก์เสร็จ",
  CHECKING: "กำลังตรวจสอบรุ่น",
  DOWNLOADING: "กำลังดาวน์โหลด",
  VERIFYING: "กำลังตรวจสอบไฟล์",
  INSTALLING: "กำลังติดตั้ง",
  SUCCESS: "อัปเดตสำเร็จ",
  FAILED: "อัปเดตไม่สำเร็จ",
  CANCELLED: "ยกเลิกแล้ว",
  SUPERSEDED: "ถูกแทนที่ด้วยคำสั่งใหม่",
  ALREADY_UP_TO_DATE: "เป็นรุ่นล่าสุดแล้ว",
};

/** Thai for an error code, without leaking anything internal. */
export const UPDATE_ERROR_LABELS: Record<UpdateErrorCode, string> = {
  TARGET_NOT_NEWER: "รุ่นเป้าหมายไม่ใหม่กว่ารุ่นที่ติดตั้งอยู่",
  TARGET_NOT_AVAILABLE: "รุ่นเป้าหมายไม่ใช่รุ่นที่เผยแพร่อยู่แล้ว",
  ASSET_NAME_INVALID: "ชื่อไฟล์ติดตั้งไม่ถูกต้อง",
  SIZE_MISMATCH: "ขนาดไฟล์ไม่ตรงกับที่เผยแพร่",
  DIGEST_MISMATCH: "ค่าตรวจสอบไฟล์ (SHA-256) ไม่ตรงกับที่เผยแพร่",
  DIGEST_MISSING: "รุ่นนี้ไม่มีค่าตรวจสอบไฟล์ จึงติดตั้งอัตโนมัติไม่ได้",
  DOWNLOAD_FAILED: "ดาวน์โหลดไม่สำเร็จ",
  INSTALLER_FAILED: "ตัวติดตั้งจบด้วยข้อผิดพลาด",
  INSTALL_INCOMPLETE: "ติดตั้งไม่จบ (เครื่องอาจถูกปิดระหว่างติดตั้ง)",
  UPDATE_TIMED_OUT: "หมดเวลารอ Agent (เครื่องอาจปิดอยู่)",
  UNSUPPORTED_CLIENT: "รุ่นที่ติดตั้งอยู่ไม่รองรับคำสั่งอัปเดตจากศูนย์กลาง",
  CENTRAL_UNAVAILABLE: "ติดต่อศูนย์กลางไม่ได้ชั่วคราว",
};

/** The capability flag a client must report for the centre to hand it a command. */
export const REMOTE_UPDATE_CAPABILITY = "remoteUpdate";
