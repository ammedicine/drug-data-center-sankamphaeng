/**
 * Agent configuration and credential storage.
 *
 * JHCIS credentials come from the environment and never leave this machine.
 * The central credential is written to agent.config.json with restrictive file
 * permissions - it is never logged and never printed after enrollment.
 */
import {
  existsSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { hostname, userInfo } from "node:os";
import { dirname, isAbsolute, relative as relativePath, resolve, sep } from "node:path";

import {
  HEARTBEAT_INTERVAL_SECONDS,
  type CentralLinkState,
  type ClockState,
  type JhcisLinkState,
  type SyncPhase,
} from "@shared/agent-status";
import { DEFAULT_SYNC_START_DATE, isValidSyncStartDate } from "@shared/sync-control";

import * as dotenv from "dotenv";

dotenv.config();

/**
 * Reported to Central on every heartbeat and shown in the Agent table.
 *
 * Must match the git tag the installer is built from - build.ps1 refuses to
 * build when they disagree, because a fleet that all reports 1.0.0 tells an
 * operator nothing about which machines still need updating.
 */
export const AGENT_VERSION = "1.1.10";

/**
 * Which source this build came from, stamped by the installer build script.
 *
 * The version alone was not enough. Three different v1.1.7 builds all reported
 * "1.1.7" - one that corrupted Thai text, one whose tray strangled its own
 * worker, and the released one - and Central could not tell which of them a
 * machine was running when deciding whether an update was safe to push.
 * Replaced at build time; "dev" when running from a checkout.
 */
export const AGENT_BUILD_ID = process.env.AGENT_BUILD_ID ?? "dev";

/**
 * What this build can do, reported so the centre never has to infer it from a
 * version number. Anything a build cannot do is simply absent from an older
 * agent's report, and absent reads as false.
 */
export const AGENT_CAPABILITIES = {
  autoUpdate: true,
  remotePause: true,
  syncStartDate: true,
  charsetGate: true,
  workerLock: true,
  boundedWorkerLog: true,
  remoteUpdate: true,
} as const;

/**
 * How long the agent will wait on JHCIS before giving up.
 *
 * Every one of these exists because an unbounded wait does not look like a
 * failure: the process stays alive, the window keeps its last picture, and the
 * machine simply stops reporting. That is worse than an error, because nobody
 * is told. A รพ.สต. server that accepts the connection and then stops
 * answering - a saturated MySQL, a wedged VM - produced exactly that.
 *
 * The values are generous on purpose. Killing a slow but healthy extraction is
 * its own failure, and a รพ.สต. LAN is not a data centre.
 */
export const JHCIS_CONNECT_TIMEOUT_MS = 10_000;
/** Waiting for a free connection when the pool is busy or wedged. */
export const JHCIS_ACQUIRE_TIMEOUT_MS = 20_000;
/** A single statement. Extraction pages are far quicker than this in practice. */
export const JHCIS_QUERY_TIMEOUT_MS = 120_000;
/**
 * The whole health check a heartbeat makes - a ping plus the schema report.
 * Short, because a heartbeat that waits for a sick database is a heartbeat
 * that never arrives, and the answer "JHCIS is not responding" is the useful
 * one.
 */
export const JHCIS_PROBE_TIMEOUT_MS = 20_000;

export interface JhcisConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

/** Persisted credential + central-approved settings. */
export interface AgentCredentialFile {
  agentId: string;
  keyId: string;
  secret: string;
  centralApiUrl: string;
  facilityId: string;
  facilityCode: string;
  facilityName: string;
  expectedPcucode: string;
  installationId: string;
  syncIntervalMinutes: number;
  reprocessDays: number;
  enrolledAt: string;
}

export interface AgentState {
  /** highest visit_date fully ingested by the central server */
  lastSyncedVisitDate: string | null;
  lastSyncAt: string | null;
  batchSequence: number;

  /**
   * The centre's last known instruction, kept on disk on purpose.
   *
   * A paused สถานบริการ that reboots must come back paused. If this were held
   * only in memory, every restart would be a window in which the agent
   * believed it was free to read JHCIS and upload - and the machine most
   * likely to restart during a reset is the one somebody is standing in front
   * of. Persisted, the answer survives reboots, upgrades and power cuts.
   *
   * Absent means an agent that has never been told anything, which is RUNNING.
   */
  syncControlState?: "RUNNING" | "PAUSED";
  /** the revision this agent has acted on, so the same order is obeyed once */
  appliedControlRevision?: number;
  controlAppliedAt?: string | null;
  pauseReason?: string | null;
}

/**
 * Where the agent keeps its queue, state and credential.
 *
 * AGENT_DATA_DIR wins when it is set, but it cannot be relied on: the
 * installer writes it to the machine environment, and a tray launched from
 * that same installer - or any process started before the change is
 * broadcast - still runs with the old environment and never sees it. Falling
 * back to a folder beside the executable then puts working data inside
 * Program Files, which a normal staff account cannot write to at all, so the
 * agent would fail to save anything on a real รพ.สต. PC while working
 * perfectly for whoever installed it as an administrator.
 *
 * So Windows falls back to ProgramData, which is writable by design and is
 * where the installer creates the folder anyway.
 */
export function dataDir(): string {
  const dir = resolveDataDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** True when `target` is the folder at `root`, or anything beneath it. */
function isInside(target: string, root: string): boolean {
  const step = relativePath(root, target);
  // Across drives there is no relative route, and Windows answers with the
  // target itself - D:\SDCAgentData is not below C:\Program Files, however
  // little it looks like a way back up.
  if (isAbsolute(step)) return false;
  return step === "" || (!step.startsWith("..") && !step.startsWith(sep));
}

/**
 * Decides the data folder from an environment, without touching the disk.
 *
 * Separated from dataDir() so the upgrade cases can be tested: the interesting
 * ones are about which environment the agent was started with, and creating
 * folders under Program Files to find out is not a test anyone wants to run.
 *
 * The guard is one rule: on Windows, a data folder inside a Program Files root
 * is refused, whatever asked for it. An agent upgraded from an old release can
 * still have {app}\.env saying AGENT_DATA_DIR=./data, which resolves against
 * cwd={app} to a folder no staff account may write to - the tray would look
 * fine for the administrator who installed it and save nothing for anybody
 * else. ProgramData is where the installer grants write access, so that is
 * where the refusal lands.
 *
 * The roots are read from the environment rather than spelled out, because
 * "Program Files" is not the folder's name on every Windows installation.
 *
 * Trade-off: an agent deliberately installed outside Program Files - say
 * D:\Apps\SDCAgent - with a legacy relative setting is not caught, and keeps
 * its {app}\data folder. Detecting that would mean reasoning about where the
 * bundled node.exe lives, which is more machinery than the case deserves: the
 * installer puts the agent in Program Files, and the tray now passes an
 * absolute AGENT_DATA_DIR anyway. This is the second line of defence, for an
 * agent started outside the tray.
 */
export function resolveDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  base: string = process.cwd(),
): string {
  const windows = platform === "win32";
  const fallback =
    windows && env.ProgramData ? resolve(env.ProgramData, "SDCAgent") : resolve(base, "data");

  const configured = env.AGENT_DATA_DIR?.trim();
  if (!configured) return fallback;

  const target = resolve(base, configured);
  if (windows) {
    const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramW6432].filter(
      (root): root is string => Boolean(root && root.trim()),
    );
    if (roots.some((root) => isInside(target, resolve(root)))) return fallback;
  }
  return target;
}

/**
 * Where the central credential lives.
 *
 * It holds the HMAC secret that lets this machine speak for its สถานบริการ, so
 * it belongs inside the agent's own data directory - the one the installer
 * created and set permissions on. It used to be written one level up, which on
 * a real install put it in the root of C:\ProgramData where every local user
 * can read it; installs from that period are moved on first use.
 */
export function configPath(): string {
  return resolve(dataDir(), "agent.config.json");
}

/** The pre-1.0.1 location, kept only so an existing install can be migrated. */
function legacyConfigPath(): string {
  return resolve(dataDir(), "..", "agent.config.json");
}

/**
 * Locks a file down to SYSTEM, Administrators and the account that owns it.
 *
 * Node's file mode is a no-op on Windows - it only toggles the read-only bit -
 * so the POSIX 0600 below protects nothing there. icacls is what actually
 * removes the inherited "Users can read" entry.
 */
function restrictToOwner(path: string): void {
  if (process.platform !== "win32") return;
  try {
    // SYSTEM and Administrators by SID, so this does not depend on the
    // language of the Windows install; the owner by bare username, which
    // icacls resolves against the machine or its domain.
    execFileSync(
      "icacls",
      [
        path,
        "/inheritance:r",
        "/grant:r",
        "*S-1-5-18:F",
        "*S-1-5-32-544:F",
        `${userInfo().username}:F`,
      ],
      { stdio: "ignore" },
    );
  } catch {
    // An unusual account name or a locked-down host can make this fail; the
    // agent must still run, and the file is no worse off than before.
  }
}

export function statePath(): string {
  return resolve(dataDir(), "state.json");
}

/**
 * Connection settings saved from the tray, if any.
 *
 * A รพ.สต. can move its JHCIS server, or the agent can be pointed at a
 * different LAN, without anyone editing a file in Program Files - which the
 * staff account cannot write to anyway. What is saved here wins over .env, so
 * the file the operator can actually change is the one that decides.
 */
export function jhcisOverridePath(): string {
  return resolve(dataDir(), "jhcis.json");
}

export function loadJhcisOverride(): Partial<JhcisConfig> | null {
  const path = jhcisOverridePath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Partial<JhcisConfig>;
  } catch {
    // A truncated write should not stop the agent from starting on .env.
    return null;
  }
}

/** Writes the override with the same lock-down as the central credential. */
export function saveJhcisOverride(config: JhcisConfig): void {
  const path = jhcisOverridePath();
  writeFileSync(path, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ignores POSIX modes.
  }
  restrictToOwner(path);
}

export function jhcisConfig(): JhcisConfig {
  const saved = loadJhcisOverride();
  const user = saved?.user || process.env.JHCIS_DB_USER;
  if (!user) {
    throw new Error(
      "ยังไม่ได้ตั้งค่าการเชื่อมต่อ JHCIS - ตั้งได้ที่หน้าจอโปรแกรม หรือ copy agent/.env.example เป็น agent/.env",
    );
  }
  return {
    host: saved?.host || process.env.JHCIS_DB_HOST || "localhost",
    port: Number(saved?.port ?? process.env.JHCIS_DB_PORT ?? 3306),
    database: saved?.database || process.env.JHCIS_DB_DATABASE || "jhcisdb",
    user,
    password: saved?.password ?? process.env.JHCIS_DB_PASSWORD ?? "",
  };
}

export function centralApiUrl(): string {
  const url = process.env.CENTRAL_API_URL ?? loadCredential()?.centralApiUrl;
  if (!url) throw new Error("CENTRAL_API_URL is not set and the agent is not enrolled yet.");
  return url.replace(/\/+$/, "");
}

export function loadCredential(): AgentCredentialFile | null {
  const path = configPath();
  if (!existsSync(path)) {
    const legacy = legacyConfigPath();
    if (legacy !== path && existsSync(legacy)) {
      renameSync(legacy, path);
      restrictToOwner(path);
    } else {
      return null;
    }
  }
  return JSON.parse(readFileSync(path, "utf8")) as AgentCredentialFile;
}

export function requireCredential(): AgentCredentialFile {
  const credential = loadCredential();
  if (!credential) {
    throw new Error("Agent is not enrolled yet. Run: sdc-agent enroll --token <ENROLLMENT_TOKEN>");
  }
  return credential;
}

export function saveCredential(credential: AgentCredentialFile): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(credential, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ignores POSIX modes.
  }
  restrictToOwner(path);
}

export function loadState(): AgentState {
  const path = statePath();
  if (!existsSync(path)) {
    return { lastSyncedVisitDate: null, lastSyncAt: null, batchSequence: 0 };
  }
  return JSON.parse(readFileSync(path, "utf8")) as AgentState;
}

export function saveState(state: AgentState): void {
  writeFileSync(statePath(), JSON.stringify(state, null, 2), "utf8");
}

/** Stable per-installation id, generated once and reused. */
export function installationId(): string {
  const credential = loadCredential();
  if (credential?.installationId) return credential.installationId;
  return `${hostname()}-${Math.random().toString(36).slice(2, 10)}`.slice(0, 64);
}

export function machineHostname(): string {
  return hostname();
}

/* ------------------------------------------------------- local settings */

/**
 * Local scheduling preferences, owned by the operator through the desktop app.
 * Central still decides what the agent may read; this only decides *when* the
 * agent runs, so a รพ.สต. can avoid syncing during clinic rush hours.
 */
export interface AgentSettings {
  autoSyncEnabled: boolean;
  /** run every N minutes (0 = ปิด, ใช้เฉพาะเวลาที่กำหนดใน dailyTimes) */
  syncIntervalMinutes: number;
  /** fixed clock times to sync at, "HH:MM" 24-hour */
  dailyTimes: string[];
  /**
   * Superseded by heartbeatSeconds; kept so a settings.json written by an
   * older Agent still loads. Minutes are too coarse for a status someone is
   * watching: at the old default of 5, the web could be five minutes behind
   * the tray while both were working perfectly.
   */
  heartbeatMinutes: number;
  /** how often to report in; the value actually used */
  heartbeatSeconds: number;
  /** start the desktop app with Windows */
  startWithWindows: boolean;
  /** keep running in the notification area when the window is closed */
  minimiseToTray: boolean;
  /**
   * Earliest dispensing date this สถานบริการ collects, ISO yyyy-mm-dd.
   *
   * JHCIS here holds dispensing back to 2006 and almost none of it is wanted:
   * the full collection at 05957 carried 268,474 rows of which 252,698 predate
   * October 2022. This is a floor on the source query, not a filter applied
   * afterwards - reading two decades in order to discard most of it is the
   * cost the setting exists to avoid.
   *
   * Absent means the default, which is why loadSettings fills it in rather
   * than leaving it undefined for every caller to guess at.
   */
  syncStartDate: string;
}

export const DEFAULT_SETTINGS: AgentSettings = {
  autoSyncEnabled: true,
  syncIntervalMinutes: 60,
  dailyTimes: [],
  heartbeatMinutes: 5,
  heartbeatSeconds: HEARTBEAT_INTERVAL_SECONDS,
  startWithWindows: true,
  minimiseToTray: true,
  syncStartDate: DEFAULT_SYNC_START_DATE,
};

export function settingsPath(): string {
  return resolve(dataDir(), "settings.json");
}

export function loadSettings(): AgentSettings {
  const path = settingsPath();
  if (!existsSync(path)) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AgentSettings>;
    const merged = { ...DEFAULT_SETTINGS, ...parsed };
    // A settings.json written before this release has no floor, and one
    // written by hand may have nonsense in it. Neither may be allowed to
    // become a query predicate: an invalid date would either read nothing at
    // all or - worse - silently read everything back to 2006.
    if (!isValidSyncStartDate(merged.syncStartDate ?? "")) {
      merged.syncStartDate = DEFAULT_SYNC_START_DATE;
    }
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** The floor every read goes through, always a valid ISO date. */
export function syncStartDate(): string {
  return loadSettings().syncStartDate;
}

export function saveSettings(settings: Partial<AgentSettings>): AgentSettings {
  const merged = { ...loadSettings(), ...settings };
  writeFileSync(settingsPath(), JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

/* --------------------------------------------------------- live status */

/**
 * A small file the desktop app polls for progress. It is written frequently and
 * atomically (temp + rename) so a half-written file is never observed.
 */
/**
 * What the Agent knows about itself, written to status.json for the desktop
 * app to read.
 *
 * Two rules shaped this. Nothing here is derived from `message` - the text is
 * for a person, and every number a screen needs is its own field, so the tray
 * never parses prose to decide what to draw. And a link is only reported as
 * working on evidence that it worked, with a timestamp saying when: a live
 * process and a retryable-looking error are not evidence.
 */
export interface AgentStatus {
  /** legacy free-text phase, kept so an older desktop app still works */
  phase: "idle" | "starting" | "extracting" | "uploading" | "done" | "error";
  message: string;
  /** rows the current run expects to move, and how far it has got */
  total: number;
  extracted: number;
  uploaded: number;
  pendingChunks: number;
  batchRef: string | null;
  /** legacy booleans, still written so an older tray keeps working */
  jhcisConnected: boolean | null;
  centralConnected: boolean | null;
  lastSyncAt: string | null;
  lastError: string | null;
  updatedAt: string;

  /* ---------------------------------------------------- connection truth */
  centralState: CentralLinkState;
  jhcisState: JhcisLinkState;
  /** what the Agent last measured about this PC's clock */
  clockState: ClockState;
  /** what the last update check found: NONE / AVAILABLE / DOWNLOADING / READY / BLOCKED / FAILED */
  updateState: string;
  updateLatestVersion: string | null;
  updateCheckedAt: string | null;
  updateDetail: string | null;
  /** local minus central, in seconds; positive means this PC is ahead */
  clockSkewSeconds: number | null;
  lastClockCheckAt: string | null;
  syncPhase: SyncPhase;
  /** when a heartbeat was last attempted, whether or not it worked */
  centralAttemptAt: string | null;
  /** when the Central API last answered an authenticated request */
  centralAckAt: string | null;
  /** when the JHCIS connection was last proven by connecting to it */
  jhcisCheckedAt: string | null;

  /* -------------------------------------------------- live sync telemetry */
  /** service dates the current run is reading */
  rangeFrom: string | null;
  rangeTo: string | null;
  /** rows JHCIS says are in that range */
  recordsExpected: number;
  /** read out of JHCIS so far */
  recordsExtracted: number;
  /** written to the durable queue */
  recordsQueued: number;
  /** sent to Central in a request */
  recordsUploaded: number;
  /** Central confirmed it stored */
  recordsAccepted: number;
  /** Central refused, with the reason recorded centrally */
  recordsRejected: number;
  syncStartedAt: string | null;
  lastProgressAt: string | null;
  /** when the schedule fires next, so the tray can say so */
  nextSyncAt: string | null;
  /**
   * The last time the worker's own loop ran, and nothing more.
   *
   * Deliberately says nothing about JHCIS or Central: it is the one signal
   * that separates "this process is still doing its rounds" from "this
   * process is alive but has stopped" - a state that looked identical from
   * outside and left a รพ.สต. silent for twenty-five minutes with its icon
   * still in the tray.
   */
  lastWorkerTickAt: string | null;

  /**
   * The centre's instruction, mirrored for the screen.
   *
   * The window must be able to say "หยุดโดยผู้ดูแลระบบ" rather than inventing
   * an explanation. A paused agent is connected and its credential is valid,
   * so showing "ออฟไลน์" or "สิทธิ์ถูกเพิกถอน" would send somebody looking
   * for a fault that does not exist.
   */
  syncControlState?: "RUNNING" | "PAUSED";
  controlRevision?: number;
  controlAppliedAt?: string | null;
  pauseReason?: string | null;

  /**
   * What the two elevated scheduled tasks actually did, and who ran them.
   *
   * Needed because the same two commands can be reached from the window's
   * buttons, and from outside the two are indistinguishable: a clock check
   * appearing in status.json proves something ran `agent time-sync`, not that
   * Task Scheduler did. Recording the account separates them - a tray press
   * carries the staff account, the scheduled task carries SYSTEM - and it is
   * the only way to tell, without an elevated shell, whether the tasks the
   * installer created are firing at all.
   *
   * An account name is not a credential. Nothing else is recorded here.
   */
  timeSyncTaskLastRunAt: string | null;
  timeSyncTaskLastResult: string | null;
  autoUpdateTaskLastRunAt: string | null;
  autoUpdateTaskLastResult: string | null;
}

export function statusPath(): string {
  return resolve(dataDir(), "status.json");
}

export function loadStatus(): AgentStatus {
  const path = statusPath();
  const empty: AgentStatus = {
    phase: "idle",
    message: "",
    total: 0,
    extracted: 0,
    uploaded: 0,
    pendingChunks: 0,
    batchRef: null,
    jhcisConnected: null,
    centralConnected: null,
    lastSyncAt: null,
    lastError: null,
    updatedAt: new Date().toISOString(),
    // Every new field defaults here and loadStatus spreads the file over it,
    // so a status.json from an older Agent stays readable - the fields it
    // never heard of simply keep these values.
    centralState: "UNKNOWN",
    jhcisState: "UNKNOWN",
    clockState: "UNKNOWN",
    updateState: "NONE",
    updateLatestVersion: null,
    updateCheckedAt: null,
    updateDetail: null,
    clockSkewSeconds: null,
    lastClockCheckAt: null,
    syncPhase: "IDLE",
    centralAttemptAt: null,
    centralAckAt: null,
    jhcisCheckedAt: null,
    rangeFrom: null,
    rangeTo: null,
    recordsExpected: 0,
    recordsExtracted: 0,
    recordsQueued: 0,
    recordsUploaded: 0,
    recordsAccepted: 0,
    recordsRejected: 0,
    syncStartedAt: null,
    lastProgressAt: null,
    nextSyncAt: null,
    lastWorkerTickAt: null,
    syncControlState: "RUNNING",
    controlRevision: 0,
    controlAppliedAt: null,
    pauseReason: null,
    timeSyncTaskLastRunAt: null,
    timeSyncTaskLastResult: null,
    autoUpdateTaskLastRunAt: null,
    autoUpdateTaskLastResult: null,
  };
  if (!existsSync(path)) return empty;
  try {
    return { ...empty, ...(JSON.parse(readFileSync(path, "utf8")) as Partial<AgentStatus>) };
  } catch {
    return empty;
  }
}

/** Windows hands these back while something else briefly holds the file. */
const TRANSIENT_WRITE_CODES = new Set(["EPERM", "EBUSY", "EACCES", "ENOENT"]);

/** Waits between attempts, growing a little each time. */
const WRITE_RETRY_DELAYS_MS = [10, 25, 50, 100, 200];

/**
 * Counted so an operator can tell a quiet machine from a struggling one.
 *
 * Kept here rather than logged from here: the logger writes into the data
 * directory this module resolves, and importing it back would be a cycle. The
 * worker reads these on its rounds and logs them - see reportStatusWrites in
 * cli.ts. That was claimed here long before it was true, and a status file
 * that silently stopped being written looks exactly like a worker that has
 * stopped: the screen freezes, the watchdog restarts a process that was never
 * unwell, and nothing anywhere says which of the two happened.
 *
 * lastError holds an error code, never a path or file contents.
 */
export const statusWriteStats = { retries: 0, failures: 0, lastError: null as string | null };

let statusWriteSequence = 0;

/** Blocks briefly. Justified below: these writes are synchronous by design. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Records the agent's status for the screen to read.
 *
 * This is telemetry, not data. The queue, the watermark and the credential are
 * what must never be lost; this file only decides what the window draws. It
 * used to throw, and a throw from here killed the worker: an unhandled
 * rejection inside the scheduler's tick ends the process, so a รพ.สต. went
 * offline until somebody restarted the tray - because a status file could not
 * be renamed.
 *
 * Two things caused those renames to fail. The temporary file had one fixed
 * name shared by every process, so the worker and a manual sync started from
 * the tray would write to the same path and take each other's file away. And
 * on Windows a rename fails outright while anything else holds the target open
 * for even a moment - a virus scanner reading a file that was just created is
 * enough. Neither is worth an agent for.
 *
 * So the temporary name is unique per process and per write, the rename is
 * retried briefly, and giving up leaves the previous status in place and
 * returns rather than throwing. An old status on screen is a small problem; an
 * agent that stopped is not.
 */
export function writeStatus(patch: Partial<AgentStatus>): AgentStatus {
  const next: AgentStatus = { ...loadStatus(), ...patch, updatedAt: new Date().toISOString() };
  const target = statusPath();
  // Same directory, so the rename stays on one volume; unique per process and
  // per call, so two writers can never take each other's temporary file.
  const temp = `${target}.${process.pid}.${++statusWriteSequence}.tmp`;

  try {
    writeFileSync(temp, JSON.stringify(next, null, 2), "utf8");
  } catch (error) {
    statusWriteStats.failures += 1;
    statusWriteStats.lastError = describeWriteError(error);
    return next;
  }

  for (let attempt = 0; attempt <= WRITE_RETRY_DELAYS_MS.length; attempt++) {
    try {
      renameSync(temp, target);
      return next;
    } catch (error) {
      const code = (error as { code?: string }).code ?? "";
      const last = attempt === WRITE_RETRY_DELAYS_MS.length;
      if (!TRANSIENT_WRITE_CODES.has(code) || last) {
        statusWriteStats.failures += 1;
        statusWriteStats.lastError = describeWriteError(error);
        // The previous status.json is untouched, which is the right
        // outcome: slightly stale beats absent.
        try {
          unlinkSync(temp);
        } catch {
          /* the temporary file is the operating system's problem now */
        }
        return next;
      }
      statusWriteStats.retries += 1;
      pause(WRITE_RETRY_DELAYS_MS[attempt]);
    }
  }
  return next;
}

/** Error text with no file contents and no credentials in it. */
function describeWriteError(error: unknown): string {
  const code = (error as { code?: string }).code;
  return code ?? (error instanceof Error ? error.message : String(error));
}
