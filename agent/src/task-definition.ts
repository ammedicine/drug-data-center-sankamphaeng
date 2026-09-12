/**
 * The Windows scheduled task that keeps this Agent up to date - as data.
 *
 * Why this exists at all: a machine that ran published v1.1.8 for a day never
 * installed v1.1.9, and nothing anywhere said why. Reading the task that
 * v1.1.8's installer wrote (`schtasks /Create /SC HOURLY /MO 4`) explains it
 * without needing the machine:
 *
 *  - Missed runs were not caught up. schtasks leaves StartWhenAvailable off,
 *    so a trigger that falls while the PC is switched off simply does not
 *    happen. Four-hour triggers anchored to the install minute, on a clinic PC
 *    that is on for a few hours a day, can miss every window for days.
 *  - Battery stopped it. schtasks sets "do not start on batteries" and "stop
 *    if going on batteries" by default. A notebook unplugged never checks.
 *  - Only a clock trigger. A PC switched on at 08:00 and off at 11:30 had no
 *    trigger in that window at all under the four-hour schedule.
 *
 * So the definition is written out in full, as Task Scheduler XML, rather than
 * left to schtasks defaults - and it is built here, in one pure function, so
 * every flag can be asserted by a test instead of discovered on a clinic PC.
 */
import { updateCheckStartTime, UPDATE_CHECK_INTERVAL_MINUTES } from "./schedule";

/** The fixed name of the one task this Agent owns for updating itself. */
export const UPDATE_TASK_NAME = "SDCAgentAutoUpdate";

/** Well-known SID for LocalSystem; used rather than a name that changes with the Windows language. */
export const SYSTEM_SID = "S-1-5-18";

/** How long after boot the first check runs, so a briefly-on PC still gets one. */
export const BOOT_TRIGGER_DELAY_MINUTES = 3;

export interface UpdateTaskDefinition {
  name: string;
  /** "00:MM" - the minute of each half hour this Agent checks at */
  startTime: string;
  intervalMinutes: number;
  /** run a trigger that was missed while the PC was off, as soon as it is on */
  startWhenAvailable: boolean;
  allowStartOnBatteries: boolean;
  stopIfGoingOnBatteries: boolean;
  /** also check a few minutes after every boot */
  bootTriggerDelayMinutes: number;
  runAsSid: string;
  runLevel: "HighestAvailable";
  command: string;
  arguments: string;
}

/**
 * The definition v1.1.10 writes, for a given install directory and identity.
 *
 * Everything that v1.1.8 left to defaults is now explicit and the opposite of
 * the default where the default was the bug.
 */
export function updateTaskDefinition(input: {
  appDir: string;
  identity: string;
  /** the date part of the start boundary; today when the installer runs */
  anchorDate?: string;
}): UpdateTaskDefinition & { anchorDate: string } {
  const dir = input.appDir.replace(/[\\/]+$/, "");
  return {
    name: UPDATE_TASK_NAME,
    startTime: updateCheckStartTime(input.identity),
    intervalMinutes: UPDATE_CHECK_INTERVAL_MINUTES,
    startWhenAvailable: true,
    allowStartOnBatteries: true,
    stopIfGoingOnBatteries: false,
    bootTriggerDelayMinutes: BOOT_TRIGGER_DELAY_MINUTES,
    runAsSid: SYSTEM_SID,
    runLevel: "HighestAvailable",
    command: `${dir}\\runtime\\node.exe`,
    arguments: `"${dir}\\app\\agent.js" auto-update`,
    anchorDate: input.anchorDate ?? new Date().toISOString().slice(0, 10),
  };
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Task Scheduler XML for `schtasks /Create /XML`.
 *
 * The repetition is PT<interval>M with no duration, which is what schtasks
 * produced before and what verify-update-task.ps1 checks for. The boot trigger
 * is the addition; a machine switched on for forty minutes now checks once
 * three minutes after boot and again at its slot if that falls inside the
 * forty minutes.
 */
export function updateTaskXml(def: UpdateTaskDefinition & { anchorDate: string }): string {
  const interval = `PT${def.intervalMinutes}M`;
  const bootDelay = `PT${def.bootTriggerDelayMinutes}M`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Drug data center อำเภอสันกำแพง - ตรวจรุ่นใหม่ทุก ${def.intervalMinutes} นาที</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <Repetition>
        <Interval>${interval}</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>${def.anchorDate}T${def.startTime}:00</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
    <BootTrigger>
      <Delay>${bootDelay}</Delay>
      <Enabled>true</Enabled>
    </BootTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${def.runAsSid}</UserId>
      <RunLevel>${def.runLevel}</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>${def.allowStartOnBatteries ? "false" : "true"}</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>${def.stopIfGoingOnBatteries ? "true" : "false"}</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>${def.startWhenAvailable ? "true" : "false"}</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(def.command)}</Command>
      <Arguments>${xmlEscape(def.arguments)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/* ------------------------------------------------------------ simulation */

/** A half-open interval during which the PC was switched on. */
export type OnWindow = [Date, Date];

/** The clock triggers a repeating task produces between two instants. */
export function clockTriggers(anchor: Date, intervalMinutes: number, from: Date, to: Date): Date[] {
  const out: Date[] = [];
  const step = intervalMinutes * 60_000;
  let t = anchor.getTime();
  while (t < from.getTime()) t += step;
  for (; t <= to.getTime(); t += step) out.push(new Date(t));
  return out;
}

/**
 * When a task would actually run, given when the PC was on.
 *
 * Without StartWhenAvailable a trigger that falls while the PC is off is lost.
 * With it, the first moment the PC is on after a missed trigger counts. A boot
 * trigger fires at each window start plus its delay, if the window lasts that
 * long. The result is the set of run instants - empty means "never ran", which
 * is the v1.1.8 outcome this file exists to prevent.
 */
export function runsDuring(input: {
  triggers: Date[];
  on: OnWindow[];
  startWhenAvailable: boolean;
  bootTriggerDelayMinutes?: number;
  /** the task did not exist before this instant */
  registeredAt: Date;
}): Date[] {
  const runs: Date[] = [];
  const windows = [...input.on].sort((a, b) => a[0].getTime() - b[0].getTime());
  const inWindow = (t: Date) =>
    windows.some(([s, e]) => t.getTime() >= s.getTime() && t.getTime() < e.getTime());

  for (const trigger of input.triggers) {
    if (trigger.getTime() < input.registeredAt.getTime()) continue;
    if (inWindow(trigger)) {
      runs.push(trigger);
      continue;
    }
    if (!input.startWhenAvailable) continue;
    // Missed: catch up at the start of the next window.
    const next = windows.find(([s]) => s.getTime() > trigger.getTime());
    if (next) runs.push(next[0]);
  }

  if (input.bootTriggerDelayMinutes !== undefined) {
    for (const [s, e] of windows) {
      const at = new Date(s.getTime() + input.bootTriggerDelayMinutes * 60_000);
      if (at.getTime() >= input.registeredAt.getTime() && at.getTime() < e.getTime()) runs.push(at);
    }
  }

  return [...new Set(runs.map((d) => d.getTime()))].sort((a, b) => a - b).map((t) => new Date(t));
}
