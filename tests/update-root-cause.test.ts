/**
 * Why a machine on published v1.1.8 never installed v1.1.9.
 *
 * The machine is real: RPST-05957's second Agent on DESKTOP-741A6BC, enrolled
 * 2026-09-11 09:04Z - an hour after v1.1.9 was published, so every check it
 * could ever have made would have found a newer release. Central shows it on
 * only briefly that day and from about 01:50Z to 05:03Z the next, syncing
 * hourly and healthily, and still reporting 1.1.8 / bd0f9da when it went off.
 *
 * The v1.1.8 task was `schtasks /Create /SC HOURLY /MO 4` with every other
 * setting left to schtasks: no StartWhenAvailable, no start on batteries, no
 * boot trigger, anchored to the install minute. Replaying that definition
 * against the machine's observed on-windows shows what happened. The v1.1.10
 * definition is then replayed against the same windows and must run.
 */
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const T = (s: string) => new Date(s);

/** Observed from Central: enrolment, first sync, then the next day's session. */
const ON_WINDOWS: [Date, Date][] = [
  [T("2026-09-11T09:03:00Z"), T("2026-09-11T09:12:00Z")],
  [T("2026-09-12T01:50:00Z"), T("2026-09-12T05:03:30Z")],
];
const REGISTERED_AT = T("2026-09-11T09:03:24Z"); // the installer finished writing the task here

describe("what the v1.1.8 task did on the machine that never updated", () => {
  it("is exactly the schtasks form with no catch-up and no battery start", () => {
    const iss = spawnSync("git", ["show", "v1.1.8:agent/installer/sdc-agent.iss"], { encoding: "utf8" }).stdout;
    expect(iss).toContain('/TN "SDCAgentAutoUpdate" /RU SYSTEM /RL HIGHEST /SC HOURLY /MO 4');
    // Nothing in the tag sets any of these, so schtasks defaults applied:
    // StartWhenAvailable=false, DisallowStartIfOnBatteries=true, no BootTrigger.
    expect(iss).not.toMatch(/StartWhenAvailable/);
    expect(iss).not.toMatch(/Batter/i);
    expect(iss).not.toMatch(/BootTrigger/);
    expect(iss).not.toMatch(/\/XML/);
  });

  it("produced no usable run in the machine's observed on-windows", async () => {
    const { clockTriggers, runsDuring } = await import("../agent/src/task-definition");
    // Anchored to the install minute, every four hours.
    const triggers = clockTriggers(T("2026-09-11T09:03:00Z"), 240, REGISTERED_AT, T("2026-09-12T06:00:00Z"));
    expect(triggers.map((d) => d.toISOString())).toEqual([
      "2026-09-11T13:03:00.000Z",
      "2026-09-11T17:03:00.000Z",
      "2026-09-11T21:03:00.000Z",
      "2026-09-12T01:03:00.000Z",
      "2026-09-12T05:03:00.000Z",
    ]);

    const runs = runsDuring({ triggers, on: ON_WINDOWS, startWhenAvailable: false, registeredAt: REGISTERED_AT });
    // Four of five triggers fell while the PC was off and were simply lost.
    // The fifth, 05:03:00, landed thirty seconds before the last heartbeat
    // Central ever received - inside a shutdown, with no time to download
    // forty megabytes and run an installer.
    expect(runs.map((d) => d.toISOString())).toEqual(["2026-09-12T05:03:00.000Z"]);
    const lastHeartbeat = T("2026-09-12T05:03:20Z");
    expect(lastHeartbeat.getTime() - runs[0].getTime()).toBeLessThan(60_000);
  });

  it("the installed task on this PC carries the same power restrictions", () => {
    // Read yesterday, elevated, from the real SDCAgentAutoUpdate task written
    // by the same schtasks form (v1.1.9 changed only the cadence). Kept as a
    // fixture so the assertion does not need elevation to run.
    const listV = [
      "Power Management:                     Stop On Battery Mode, No Start On Batteries",
      "Schedule Type:                        One Time Only, Minute ",
    ].join("\n");
    expect(listV).toContain("No Start On Batteries");
    expect(listV).toContain("Stop On Battery Mode");
  });
});

describe("what the v1.1.10 task does on the same machine", () => {
  it("runs within minutes of the PC coming on, and never loses a missed trigger", async () => {
    const { updateTaskDefinition, clockTriggers, runsDuring } = await import("../agent/src/task-definition");
    const def = updateTaskDefinition({
      appDir: "C:\\Program Files\\SDC Agent",
      identity: "01m27va59neeg8ym342ny88034",
      anchorDate: "2026-09-11",
    });
    expect(def.startWhenAvailable).toBe(true);
    expect(def.allowStartOnBatteries).toBe(true);
    expect(def.stopIfGoingOnBatteries).toBe(false);
    expect(def.intervalMinutes).toBe(30);
    expect(def.bootTriggerDelayMinutes).toBeGreaterThan(0);

    const [hh, mm] = def.startTime.split(":").map(Number);
    const anchor = new Date(Date.UTC(2026, 8, 11, hh, mm));
    const triggers = clockTriggers(anchor, def.intervalMinutes, REGISTERED_AT, T("2026-09-12T06:00:00Z"));
    const runs = runsDuring({
      triggers,
      on: ON_WINDOWS,
      startWhenAvailable: def.startWhenAvailable,
      bootTriggerDelayMinutes: def.bootTriggerDelayMinutes,
      registeredAt: REGISTERED_AT,
    });

    // Same machine, same hours: a boot-trigger run three minutes into the
    // 01:50 session, the caught-up trigger from overnight at 01:50 itself,
    // and then one every thirty minutes until shutdown.
    const day2 = runs.filter((d) => d.getTime() >= T("2026-09-12T01:50:00Z").getTime() && d.getTime() < T("2026-09-12T05:03:30Z").getTime());
    expect(day2.length).toBeGreaterThanOrEqual(7);
    expect(day2[0].toISOString()).toBe("2026-09-12T01:50:00.000Z"); // caught-up overnight trigger
    // Even the nine-minute enrolment session on day one gets its boot check.
    expect(runs.some((d) => d.toISOString() === "2026-09-11T09:06:00.000Z")).toBe(true);
  });

  it("is written out in full as XML, with every flag explicit", async () => {
    const { updateTaskDefinition, updateTaskXml, UPDATE_TASK_NAME, SYSTEM_SID } = await import(
      "../agent/src/task-definition"
    );
    const xml = updateTaskXml(
      updateTaskDefinition({ appDir: "C:\\Program Files\\SDC Agent", identity: "x", anchorDate: "2026-09-12" }),
    );
    expect(UPDATE_TASK_NAME).toBe("SDCAgentAutoUpdate");
    expect(xml).toContain(`<UserId>${SYSTEM_SID}</UserId>`);
    expect(xml).toContain("<RunLevel>HighestAvailable</RunLevel>");
    expect(xml).toContain("<Interval>PT30M</Interval>");
    expect(xml).toContain("<StartWhenAvailable>true</StartWhenAvailable>");
    expect(xml).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
    expect(xml).toContain("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>");
    expect(xml).toContain("<BootTrigger>");
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(xml).toMatch(/<StartBoundary>2026-09-12T00:[0-2][0-9]:00<\/StartBoundary>/);
    expect(xml).toContain("<Command>C:\\Program Files\\SDC Agent\\runtime\\node.exe</Command>");
    expect(xml).toContain("<Arguments>&quot;C:\\Program Files\\SDC Agent\\app\\agent.js&quot; auto-update</Arguments>");
    // The action is fixed: nothing in it can be steered from outside.
    expect(xml).not.toMatch(/%[A-Z_]+%|\$\{/);
  });
});
