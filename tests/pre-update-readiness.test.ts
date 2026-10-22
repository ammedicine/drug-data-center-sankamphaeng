import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acquirePreparationLock,
  prepareUpdateReadiness,
  type ComponentManifest,
  type ReadinessInput,
} from "../agent/src/update-readiness";

const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => Buffer.from(JSON.stringify(value));

let root: string;
let installRoot: string;
let dataRoot: string;
let stageRoot: string;
let installer: string;

const liveFiles: Record<string, Buffer> = {
  "SDCAgent.exe": Buffer.from("gui-current"),
  "app/agent.js": Buffer.from("agent-current"),
  "runtime/node.exe": Buffer.from("node-current"),
  "run-installer.mjs": Buffer.from("helper-current"),
};
const targetFiles: Record<string, Buffer> = {
  "SDCAgent.exe": Buffer.from("gui-target"),
  "app/agent.js": Buffer.from("agent-target"),
  "runtime/node.exe": Buffer.from("node-target"),
  "run-installer.mjs": Buffer.from("helper-target"),
};

function manifest(version: string, files: Record<string, Buffer>): ComponentManifest {
  return {
    schemaVersion: 1,
    version,
    files: Object.entries(files).map(([path, bytes]) => ({
      path,
      role: path.includes("node") ? "runtime" : path.includes("installer") ? "handoff" : "program",
      assetName: `SDCAgent-Component-${version}-${path.replace(/[\\/]/g, "-")}`,
      size: bytes.length,
      sha256: sha(bytes),
    })),
  };
}

const currentManifest = manifest("1.1.18", liveFiles);
const targetManifest = manifest("1.1.19", targetFiles);
const currentBytes = json(currentManifest);
const targetBytes = json(targetManifest);

function put(path: string, bytes: Buffer | string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function base(overrides: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    command: {
      commandId: "cmd-1",
      agentId: "agent-a",
      targetVersion: "1.1.19",
      assetName: "SDCAgent-Setup-1.1.19.exe",
      size: 9,
      sha256: sha("installer"),
      manifestAssetName: "SDCAgent-Manifest-1.1.19.json",
      manifestSha256: sha(targetBytes),
    },
    authenticatedAgentId: "agent-a",
    currentVersion: "1.1.18",
    installRoot,
    dataRoot,
    stageRoot,
    installerPath: installer,
    freeBytes: 1024 * 1024 * 1024,
    syncBusy: () => false,
    handoffActive: false,
    fetchManifest: async (version) => version === "1.1.18"
      ? { assetName: "SDCAgent-Manifest-1.1.18.json", sha256: sha(currentBytes), bytes: currentBytes }
      : { assetName: "SDCAgent-Manifest-1.1.19.json", sha256: sha(targetBytes), bytes: targetBytes },
    fetchComponent: async (assetName) => {
      const entry = targetManifest.files.find((file) => file.assetName === assetName)!;
      return targetFiles[entry.path];
    },
    ...overrides,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sdc-ready-"));
  installRoot = join(root, "app");
  dataRoot = join(root, "data");
  stageRoot = join(dataRoot, "updates", "1.1.19", "components");
  for (const [path, bytes] of Object.entries(liveFiles)) put(join(installRoot, path), bytes);
  put(join(dataRoot, "agent.config.json"), JSON.stringify({ agentId: "agent-a", keyId: "key", secret: "x".repeat(40), facilityId: "f", facilityCode: "05957", expectedPcucode: "05957", installationId: "install-a" }));
  put(join(dataRoot, "state.json"), JSON.stringify({ lastSyncedVisitDate: "2026-10-01", batchSequence: 2, syncControlState: "PAUSED" }));
  put(join(dataRoot, "settings.json"), "{}");
  installer = join(root, "SDCAgent-Setup-1.1.19.exe");
  put(installer, "installer");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("v1.1.19 pre-update readiness", () => {
  it("1 all files valid becomes READY", async () => {
    expect(await prepareUpdateReadiness(base())).toMatchObject({ readiness: "READY", programFiles: "PASS", statePreservation: "PASS", environment: "PASS", targetPackage: "PASS" });
  });
  it("2 missing immutable file is staged from the verified target manifest", async () => {
    rmSync(join(installRoot, "app/agent.js"));
    const result = await prepareUpdateReadiness(base());
    expect(result).toMatchObject({ readiness: "READY", programFiles: "REPAIRED", missingFiles: 1, repairedFiles: 1 });
    expect(readFileSync(join(stageRoot, "app/agent.js"))).toEqual(targetFiles["app/agent.js"]);
  });
  it("3 corrupt immutable file is staged and live bytes remain untouched", async () => {
    put(join(installRoot, "runtime/node.exe"), "corrupt");
    const result = await prepareUpdateReadiness(base());
    expect(result).toMatchObject({ readiness: "READY", corruptedFiles: 1, repairedFiles: 1 });
    expect(readFileSync(join(installRoot, "runtime/node.exe"), "utf8")).toBe("corrupt");
  });
  it("4 component hash mismatch is terminal and BLOCKED", async () => {
    rmSync(join(installRoot, "SDCAgent.exe"));
    const result = await prepareUpdateReadiness(base({ fetchComponent: async () => Buffer.from("tampered") }));
    expect(result).toMatchObject({ readiness: "BLOCKED", terminal: true, errorCode: "COMPONENT_MISMATCH" });
  });
  it("5 unavailable repair source is retryable and BLOCKED", async () => {
    rmSync(join(installRoot, "SDCAgent.exe"));
    const result = await prepareUpdateReadiness(base({ fetchComponent: async () => { throw new Error("503"); } }));
    expect(result).toMatchObject({ readiness: "BLOCKED", terminal: false, errorCode: "REPAIR_SOURCE_UNAVAILABLE" });
  });
  it("6 unreadable mutable settings blocks without replacing it", async () => {
    put(join(dataRoot, "settings.json"), "{");
    const before = readFileSync(join(dataRoot, "settings.json"));
    const result = await prepareUpdateReadiness(base());
    expect(result).toMatchObject({ readiness: "BLOCKED", terminal: true, statePreservation: "FAIL" });
    expect(readFileSync(join(dataRoot, "settings.json"))).toEqual(before);
  });
  it("7 pending queue is byte-preserved", async () => {
    const file = join(dataRoot, "queue/pending/b__1.json"); put(file, "queue-byte-data"); const before = readFileSync(file);
    expect((await prepareUpdateReadiness(base())).readiness).toBe("READY");
    expect(readFileSync(file)).toEqual(before);
  });
  it("8 quarantine is byte-preserved", async () => {
    const file = join(dataRoot, "queue/quarantined/q.json"); put(file, "quarantine-byte-data"); const before = readFileSync(file);
    await prepareUpdateReadiness(base()); expect(readFileSync(file)).toEqual(before);
  });
  it("9 recovery state is byte-preserved", async () => {
    const file = join(dataRoot, "queue/normal-sync-recovery.json"); put(file, JSON.stringify({ evidence: "legacy" })); const before = readFileSync(file);
    await prepareUpdateReadiness(base()); expect(readFileSync(file)).toEqual(before);
  });
  it("10 identity and enrollment are semantically preserved", async () => {
    const before = readFileSync(join(dataRoot, "agent.config.json")); await prepareUpdateReadiness(base());
    expect(readFileSync(join(dataRoot, "agent.config.json"))).toEqual(before);
  });
  it("11 insufficient disk remains non-terminal BLOCKED", async () => {
    expect(await prepareUpdateReadiness(base({ freeBytes: 1 }))).toMatchObject({ readiness: "BLOCKED", terminal: false, errorCode: "INSUFFICIENT_DISK" });
  });
  it("12 staging IO contention remains retryable BLOCKED", async () => {
    put(stageRoot, "not-a-directory");
    expect(await prepareUpdateReadiness(base())).toMatchObject({ readiness: "BLOCKED", terminal: false, errorCode: "STAGING_UNAVAILABLE" });
  });
  it("13 concurrent updater remains retryable BLOCKED", async () => {
    expect(await prepareUpdateReadiness(base({ handoffActive: true }))).toMatchObject({ readiness: "BLOCKED", terminal: false, errorCode: "PREPARATION_LOCKED" });
  });
  it("14 target installer hash mismatch is terminal BLOCKED", async () => {
    put(installer, "wrong");
    expect(await prepareUpdateReadiness(base())).toMatchObject({ readiness: "BLOCKED", terminal: true, errorCode: "TARGET_PACKAGE_MISMATCH" });
  });
  it("15 exact authorization plus READY permits handoff", async () => {
    expect((await prepareUpdateReadiness(base())).installAllowed).toBe(true);
  });
  it("16 BLOCKED never permits handoff", async () => {
    expect((await prepareUpdateReadiness(base({ authenticatedAgentId: "other" }))).installAllowed).toBe(false);
  });
  it("17 an absent exact command cannot authorize installation", async () => {
    expect(await prepareUpdateReadiness(base({ command: null }))).toMatchObject({ readiness: "BLOCKED", terminal: true, installAllowed: false });
  });
  it("18 restart cannot reuse a command whose manifest authorization changed", async () => {
    expect(await prepareUpdateReadiness(base({ command: { ...base().command!, manifestSha256: "0".repeat(64) } }))).toMatchObject({ readiness: "BLOCKED", errorCode: "MANIFEST_MISMATCH" });
  });
  it("19 failed preparation leaves every live program byte unchanged", async () => {
    put(join(installRoot, "app/agent.js"), "corrupt"); const before = readFileSync(join(installRoot, "app/agent.js"));
    await prepareUpdateReadiness(base({ fetchComponent: async () => Buffer.from("bad") }));
    expect(readFileSync(join(installRoot, "app/agent.js"))).toEqual(before);
  });
  it("20 seven For-dev legacy queue files remain byte-for-byte unchanged", async () => {
    const files = Array.from({ length: 7 }, (_, i) => join(dataRoot, "queue/pending", `SYNC-20261021-000001__${i + 1}.json`));
    files.forEach((file, i) => put(file, Buffer.from(`legacy-${i}\u0000payload`))); const before = files.map((file) => readFileSync(file));
    expect((await prepareUpdateReadiness(base())).readiness).toBe("READY");
    expect(files.map((file) => readFileSync(file))).toEqual(before);
  });
  it("runtime-only state changes do not fail semantic validation", async () => {
    const input = base({ beforeFinalStateCheck: () => put(join(dataRoot, "state.json"), JSON.stringify({ lastSyncedVisitDate: "2026-10-01", batchSequence: 2, syncControlState: "PAUSED", lastSyncAt: new Date().toISOString() })) });
    expect((await prepareUpdateReadiness(input)).readiness).toBe("READY");
  });
  it("payload changes during preparation invalidate stale readiness evidence", async () => {
    const file = join(dataRoot, "queue/pending/chunk.json"); put(file, "before");
    const result = await prepareUpdateReadiness(base({ beforeFinalStateCheck: () => put(file, "after") }));
    expect(result).toMatchObject({ readiness: "BLOCKED", terminal: false, errorCode: "PAYLOAD_STATE_CHANGED" });
  });
  it("active sync remains retryable and does not broaden authorization", async () => {
    expect(await prepareUpdateReadiness(base({ syncBusy: () => true }))).toMatchObject({ readiness: "BLOCKED", terminal: false, errorCode: "SYNC_BUSY" });
  });
  it("an exclusive preparation lock blocks a concurrent updater and releases cleanly", () => {
    const locks = join(root, "locks");
    const first = acquirePreparationLock(locks, "cmd-1");
    expect(first).not.toBeNull();
    expect(acquirePreparationLock(locks, "cmd-2")).toBeNull();
    first!.release();
    const next = acquirePreparationLock(locks, "cmd-2");
    expect(next).not.toBeNull();
    next!.release();
  });
  it("a malformed lock is fail-closed and is never guessed stale", () => {
    const locks = join(root, "locks"); mkdirSync(locks, { recursive: true });
    const file = join(locks, "update-preparation.lock"); put(file, "not-json");
    expect(acquirePreparationLock(locks, "cmd-2")).toBeNull();
    expect(readFileSync(file, "utf8")).toBe("not-json");
  });
  it("a lock without a verifiable process identity is not removed", () => {
    const locks = join(root, "locks"); mkdirSync(locks, { recursive: true });
    const file = join(locks, "update-preparation.lock"); put(file, JSON.stringify({ commandId: "unknown" }));
    expect(acquirePreparationLock(locks, "cmd-2")).toBeNull();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ commandId: "unknown" });
  });
});
