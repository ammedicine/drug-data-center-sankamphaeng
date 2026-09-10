/**
 * A watermark that has run ahead of real time.
 *
 * Found on production 05957: the stored watermark was 2026-09-30 while the
 * newest dispensing row in JHCIS was 2026-09-10. It got there honestly -
 * `agent verify` repairs a month at a time, so repairing September issues
 * MANUAL_RANGE 2026-09-01..2026-09-30, and a run that completes reports the
 * end of what it was asked for as verified. For any past month that is
 * correct. For the month you are standing in, it claims to have verified
 * twenty days that have not happened yet.
 *
 * The consequence is not cosmetic, and these tests exist to establish exactly
 * what it is rather than argue about it: the next incremental run computes its
 * start from the watermark and its end from the newest row that exists, which
 * puts the start after the end. An inverted range reads nothing, so nothing is
 * collected and nothing advances - for the rest of the month.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let home: string;
let counter = 0;

beforeEach(() => {
  home = mkdtempSync(resolve(tmpdir(), "sdc-future-"));
  process.env.AGENT_DATA_DIR = home;
  writeFileSync(
    join(home, "settings.json"),
    JSON.stringify({ autoSyncEnabled: true, syncStartDate: "2022-10-01" }),
    "utf8",
  );
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENT_DATA_DIR;
});

const syncModule = () => import(`../agent/src/sync?fw=${counter++}`);

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

function persistWatermark(value: string | null) {
  writeFileSync(
    join(home, "state.json"),
    JSON.stringify({ lastSyncedVisitDate: value, lastSyncAt: null, batchSequence: 0 }),
    "utf8",
  );
}

/** JHCIS as it actually was on 05957: nothing newer than the 10th. */
const bounds = async () => ({ min: "2006-10-31", max: "2026-09-10" });

describe("what a future watermark does to the next scheduled run", () => {
  it("no longer inverts the range, because the watermark is repaired first", async () => {
    // What this used to do, measured before the fix and kept here because it
    // is the whole reason the fix exists:
    //
    //   watermark 2026-09-30, JHCIS newest 2026-09-10
    //     -> { from: "2026-09-23", to: "2026-09-10" }   from > to
    //     -> an inverted range selects nothing at all
    //
    // A สถานบริการ dispensing every day would have collected nothing until
    // the calendar reached the 30th.
    persistWatermark("2026-09-30");
    const { resolveRange } = await syncModule();

    const range = await resolveRange("INCREMENTAL", credential, bounds, {
      from: null,
      to: null,
    });

    expect(range.from <= range.to).toBe(true);
    expect(range.from).not.toBe("2026-09-23");
  });

  it("collects a record dated after the old future watermark's start", async () => {
    // B. The row that would have been stranded. JHCIS now reaches the 11th,
    // and the run has to include it rather than wait for October.
    persistWatermark("2026-09-30");
    const { resolveRange } = await syncModule();
    const range = await resolveRange("INCREMENTAL", credential, async () => ({
      min: "2006-10-31",
      max: "2026-09-11",
    }), { from: null, to: null });

    // The window is anchored on today rather than on a date in the future, so
    // it reaches back across the days that were being skipped.
    const todayIso = new Date().toISOString().slice(0, 10);
    expect(range.from <= range.to).toBe(true);
    expect(range.from < todayIso).toBe(true);
  });

  it("self-heals: the stored value is repaired, and the range comes out sane", async () => {
    // C. The machine already holding 2026-09-30 must recover on its own. No
    // file is edited by hand and nothing outside sync-derived state is
    // touched.
    persistWatermark("2026-09-30");
    const { resolveRange } = await syncModule();
    const { loadState } = await import(`../agent/src/config?fw=${counter++}`);

    const range = await resolveRange("INCREMENTAL", credential, bounds, { from: null, to: null });

    const todayIso = new Date().toISOString().slice(0, 10);
    expect(loadState().lastSyncedVisitDate).toBe(todayIso);
    expect(range.from <= range.to).toBe(true);
    // And it now reaches back over the reprocess window from today, so the
    // days that were being skipped are read again.
    expect(range.from < todayIso).toBe(true);
  });

  it("leaves an honest watermark alone", async () => {
    // E. Nothing is normalised that does not need to be - a past month-end is
    // a perfectly good verified-through.
    persistWatermark("2024-03-31");
    const { normalizeFutureWatermark } = await syncModule();
    expect(normalizeFutureWatermark()).toBeNull();
    const { loadState } = await import(`../agent/src/config?fw=${counter++}`);
    expect(loadState().lastSyncedVisitDate).toBe("2024-03-31");
  });

  it("caps a repair of the current month at today, not at the month end", async () => {
    // A. The exact path that created the production value: verify() repairs
    // September with MANUAL_RANGE 09-01..09-30.
    const { clampToToday } = await syncModule();
    const todayIso = new Date().toISOString().slice(0, 10);
    const monthEnd = `${todayIso.slice(0, 7)}-31`;
    expect(clampToToday(monthEnd)).toBe(todayIso);
    // A past month-end is untouched.
    expect(clampToToday("2024-02-29")).toBe("2024-02-29");
    // And today itself is allowed, so a quiet day still advances - D.
    expect(clampToToday(todayIso)).toBe(todayIso);
  });

  it("behaves correctly the moment the watermark is not in the future", async () => {
    // The same logic with an honest watermark is fine, which is what makes
    // this a watermark defect rather than a range defect.
    persistWatermark("2026-09-10");
    const { resolveRange } = await syncModule();
    const range = await resolveRange("INCREMENTAL", credential, bounds, { from: null, to: null });
    expect(range.from).toBe("2026-09-03");
    expect(range.to).toBe("2026-09-10");
    expect(range.from <= range.to).toBe(true);
  });
});
