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
import { dirname, resolve } from "node:path";

import * as dotenv from "dotenv";

dotenv.config();

/**
 * Reported to Central on every heartbeat and shown in the Agent table.
 *
 * Must match the git tag the installer is built from - build.ps1 refuses to
 * build when they disagree, because a fleet that all reports 1.0.0 tells an
 * operator nothing about which machines still need updating.
 */
export const AGENT_VERSION = "1.0.2";

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
  const configured = process.env.AGENT_DATA_DIR?.trim();
  const fallback =
    process.platform === "win32" && process.env.ProgramData
      ? resolve(process.env.ProgramData, "SDCAgent")
      : resolve("./data");
  const dir = configured ? resolve(configured) : fallback;
  mkdirSync(dir, { recursive: true });
  return dir;
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
  heartbeatMinutes: number;
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
export interface AgentStatus {
  phase: "idle" | "starting" | "extracting" | "uploading" | "done" | "error";
  message: string;
  /** rows the current run expects to move, and how far it has got */
  total: number;
  extracted: number;
  uploaded: number;
  pendingChunks: number;
  batchRef: string | null;
  jhcisConnected: boolean | null;
  centralConnected: boolean | null;
  lastSyncAt: string | null;
  lastError: string | null;
  updatedAt: string;
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
