/**
 * Runs inside the staged copy of node.exe - the same situation as the real
 * updater, which is `runtime\node.exe agent.js auto-update` under SYSTEM.
 *
 *   wait     the mechanism every release up to v1.1.10 used: start the
 *            installer and wait for it (execFile), still holding node.exe
 *   handoff  the fixed one: the Agent's own handOffInstaller()
 *
 * The result file records what this process saw and when it got to exit.
 */
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { promisify } from "node:util";

const [, , mode, installer, resultFile] = process.argv;
const startedAt = Date.now();
// The stand-in installer is a copy of node that runs the fake preloaded and
// exits inside it, before node would ever look at "/VERYSILENT". Set here,
// for children only, so this process is not affected.
process.env.NODE_OPTIONS = `--require ${String(process.env.HANDOFF_FAKE).split("\\").join("/")}`;
const done = (extra: Record<string, unknown>) => {
  writeFileSync(resultFile, JSON.stringify({ mode, pid: process.pid, exe: process.execPath, startedAt, exitingAt: Date.now(), ...extra }));
  // The real `agent auto-update` process ends here: main() returns and node
  // exits, which is what releases runtime\node.exe for the installer. tsx
  // keeps an esbuild service on the loop, so this test proxy says so out
  // loud rather than lingering and holding the very file under test.
  process.exit(0);
};

if (mode === "wait") {
  try {
    await promisify(execFile)(installer, ["/VERYSILENT", "/NORESTART"], { timeout: 20_000, windowsHide: true });
    done({ installerExit: 0 });
  } catch (error) {
    done({ installerExit: (error as { code?: number | string }).code ?? "unknown" });
  }
} else if (mode === "handoff") {
  const { handOffInstaller } = await import("../../../agent/src/updater");
  const handoff = await handOffInstaller(installer, "9.9.9");
  done({ handoff });
} else {
  throw new Error(`unknown mode ${mode}`);
}
