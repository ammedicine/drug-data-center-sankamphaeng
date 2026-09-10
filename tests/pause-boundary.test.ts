/**
 * Where a pause is allowed to land when a run is already going.
 *
 * The tempting implementation stops immediately. It is wrong: an upload that
 * is halfway through is a request the centre may already be committing, and
 * abandoning it makes the local queue disagree with what was stored. The
 * clinic then either loses a chunk or sends it twice, and both are worse than
 * waiting a few seconds.
 *
 * So the boundary is between units, never inside one - between chunks in the
 * upload loop, and between pages in the extraction loop. Until the current
 * unit finishes the Agent says PAUSE_REQUESTED rather than PAUSED, because
 * claiming to have stopped while still writing is the one answer an operator
 * running a reset must not be given.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let home: string;
let counter = 0;

beforeEach(() => {
  home = mkdtempSync(resolve(tmpdir(), "sdc-boundary-"));
  process.env.AGENT_DATA_DIR = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENT_DATA_DIR;
});

const controlModule = () => import(`../agent/src/control?b=${counter++}`);

function persist(state: Record<string, unknown>) {
  writeFileSync(join(home, "state.json"), JSON.stringify(state), "utf8");
}

describe("the three states an agent can be in", () => {
  it("reports RUNNING when the centre has said nothing", async () => {
    const { desiredSyncState, effectiveSyncState, syncPaused } = await controlModule();
    persist({ lastSyncedVisitDate: null, lastSyncAt: null, batchSequence: 0 });
    expect(desiredSyncState()).toBe("RUNNING");
    expect(effectiveSyncState()).toBe("RUNNING");
    expect(syncPaused()).toBe(false);
  });

  it("says PAUSED immediately when nothing was running", async () => {
    // The canary found this the wrong way round. An idle agent was paused,
    // applied the instruction in thirteen seconds, and still reported
    // PAUSE_REQUESTED - because the flag was set on arrival and only cleared
    // by the next run, 48 minutes later. The fleet screen would have shown
    // "รอ Agent รับคำสั่ง" for most of an hour about a สถานบริการ that had
    // already stopped, which during a reset is exactly the wrong thing to
    // tell somebody.
    const { applyControlInstruction, effectiveSyncState, markRunInFlight } =
      await controlModule();
    persist({ lastSyncedVisitDate: null, lastSyncAt: null, batchSequence: 0 });
    markRunInFlight(false);

    applyControlInstruction({
      syncControlState: "PAUSED",
      controlRevision: 1,
      pauseReason: null,
    } as never);

    expect(effectiveSyncState()).toBe("PAUSED");
  });

  it("says PAUSE_REQUESTED only while a run is genuinely in flight", async () => {
    const { applyControlInstruction, effectiveSyncState, markRunInFlight } =
      await controlModule();
    persist({ lastSyncedVisitDate: null, lastSyncAt: null, batchSequence: 0 });
    markRunInFlight(true);

    applyControlInstruction({
      syncControlState: "PAUSED",
      controlRevision: 1,
      pauseReason: null,
    } as never);

    // Told to stop, still writing. This is the state the handover exists for.
    expect(effectiveSyncState()).toBe("PAUSE_REQUESTED");
  });

  it("moves from handover to stopped once the run ends", async () => {
    const { beginPauseHandover, effectiveSyncState, completePauseHandover } =
      await controlModule();
    persist({
      lastSyncedVisitDate: null,
      lastSyncAt: null,
      batchSequence: 0,
      syncControlState: "PAUSED",
      appliedControlRevision: 1,
    });

    beginPauseHandover();
    // Told to stop, still writing. An operator waiting to reset the centre
    // must be able to tell this apart from "stopped".
    expect(effectiveSyncState()).toBe("PAUSE_REQUESTED");

    completePauseHandover();
    expect(effectiveSyncState()).toBe("PAUSED");
  });
});

describe("obeying the same instruction twice", () => {
  it("acts once, however many heartbeats repeat it", async () => {
    const { applyControlInstruction } = await controlModule();
    const { loadState } = await import(`../agent/src/config?b=${counter++}`);
    persist({ lastSyncedVisitDate: null, lastSyncAt: null, batchSequence: 0 });

    const instruction = {
      syncControlState: "PAUSED" as const,
      controlRevision: 4,
      pauseReason: "เตรียมล้างข้อมูล",
    } as never;

    applyControlInstruction(instruction);
    const first = loadState();
    expect(first.syncControlState).toBe("PAUSED");
    expect(first.appliedControlRevision).toBe(4);
    const appliedAt = first.controlAppliedAt;

    // The same standing instruction arrives on every heartbeat for as long as
    // it stands. Acting on each would mean a log line and a status write every
    // thirty seconds for the whole time a สถานบริการ is stopped.
    applyControlInstruction(instruction);
    applyControlInstruction(instruction);
    expect(loadState().controlAppliedAt).toBe(appliedAt);
  });

  it("acts again when the revision moves", async () => {
    const { applyControlInstruction } = await controlModule();
    const { loadState } = await import(`../agent/src/config?b=${counter++}`);
    persist({ lastSyncedVisitDate: null, lastSyncAt: null, batchSequence: 0 });

    applyControlInstruction({
      syncControlState: "PAUSED",
      controlRevision: 1,
      pauseReason: null,
    } as never);
    expect(loadState().syncControlState).toBe("PAUSED");

    applyControlInstruction({
      syncControlState: "RUNNING",
      controlRevision: 2,
      pauseReason: null,
    } as never);
    const resumed = loadState();
    expect(resumed.syncControlState).toBe("RUNNING");
    expect(resumed.appliedControlRevision).toBe(2);
  });
});

describe("when the centre cannot be reached", () => {
  it("stays paused rather than assuming it may start again", async () => {
    // Fail closed. Treating silence as permission would mean a dropped
    // connection could restart collection at a สถานบริการ somebody had
    // deliberately stopped - which is the single outcome this mechanism
    // exists to prevent.
    const { applyControlInstruction, syncPaused } = await controlModule();
    persist({
      lastSyncedVisitDate: null,
      lastSyncAt: null,
      batchSequence: 0,
      syncControlState: "PAUSED",
      appliedControlRevision: 3,
    });
    expect(syncPaused()).toBe(true);

    // A response carrying no instruction at all - an older Central, or one
    // rolled back. It changes nothing.
    applyControlInstruction({ lastSyncedVisitDate: null } as never);
    expect(syncPaused()).toBe(true);
  });

  it("survives a restart, because it was written down", async () => {
    // The machine most likely to be restarted during a reset is the one
    // somebody is standing in front of. Held only in memory, every restart
    // would open a window in which the agent believed it was free to collect.
    const first = await controlModule();
    persist({ lastSyncedVisitDate: null, lastSyncAt: null, batchSequence: 0 });
    first.applyControlInstruction({
      syncControlState: "PAUSED",
      controlRevision: 9,
      pauseReason: "รอรีเซ็ต",
    } as never);

    // A completely fresh load of the module, as a restarted worker would do.
    const restarted = await controlModule();
    expect(restarted.syncPaused()).toBe(true);
    expect(restarted.desiredSyncState()).toBe("PAUSED");
    // And the handover flag does not survive, because no run is in flight
    // after a restart - it is simply stopped.
    expect(restarted.effectiveSyncState()).toBe("PAUSED");
    expect(restarted.pausedMessage()).toContain("รอรีเซ็ต");
  });
});
