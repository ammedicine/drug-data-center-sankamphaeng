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
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { hostname, userInfo } from "node:os";
import { dirname, isAbsolute, relative as relativePath, resolve, sep } from "node:path";

import {
  HEARTBEAT_INTERVAL_SECONDS,
  type CentralLinkState,
  type JhcisLinkState,
  type SyncPhase,
} from "@shared/agent-status";

import * as dotenv from "dotenv";

dotenv.config();

/**
 * Reported to Central on every heartbeat and shown in the Agent table.
 *
 * Must match the git tag the installer is built from - build.ps1 refuses to
 * build when they disagree, because a fleet that all reports 1.0.0 tells an
 * operator nothing about which machines still need updating.
 */
export const AGENT_VERSION = "1.0.3";

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
}

export const DEFAULT_SETTINGS: AgentSettings = {
  autoSyncEnabled: true,
  syncIntervalMinutes: 60,
  dailyTimes: [],
  heartbeatMinutes: 5,
  heartbeatSeconds: HEARTBEAT_INTERVAL_SECONDS,
  startWithWindows: true,
  minimiseToTray: true,
};

export function settingsPath(): string {
  return resolve(dataDir(), "settings.json");
}

export function loadSettings(): AgentSettings {
  const path = settingsPath();
  if (!existsSync(path)) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AgentSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
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
  };
  if (!existsSync(path)) return empty;
  try {
    return { ...empty, ...(JSON.parse(readFileSync(path, "utf8")) as Partial<AgentStatus>) };
  } catch {
    return empty;
  }
}

export function writeStatus(patch: Partial<AgentStatus>): AgentStatus {
  const next: AgentStatus = { ...loadStatus(), ...patch, updatedAt: new Date().toISOString() };
  const target = statusPath();
  const temp = `${target}.tmp`;
  writeFileSync(temp, JSON.stringify(next, null, 2), "utf8");
  renameSync(temp, target);
  return next;
}
