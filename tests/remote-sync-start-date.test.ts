import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AGENT_CAPABILITIES,
  AGENT_VERSION,
  loadCredential,
  loadSettings,
  loadState,
  saveCredential,
  saveSettings,
  saveState,
  settingsPath,
} from "../agent/src/config";
import {
  applyGlobalSyncStartDatePolicy,
  globalSyncStartDateHeartbeatReport,
} from "../agent/src/global-sync-policy";
import { OfflineQueue } from "../agent/src/queue/queue";
import type { AgentConfigResponse, DrugUsageRecord } from "@/lib/shared/canonical";

let home: string;

beforeEach(() => {
  home = mkdtempSync(resolve(tmpdir(), "sdc-remote-floor-"));
  process.env.AGENT_DATA_DIR = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function config(policy?: unknown): AgentConfigResponse {
  return {
    facilityId: "facility-1",
    facilityCode: "05957",
    facilityName: "รพ.สต.ทดสอบ",
    expectedPcucode: "05957",
    syncIntervalMinutes: 60,
    reprocessDays: 7,
    lastSyncedVisitDate: "2025-09-30",
    uploadChunkSize: 500,
    disabled: false,
    syncRequested: false,
    verifyRequested: false,
    ...(policy === undefined ? {} : { globalSyncStartDatePolicy: policy as never }),
  };
}

function policy(desiredDate: string, desiredRevision: number) {
  return {
    schemaVersion: 1 as const,
    desiredDate,
    desiredRevision,
    activeDate: null,
    activeRevision: 0,
  };
}

function record(usageDate: string, drugCode: string): DrugUsageRecord {
  return {
    visitNo: 1,
    drugCode,
    drugName: "ยาทดสอบ",
    drugType: "01",
    quantity: 1,
    unit: "เม็ด",
    unitCode: "027",
    clinic: null,
    usageDate,
  };
}

describe("Agent v1.1.19 managed sync floor", () => {
  it("advertises remote policy support without removing the existing capability", () => {
    expect(AGENT_VERSION).toBe("1.1.19");
    expect(AGENT_CAPABILITIES.syncStartDate).toBe(true);
    expect(AGENT_CAPABILITIES.remoteSyncStartDate).toBe(true);
  });

  it("keeps legacy local settings and sends no acknowledgement when policy is absent", () => {
    saveSettings({ syncStartDate: "2023-10-01" });
    const before = readFileSync(settingsPath(), "utf8");

    expect(applyGlobalSyncStartDatePolicy(config(), new OfflineQueue(home))).toEqual({
      status: "NO_POLICY",
      quarantinedRecords: 0,
    });
    expect(readFileSync(settingsPath(), "utf8")).toBe(before);
    expect(loadSettings().syncStartDate).toBe("2023-10-01");
    expect(globalSyncStartDateHeartbeatReport()).toEqual({});
  });

  it("applies the first valid desired policy atomically and reports its revision", () => {
    saveSettings({ syncStartDate: "2022-10-01" });

    expect(
      applyGlobalSyncStartDatePolicy(config(policy("2024-10-01", 1)), new OfflineQueue(home)),
    ).toEqual({ status: "APPLIED", quarantinedRecords: 0 });

    expect(loadSettings()).toMatchObject({
      syncStartDate: "2024-10-01",
      syncStartDateAuthority: "CENTRAL",
      globalSyncStartDateAppliedRevision: 1,
    });
    expect(globalSyncStartDateHeartbeatReport()).toEqual({
      appliedGlobalSyncStartDateRevision: 1,
    });
    expect(JSON.parse(readFileSync(settingsPath(), "utf8"))).toMatchObject({
      syncStartDate: "2024-10-01",
      globalSyncStartDateAppliedRevision: 1,
    });
    expect(readdirSync(home).filter((name) => name.includes("settings.json.") || name.endsWith(".tmp"))).toEqual([]);
  });

  it("ignores equal and stale revisions without rewriting settings", () => {
    saveSettings({
      syncStartDate: "2024-10-01",
      syncStartDateAuthority: "CENTRAL",
      globalSyncStartDateAppliedRevision: 3,
    });
    const before = readFileSync(settingsPath(), "utf8");
    const queue = new OfflineQueue(home);

    expect(applyGlobalSyncStartDatePolicy(config(policy("2025-10-01", 3)), queue).status).toBe(
      "IGNORED",
    );
    expect(applyGlobalSyncStartDatePolicy(config(policy("2021-10-01", 2)), queue).status).toBe(
      "IGNORED",
    );
    expect(readFileSync(settingsPath(), "utf8")).toBe(before);
  });

  it("rejects malformed policy without changing settings or acknowledgement", () => {
    saveSettings({ syncStartDate: "2023-10-01" });
    const before = readFileSync(settingsPath(), "utf8");

    expect(
      applyGlobalSyncStartDatePolicy(config(policy("2026-02-30", 1)), new OfflineQueue(home)),
    ).toEqual({ status: "INVALID", quarantinedRecords: 0 });
    expect(readFileSync(settingsPath(), "utf8")).toBe(before);
    expect(globalSyncStartDateHeartbeatReport()).toEqual({});
  });

  it("quarantines below-floor pending rows on a forward move without deleting them", () => {
    saveSettings({ syncStartDate: "2022-10-01" });
    const queue = new OfflineQueue(home);
    queue.enqueue({
      batchRef: "SYNC-POLICY",
      sequence: 1,
      pcucode: "05957",
      sourceVersion: null,
      records: [record("2023-01-01", "OLD"), record("2025-01-01", "KEEP")],
    });

    expect(applyGlobalSyncStartDatePolicy(config(policy("2024-10-01", 1)), queue)).toEqual({
      status: "APPLIED",
      quarantinedRecords: 1,
    });
    expect(queue.list("PENDING")[0].records.map((row) => row.drugCode)).toEqual(["KEEP"]);
    expect(queue.quarantinedCount()).toBe(1);
    const parked = readdirSync(join(home, "queue", "quarantined"));
    expect(parked).toHaveLength(1);
    expect(
      JSON.parse(readFileSync(join(home, "queue", "quarantined", parked[0]), "utf8")).records,
    ).toHaveLength(1);
    expect(queue.list("FAILED")).toHaveLength(0);
  });

  it("lowers the extraction floor without reading history, resetting watermark, or rehydrating quarantine", () => {
    saveSettings({
      syncStartDate: "2024-10-01",
      syncStartDateAuthority: "CENTRAL",
      globalSyncStartDateAppliedRevision: 1,
    });
    saveState({
      lastSyncedVisitDate: "2025-09-30",
      lastSyncAt: "2025-10-01T00:00:00.000Z",
      batchSequence: 17,
    });
    const queue = new OfflineQueue(home);
    queue.enqueue({
      batchRef: "SYNC-OLD",
      sequence: 1,
      pcucode: "05957",
      sourceVersion: null,
      records: [record("2023-01-01", "PARK")],
    });
    queue.quarantineBelowFloor(queue.list("PENDING")[0], "2024-10-01");
    const quarantineBefore = readdirSync(join(home, "queue", "quarantined"));
    const stateBefore = loadState();

    expect(applyGlobalSyncStartDatePolicy(config(policy("2022-10-01", 2)), queue)).toEqual({
      status: "APPLIED",
      quarantinedRecords: 0,
    });
    expect(loadSettings().syncStartDate).toBe("2022-10-01");
    expect(loadState()).toEqual(stateBefore);
    expect(queue.list("PENDING")).toHaveLength(0);
    expect(readdirSync(join(home, "queue", "quarantined"))).toEqual(quarantineBefore);
  });

  it("keeps v1.1.16 settings readable and preserves identity and enrollment files", () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        autoSyncEnabled: true,
        syncIntervalMinutes: 60,
        dailyTimes: ["08:00"],
        heartbeatMinutes: 5,
        heartbeatSeconds: 30,
        startWithWindows: true,
        minimiseToTray: true,
        syncStartDate: "2023-10-01",
      }),
      "utf8",
    );
    saveCredential({
      agentId: "agent-identity",
      keyId: "key-identity",
      secret: "test-secret-not-production",
      centralApiUrl: "https://central.example.test",
      facilityId: "facility-1",
      facilityCode: "05957",
      facilityName: "รพ.สต.ทดสอบ",
      expectedPcucode: "05957",
      installationId: "installation-identity",
      syncIntervalMinutes: 60,
      reprocessDays: 7,
      enrolledAt: "2025-01-01T00:00:00.000Z",
    });
    const credentialBefore = loadCredential();

    expect(loadSettings().syncStartDate).toBe("2023-10-01");
    applyGlobalSyncStartDatePolicy(config(policy("2024-10-01", 1)), new OfflineQueue(home));

    expect(loadCredential()).toEqual(credentialBefore);
    expect(existsSync(join(home, "agent.config.json"))).toBe(true);
    expect(loadSettings()).toMatchObject({
      dailyTimes: ["08:00"],
      syncStartDate: "2024-10-01",
      syncStartDateAuthority: "CENTRAL",
    });
  });
});
