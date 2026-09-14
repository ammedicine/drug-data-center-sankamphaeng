/**
 * The bridge between the updater and the installer.
 *
 * The updater is `C:\Program Files\SDC Agent\runtime\node.exe`, and the
 * installer must replace that very file. v1.1.10 waited for the installer
 * synchronously, so node.exe stayed locked (DeleteFile code 5) and the
 * install timed out. v1.1.11 spawned the installer detached and exited, but
 * nothing made the installer wait for the updater to actually go, so the
 * replacement could still race the lock - which it did on 05957 on
 * 2026-09-14: a ~13-minute hang and a FAILED command, even though a manual
 * install afterwards proved the installer itself was fine.
 *
 * So this helper does the one thing the updater cannot do for itself: it
 * WAITS for the updater process to exit, proves it is gone, and only then
 * starts the installer. It is a plain script run by a COPY of node placed in
 * the updates directory (administrators/SYSTEM only), never the runtime\
 * node.exe the installer replaces - so it keeps running throughout, and a
 * detached node child reliably outlives the updater that launched it (a
 * detached PowerShell child, by contrast, dies with the launching console).
 * Its result is written where the next agent run reads it. Fixed arguments
 * only; it touches neither JHCIS nor the database.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const updaterPid = Number(arg("--updater-pid"));
const updaterImage = (arg("--updater-image") ?? "").toLowerCase();
const installerPath = arg("--installer");
const installerLog = arg("--installer-log");
const resultPath = arg("--result");
const waitMs = Number(arg("--wait-ms") ?? 120_000);
const graceMs = Number(arg("--grace-ms") ?? 2_000);

function writeResult(obj) {
  const tmp = `${resultPath}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...obj, at: new Date().toISOString() }), "utf8");
  renameSync(tmp, resultPath);
}

// A blocking sleep with no event loop: this process does exactly one thing.
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Is the updater still the updater? A live pid is not enough - Windows reuses
// pids - so the process behind it must still be running the updater's image.
// A recycled pid pointing at anything else reads as gone, which ends the wait
// rather than blocking for ever; an unreadable image is treated as still ours,
// the cautious choice, since starting too early is the failure we are here to
// prevent.
function updaterAlive() {
  if (!(updaterPid > 0)) return false;
  try {
    process.kill(updaterPid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "win32" || !updaterImage) return true;
  try {
    const csv = execFileSync("tasklist", ["/FI", `PID eq ${updaterPid}`, "/FO", "CSV", "/NH"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    const image = (csv.trim().match(/^"([^"]+)"/) || [])[1] || "";
    if (!image) return false;
    return image.toLowerCase() === updaterImage;
  } catch {
    return true;
  }
}

try {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && updaterAlive()) sleep(500);

  if (updaterAlive()) {
    // The updater never let go. Starting the installer now would just
    // reproduce the node.exe lock, so refuse and say why.
    writeResult({ outcome: "UPDATER_ALIVE", updaterPid });
    process.exit(10);
  }

  // The updater is gone and its handle on runtime\node.exe with it. A short
  // bounded grace lets the OS finish releasing before the installer opens it.
  if (graceMs > 0) sleep(graceMs);

  const r = spawnSync(installerPath, ["/VERYSILENT", "/NORESTART", `/LOG=${installerLog}`], { windowsHide: true });
  if (r.error) {
    writeResult({ outcome: "HELPER_ERROR", message: String(r.error.message).slice(0, 200) });
    process.exit(1);
  }
  const code = r.status ?? -1;
  writeResult({ outcome: code === 0 ? "INSTALLED" : "INSTALLER_FAILED", exit: code });
  process.exit(code === 0 ? 0 : code);
} catch (error) {
  writeResult({ outcome: "HELPER_ERROR", message: String(error?.message ?? error).slice(0, 200) });
  process.exit(1);
}
