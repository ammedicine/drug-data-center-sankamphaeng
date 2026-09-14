/**
 * Runs inside the staged copy of node.exe - the same situation as the real
 * updater, which is `runtime\node.exe agent.js auto-update` under SYSTEM.
 *
 *   race     the v1.1.11 model: start the installer without ensuring this
 *            process is gone, then linger a few seconds. The installer races
 *            the still-held node.exe and loses.
 *   handoff  the v1.1.12 model: the Agent's own handOffInstaller, which
 *            launches the PowerShell helper that waits for this process to
 *            exit before it starts the installer.
 *
 * The result file records what this process did and when it exited; the real
 * `agent auto-update` process ends the same way (main() returns, node exits),
 * which is what releases runtime\node.exe.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [, , mode, installer, resultFile] = process.argv;
const startedAt = Date.now();
const done = (extra: Record<string, unknown>) => {
  writeFileSync(resultFile, JSON.stringify({ mode, pid: process.pid, exe: process.execPath, startedAt, exitingAt: Date.now(), ...extra }));
  process.exit(0);
};

if (mode === "race") {
  // v1.1.11-style: fire the installer detached and do NOT wait for our own
  // exit. Then linger, so the installer starts while node.exe is still held.
  const child = spawn(installer, ["/VERYSILENT", "/NORESTART"], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  setTimeout(() => done({ raced: true, installerPid: child.pid }), 6000);
} else if (mode === "handoff") {
  const { handOffInstaller } = await import("../../../agent/src/updater");
  const handoff = await handOffInstaller(installer, "9.9.9");
  done({ handoff });
} else {
  throw new Error(`unknown mode ${mode}`);
}
