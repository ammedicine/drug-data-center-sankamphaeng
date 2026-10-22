import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  closeSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";

export interface ComponentManifestEntry {
  path: string;
  role: "program" | "runtime" | "handoff";
  assetName: string;
  size: number;
  sha256: string;
}

export interface ComponentManifest {
  schemaVersion: 1;
  version: string;
  files: ComponentManifestEntry[];
}

export interface ManifestEnvelope {
  assetName: string;
  sha256: string;
  bytes: Buffer;
}

export interface ReadinessCommand {
  commandId: string;
  agentId: string;
  targetVersion: string;
  assetName: string;
  size: number | null;
  sha256: string;
  manifestAssetName: string;
  manifestSha256: string;
}

export interface ReadinessInput {
  command: ReadinessCommand | null;
  authenticatedAgentId: string;
  currentVersion: string;
  installRoot: string;
  dataRoot: string;
  stageRoot: string;
  installerPath: string;
  freeBytes: number;
  syncBusy: () => boolean;
  handoffActive: boolean;
  fetchManifest: (version: string) => Promise<ManifestEnvelope>;
  fetchComponent: (assetName: string) => Promise<Buffer>;
  /** Test/production seam immediately before the final state and payload re-read. */
  beforeFinalStateCheck?: () => void | Promise<void>;
}

export type ReadinessErrorCode =
  | "AUTHORIZATION_MISMATCH"
  | "MANIFEST_MISMATCH"
  | "COMPONENT_MISMATCH"
  | "REPAIR_SOURCE_UNAVAILABLE"
  | "STATE_INVALID"
  | "INSUFFICIENT_DISK"
  | "STAGING_UNAVAILABLE"
  | "PREPARATION_LOCKED"
  | "TARGET_PACKAGE_MISMATCH"
  | "PAYLOAD_STATE_CHANGED"
  | "SYNC_BUSY";

export interface UpdateReadinessResult {
  readiness: "READY" | "BLOCKED";
  programFiles: "PASS" | "REPAIRED" | "FAIL";
  missingFiles: number;
  corruptedFiles: number;
  unreadableFiles: number;
  repairedFiles: number;
  statePreservation: "PASS" | "FAIL";
  environment: "PASS" | "FAIL";
  targetPackage: "PASS" | "FAIL";
  blockers: string[];
  terminal: boolean;
  errorCode: ReadinessErrorCode | null;
  installAllowed: boolean;
  stagedFiles: Record<string, string>;
}

export interface PreparationLock { path: string; release: () => void }

/** Exclusive updater preparation lock. A stale file is removed only when its process is absent. */
export function acquirePreparationLock(root: string, commandId: string): PreparationLock | null {
  mkdirSync(root, { recursive: true });
  const path = join(root, "update-preparation.lock");
  const create = () => {
    const fd = openSync(path, "wx");
    writeFileSync(fd, JSON.stringify({ pid: process.pid, host: process.env.COMPUTERNAME ?? null, commandId, createdAt: new Date().toISOString() }));
    closeSync(fd);
  };
  try {
    create();
  } catch {
    try {
      const held = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
      if (!Number.isInteger(held.pid) || Number(held.pid) <= 0) return null;
      try {
        process.kill(Number(held.pid), 0);
        return null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return null;
      }
      rmSync(path, { force: true });
      create();
    } catch {
      return null;
    }
  }
  let released = false;
  return { path, release: () => { if (!released) { released = true; rmSync(path, { force: true }); } } };
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const blocked = (
  code: ReadinessErrorCode,
  detail: string,
  terminal: boolean,
  partial: Partial<UpdateReadinessResult> = {},
): UpdateReadinessResult => ({
  readiness: "BLOCKED",
  programFiles: "FAIL",
  missingFiles: 0,
  corruptedFiles: 0,
  unreadableFiles: 0,
  repairedFiles: 0,
  statePreservation: "PASS",
  environment: "PASS",
  targetPackage: "FAIL",
  blockers: [detail],
  terminal,
  errorCode: code,
  installAllowed: false,
  stagedFiles: {},
  ...partial,
});

function safeRelativePath(path: string): boolean {
  const cleaned = normalize(path);
  return Boolean(path) && !isAbsolute(path) && !path.includes(":") && cleaned !== ".." && !cleaned.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}

function parseManifest(envelope: ManifestEnvelope, expected: { version: string; assetName?: string; sha256: string }): ComponentManifest {
  if (envelope.sha256.toLowerCase() !== expected.sha256.toLowerCase() || sha256(envelope.bytes) !== expected.sha256.toLowerCase()) {
    throw new Error("MANIFEST_MISMATCH");
  }
  if (expected.assetName && envelope.assetName !== expected.assetName) throw new Error("MANIFEST_MISMATCH");
  const parsed = JSON.parse(envelope.bytes.toString("utf8")) as ComponentManifest;
  if (parsed.schemaVersion !== 1 || parsed.version !== expected.version || !Array.isArray(parsed.files) || parsed.files.length === 0) {
    throw new Error("MANIFEST_MISMATCH");
  }
  const seen = new Set<string>();
  for (const file of parsed.files) {
    if (
      !safeRelativePath(file.path) || seen.has(file.path.toLowerCase()) ||
      !["program", "runtime", "handoff"].includes(file.role) ||
      !/^SDCAgent-Component-[A-Za-z0-9._-]+$/.test(file.assetName) ||
      !Number.isSafeInteger(file.size) || file.size < 0 || !/^[0-9a-f]{64}$/.test(file.sha256)
    ) throw new Error("MANIFEST_MISMATCH");
    seen.add(file.path.toLowerCase());
  }
  return parsed;
}

function parseJson(path: string, required: boolean): Record<string, unknown> | null {
  if (!existsSync(path)) {
    if (required) throw new Error(`missing ${path}`);
    return null;
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`invalid ${path}`);
  return parsed as Record<string, unknown>;
}

function validateMutableState(dataRoot: string, expectedAgentId: string): string {
  const identity = parseJson(join(dataRoot, "agent.config.json"), true)!;
  for (const key of ["agentId", "keyId", "secret", "facilityId", "installationId"]) {
    if (typeof identity[key] !== "string" || !(identity[key] as string).trim()) throw new Error(`identity ${key}`);
  }
  if (identity.agentId !== expectedAgentId) throw new Error("identity agentId");
  const state = parseJson(join(dataRoot, "state.json"), true)!;
  if (!Number.isInteger(state.batchSequence) || Number(state.batchSequence) < 0) throw new Error("state batchSequence");
  if (state.lastSyncedVisitDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(state.lastSyncedVisitDate))) throw new Error("state watermark");
  if (state.syncControlState != null && state.syncControlState !== "RUNNING" && state.syncControlState !== "PAUSED") throw new Error("state control");
  for (const name of ["settings.json", "jhcis.json", "historical-backfill.json"]) parseJson(join(dataRoot, name), false);
  const recovery = join(dataRoot, "queue", "normal-sync-recovery.json");
  if (existsSync(recovery)) parseJson(recovery, true);
  return JSON.stringify({
    agentId: identity.agentId, keyId: identity.keyId, secret: identity.secret,
    facilityId: identity.facilityId, facilityCode: identity.facilityCode ?? null,
    expectedPcucode: identity.expectedPcucode ?? null, installationId: identity.installationId,
  });
}

function filesUnder(path: string): string[] {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => filesUnder(join(path, entry.name)));
}

function payloadFingerprint(dataRoot: string): string {
  const queue = join(dataRoot, "queue");
  const targets = ["pending", "failed", "quarantined", "receipts"].flatMap((name) => filesUnder(join(queue, name)));
  for (const path of [join(queue, "normal-sync-recovery.json"), join(dataRoot, "historical-backfill.json")]) if (existsSync(path)) targets.push(path);
  const digest = createHash("sha256");
  for (const path of targets.sort()) {
    digest.update(relative(dataRoot, path).replace(/\\/g, "/"));
    digest.update(readFileSync(path));
  }
  return digest.digest("hex");
}

function installerMatches(input: ReadinessInput): boolean {
  if (!input.command || !existsSync(input.installerPath)) return false;
  const bytes = readFileSync(input.installerPath);
  return (input.command.size == null || input.command.size === bytes.length) && sha256(bytes) === input.command.sha256.toLowerCase();
}

/**
 * Verifies and stages everything an exact authenticated update command needs.
 * It never writes under the live install root or to machine-specific state.
 */
export async function prepareUpdateReadiness(input: ReadinessInput): Promise<UpdateReadinessResult> {
  const command = input.command;
  if (!command || command.agentId !== input.authenticatedAgentId || !command.commandId) {
    return blocked("AUTHORIZATION_MISMATCH", "exact authenticated update command required", true);
  }
  if (input.handoffActive) return blocked("PREPARATION_LOCKED", "another update handoff is active", false, { environment: "FAIL" });
  if (input.syncBusy()) return blocked("SYNC_BUSY", "sync or recovery activity is not idle", false, { environment: "FAIL" });

  let current: ComponentManifest;
  let target: ComponentManifest;
  try {
    const currentEnvelope = await input.fetchManifest(input.currentVersion);
    current = parseManifest(currentEnvelope, { version: input.currentVersion, sha256: currentEnvelope.sha256 });
    const targetEnvelope = await input.fetchManifest(command.targetVersion);
    target = parseManifest(targetEnvelope, { version: command.targetVersion, assetName: command.manifestAssetName, sha256: command.manifestSha256 });
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && error.message === "MANIFEST_MISMATCH")) {
      return blocked("MANIFEST_MISMATCH", "release manifest does not match exact authorization", true);
    }
    return blocked("REPAIR_SOURCE_UNAVAILABLE", "trusted release manifest is temporarily unavailable", false);
  }

  let identityInvariant: string;
  try {
    identityInvariant = validateMutableState(input.dataRoot, input.authenticatedAgentId);
  } catch {
    return blocked("STATE_INVALID", "identity or mutable state is missing/malformed", true, { statePreservation: "FAIL" });
  }
  const payloadBefore = payloadFingerprint(input.dataRoot);

  let missingFiles = 0;
  let corruptedFiles = 0;
  let unreadableFiles = 0;
  const repair: ComponentManifestEntry[] = [];
  for (const expected of current.files) {
    const path = join(input.installRoot, expected.path);
    try {
      if (!existsSync(path)) {
        missingFiles++;
        repair.push(expected);
        continue;
      }
      const bytes = readFileSync(path);
      if (bytes.length !== expected.size || sha256(bytes) !== expected.sha256) {
        corruptedFiles++;
        repair.push(expected);
      }
    } catch {
      unreadableFiles++;
      repair.push(expected);
    }
  }

  const targetByPath = new Map(target.files.map((file) => [file.path, file]));
  const repairBytes = repair.reduce((sum, file) => sum + (targetByPath.get(file.path)?.size ?? 0), 0);
  const requiredFree = Math.max(64 * 1024 * 1024, (command.size ?? 0) + repairBytes);
  if (input.freeBytes < requiredFree) {
    return blocked("INSUFFICIENT_DISK", `free disk ${input.freeBytes} below required ${requiredFree}`, false, {
      environment: "FAIL", missingFiles, corruptedFiles, unreadableFiles,
    });
  }

  const stagedFiles: Record<string, string> = {};
  try {
    mkdirSync(input.stageRoot, { recursive: true });
    const probe = join(input.stageRoot, `.probe-${process.pid}`);
    writeFileSync(probe, "ready", { flag: "wx" });
    rmSync(probe, { force: true });
  } catch {
    return blocked("STAGING_UNAVAILABLE", "staging directory is temporarily unavailable", false, {
      environment: "FAIL", missingFiles, corruptedFiles, unreadableFiles,
    });
  }

  for (const currentEntry of repair) {
    const approved = targetByPath.get(currentEntry.path);
    if (!approved) return blocked("COMPONENT_MISMATCH", `target manifest does not authorize ${currentEntry.path}`, true, { missingFiles, corruptedFiles, unreadableFiles });
    let bytes: Buffer;
    try {
      bytes = await input.fetchComponent(approved.assetName);
    } catch {
      return blocked("REPAIR_SOURCE_UNAVAILABLE", `component ${approved.role} temporarily unavailable`, false, { missingFiles, corruptedFiles, unreadableFiles });
    }
    if (bytes.length !== approved.size || sha256(bytes) !== approved.sha256) {
      return blocked("COMPONENT_MISMATCH", `component ${approved.role} failed trusted size/SHA-256 validation`, true, { missingFiles, corruptedFiles, unreadableFiles });
    }
    const staged = join(input.stageRoot, approved.path);
    const partial = `${staged}.part`;
    try {
      mkdirSync(dirname(staged), { recursive: true });
      if (existsSync(staged)) {
        const existing = readFileSync(staged);
        if (existing.length === approved.size && sha256(existing) === approved.sha256) {
          stagedFiles[approved.path] = staged;
          continue;
        }
        rmSync(staged, { force: true });
      }
      rmSync(partial, { force: true });
      writeFileSync(partial, bytes, { flag: "wx" });
      if (sha256(readFileSync(partial)) !== approved.sha256) throw new Error("staged mismatch");
      renameSync(partial, staged);
      stagedFiles[approved.path] = staged;
    } catch {
      rmSync(partial, { force: true });
      return blocked("STAGING_UNAVAILABLE", `could not atomically stage ${approved.role}`, false, { environment: "FAIL", missingFiles, corruptedFiles, unreadableFiles });
    }
  }

  if (!installerMatches(input)) {
    return blocked("TARGET_PACKAGE_MISMATCH", "authorized target installer failed exact size/SHA-256 validation", true, {
      missingFiles, corruptedFiles, unreadableFiles, repairedFiles: Object.keys(stagedFiles).length, stagedFiles,
    });
  }

  await input.beforeFinalStateCheck?.();
  for (const expected of current.files) {
    const staged = stagedFiles[expected.path];
    const finalExpected = staged ? targetByPath.get(expected.path)! : expected;
    const path = staged ?? join(input.installRoot, expected.path);
    try {
      const bytes = readFileSync(path);
      if (bytes.length !== finalExpected.size || sha256(bytes) !== finalExpected.sha256) {
        return blocked("COMPONENT_MISMATCH", `final ${finalExpected.role} integrity recheck failed`, true, {
          missingFiles, corruptedFiles, unreadableFiles, repairedFiles: Object.keys(stagedFiles).length, stagedFiles,
        });
      }
    } catch {
      return blocked("COMPONENT_MISMATCH", `final ${finalExpected.role} readability recheck failed`, true, {
        missingFiles, corruptedFiles, unreadableFiles, repairedFiles: Object.keys(stagedFiles).length, stagedFiles,
      });
    }
  }
  try {
    const latestIdentity = validateMutableState(input.dataRoot, input.authenticatedAgentId);
    if (latestIdentity !== identityInvariant) throw new Error("identity changed");
  } catch {
    return blocked("STATE_INVALID", "latest mutable state is missing/malformed before handoff", true, { statePreservation: "FAIL", stagedFiles });
  }
  if (input.syncBusy() || payloadFingerprint(input.dataRoot) !== payloadBefore) {
    return blocked("PAYLOAD_STATE_CHANGED", "queue/recovery evidence changed; readiness must restart after sync is idle", false, { environment: "FAIL", stagedFiles });
  }

  return {
    readiness: "READY",
    programFiles: repair.length ? "REPAIRED" : "PASS",
    missingFiles,
    corruptedFiles,
    unreadableFiles,
    repairedFiles: repair.length,
    statePreservation: "PASS",
    environment: "PASS",
    targetPackage: "PASS",
    blockers: [],
    terminal: false,
    errorCode: null,
    installAllowed: true,
    stagedFiles,
  };
}
