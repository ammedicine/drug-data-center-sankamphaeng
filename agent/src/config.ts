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
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";

import * as dotenv from "dotenv";

dotenv.config();

export const AGENT_VERSION = "1.0.0";

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

export function dataDir(): string {
  const dir = resolve(process.env.AGENT_DATA_DIR ?? "./data");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function configPath(): string {
  return resolve(dataDir(), "..", "agent.config.json");
}

export function statePath(): string {
  return resolve(dataDir(), "state.json");
}

export function jhcisConfig(): JhcisConfig {
  const password = process.env.JHCIS_DB_PASSWORD;
  const user = process.env.JHCIS_DB_USER;
  if (!user) {
    throw new Error("JHCIS_DB_USER is not set. Copy agent/.env.example to agent/.env first.");
  }
  return {
    host: process.env.JHCIS_DB_HOST ?? "localhost",
    port: Number(process.env.JHCIS_DB_PORT ?? 3306),
    database: process.env.JHCIS_DB_DATABASE ?? "jhcisdb",
    user,
    password: password ?? "",
  };
}

export function centralApiUrl(): string {
  const url = process.env.CENTRAL_API_URL ?? loadCredential()?.centralApiUrl;
  if (!url) throw new Error("CENTRAL_API_URL is not set and the agent is not enrolled yet.");
  return url.replace(/\/+$/, "");
}

export function loadCredential(): AgentCredentialFile | null {
  const path = configPath();
  if (!existsSync(path)) return null;
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
    // Windows ignores POSIX modes; ACLs are handled by the installer instead.
  }
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
