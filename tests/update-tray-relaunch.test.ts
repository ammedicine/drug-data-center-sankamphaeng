/**
 * After a silent update the Agent must come back in the tray, not on screen.
 *
 * The post-install relaunch starts the new Agent in the signed-in user's
 * session so the worker resumes without waiting for the next logon. But it
 * launched SDCAgent.exe with no arguments, and the GUI opens its main window
 * unless it is given "--tray" (the Startup shortcut passes it; this path did
 * not). So an unattended update popped the window open in front of clinic
 * staff. The relaunch must pass the same "--tray" the Startup shortcut does.
 */
import { describe, expect, it } from "vitest";

import { buildTrayRelaunchScript } from "../agent/src/updater";

describe("silent post-update tray relaunch", () => {
  it("launches SDCAgent.exe with --tray so the main window stays hidden", () => {
    const script = buildTrayRelaunchScript("C:\\Program Files\\SDC Agent\\SDCAgent.exe");
    // The action starts the installed exe with the fixed --tray argument.
    expect(script).toContain("New-ScheduledTaskAction -Execute 'C:\\Program Files\\SDC Agent\\SDCAgent.exe' -Argument '--tray'");
  });

  it("keeps the path safely single-quoted, spaces and all", () => {
    const script = buildTrayRelaunchScript("C:\\Program Files\\SDC Agent\\SDCAgent.exe");
    expect(script).toContain("-Execute 'C:\\Program Files\\SDC Agent\\SDCAgent.exe'");
  });

  it("passes only the fixed literal --tray, never anything composed", () => {
    const script = buildTrayRelaunchScript("C:\\x\\SDCAgent.exe");
    // Exactly one -Argument, and it is the literal flag.
    expect(script.match(/-Argument /g)?.length).toBe(1);
    expect(script).toContain("-Argument '--tray'");
  });

  it("escapes a single quote in the path rather than breaking out of the literal", () => {
    const script = buildTrayRelaunchScript("C:\\O'Brien\\SDCAgent.exe");
    expect(script).toContain("-Execute 'C:\\O''Brien\\SDCAgent.exe' -Argument '--tray'");
  });

  it("still runs under the signed-in user, interactively, and cleans up its one-shot task", () => {
    const script = buildTrayRelaunchScript("C:\\x\\SDCAgent.exe");
    expect(script).toContain("LogonType Interactive");
    expect(script).toContain("Get-CimInstance Win32_ComputerSystem");
    expect(script).toContain("Unregister-ScheduledTask");
    expect(script).toContain("no console user"); // graceful when nobody is signed in
  });
});
