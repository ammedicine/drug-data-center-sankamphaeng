/**
 * An operator's own date range is run as asked, or not at all.
 *
 * The alternative was silently raising the start date to the สถานบริการ's
 * configured floor, which reads as helpful and is not: somebody asking to
 * backfill from 2019 at a clinic collecting from October 2022 would be told
 * the run succeeded, having never touched the three years they asked for, and
 * nothing anywhere would say so.
 *
 * Refusing costs them one message and a setting to change. Narrowing costs
 * them the belief that data exists.
 *
 * What these tests actually pin down is that a refusal is inert: no JHCIS
 * connection, no batch, no watermark movement, nothing queued. A refusal that
 * left a trace would be worse than the clamp it replaced.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MANUAL_RANGE_BEFORE_FLOOR_CODE,
  checkManualRange,
  manualRangeRefusalMessage,
} from "@/lib/shared/sync-control";

let home: string;
let counter = 0;

beforeEach(() => {
  home = mkdtempSync(resolve(tmpdir(), "sdc-floor-"));
  process.env.AGENT_DATA_DIR = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENT_DATA_DIR;
});

const syncModule = () => import(`../agent/src/sync?f=${counter++}`);
const configModule = () => import(`../agent/src/config?f=${counter++}`);

/** Settings with a floor, as the Tray writes them. */
function withFloor(floor: string) {
  writeFileSync(
    join(home, "settings.json"),
    JSON.stringify({ autoSyncEnabled: true, syncStartDate: floor }),
    "utf8",
  );
}

const credential = {
  agentId: "a",
  keyId: "k",
  secret: "s".repeat(40),
  centralApiUrl: "https://central.invalid/",
  facilityId: "f",
  expectedPcucode: "T0001",
  installationId: "i",
  syncIntervalMinutes: 60,
  reprocessDays: 7,
} as never;

describe("the four cases", () => {
  it("allows a range that starts exactly on the floor", async () => {
    withFloor("2022-10-01");
    const { resolveRange } = await syncModule();
    await expect(
      resolveRange("MANUAL_RANGE", credential, async () => ({ min: null, max: null }), {
        from: "2022-10-01",
        to: "2023-09-30",
      }),
    ).resolves.toEqual({ from: "2022-10-01", to: "2023-09-30" });
  });

  it("allows a range that starts after the floor", async () => {
    withFloor("2022-10-01");
    const { resolveRange } = await syncModule();
    await expect(
      resolveRange("MANUAL_RANGE", credential, async () => ({ min: null, max: null }), {
        from: "2024-01-01",
        to: "2024-01-31",
      }),
    ).resolves.toEqual({ from: "2024-01-01", to: "2024-01-31" });
  });

  it("refuses when the start is before the floor but the end is after", async () => {
    // The tempting case: part of what was asked for is collectable. Running
    // that part is the silent narrowing under another name.
    withFloor("2022-10-01");
    const { resolveRange, ManualRangeRefusedError } = await syncModule();
    await expect(
      resolveRange("MANUAL_RANGE", credential, async () => ({ min: null, max: null }), {
        from: "2019-01-01",
        to: "2024-01-01",
      }),
    ).rejects.toThrow(ManualRangeRefusedError);
  });

  it("refuses when the whole range is before the floor", async () => {
    withFloor("2022-10-01");
    const { resolveRange, ManualRangeRefusedError } = await syncModule();
    await expect(
      resolveRange("MANUAL_RANGE", credential, async () => ({ min: null, max: null }), {
        from: "2019-01-01",
        to: "2019-12-31",
      }),
    ).rejects.toThrow(ManualRangeRefusedError);
  });
});

describe("a refusal leaves nothing behind", () => {
  it("opens no JHCIS connection and moves nothing", async () => {
    withFloor("2022-10-01");
    const { SyncRunner } = await syncModule();
    const { loadState, loadStatus, saveState } = await configModule();

    writeFileSync(join(home, "agent.config.json"), JSON.stringify(credential), "utf8");
    saveState({ lastSyncedVisitDate: "2024-06-30", lastSyncAt: null, batchSequence: 7 });
    const before = loadState();

    // JHCIS is pointed at a port nothing is listening on. If the code under
    // test touched it at all, this test would hang or fail with a connection
    // error rather than the refusal - which is exactly the distinction being
    // proven. Same for Central: the URL does not resolve.
    process.env.JHCIS_HOST = "127.0.0.1";
    process.env.JHCIS_PORT = "1";

    const runner = new SyncRunner();
    let error: unknown;
    try {
      await runner.run({ mode: "MANUAL_RANGE", from: "2019-01-01", to: "2024-01-01" });
    } catch (caught) {
      error = caught;
    }

    // Refused, and it says both dates without being asked to guess either.
    expect((error as { code?: string })?.code).toBe(MANUAL_RANGE_BEFORE_FLOOR_CODE);
    expect((error as { requestedFromDate?: string })?.requestedFromDate).toBe("2019-01-01");
    expect((error as { configuredSyncStartDate?: string })?.configuredSyncStartDate).toBe(
      "2022-10-01",
    );

    // Nothing moved. The watermark is the number that decides what may be
    // skipped in future, and a refused request must not have touched it.
    const after = loadState();
    expect(after.lastSyncedVisitDate).toBe(before.lastSyncedVisitDate);
    expect(after.batchSequence).toBe(before.batchSequence);

    // Nothing was queued, and no batch reference was minted.
    const pending = join(home, "queue", "pending");
    const queued = existsSync(pending) ? readdirSync(pending) : [];
    expect(queued).toEqual([]);
    const failed = join(home, "queue", "failed");
    expect(existsSync(failed) ? readdirSync(failed) : []).toEqual([]);
    const status = loadStatus();
    expect(status.batchRef).toBeNull();

    // And the operator is told what to change, in Thai, with both dates.
    expect(status.lastError).toContain("2565");
    delete process.env.JHCIS_HOST;
    delete process.env.JHCIS_PORT;
  }, 60_000);
});

describe("what the operator is told", () => {
  it("names both dates and points at the local setting", () => {
    const refusal = checkManualRange("2019-01-01", "2022-10-01");
    expect(refusal).not.toBeNull();
    expect(refusal?.code).toBe("MANUAL_RANGE_BEFORE_SYNC_START_DATE");
    expect(refusal?.requestedFromDate).toBe("2019-01-01");
    expect(refusal?.configuredSyncStartDate).toBe("2022-10-01");

    const message = manualRangeRefusalMessage("2019-01-01", "2022-10-01");
    // Thai Buddhist-era dates for a person to read: 2019 -> 2562, 2022 -> 2565.
    expect(message).toContain("01/01/2562");
    expect(message).toContain("01/10/2565");
    // And it sends them to the Tray, which is the only authority for the floor.
    expect(message).toContain("การตั้งค่า Agent");
    // Nothing about a patient, ever.
    expect(message).not.toMatch(/\d{13}/);
  });

  it("says nothing when the range is fine", () => {
    expect(checkManualRange("2022-10-01", "2022-10-01")).toBeNull();
    expect(checkManualRange("2030-01-01", "2022-10-01")).toBeNull();
  });
});
