/**
 * Stands in for the Inno installer - preloaded into a copy of node.exe that
 * plays the setup program (see update-handoff.test.ts).
 *
 * It does the one thing that matters for the lock: what Inno does to replace
 * a file with `ignoreversion` - DeleteFile, retry a few times while the file
 * is in use, then give up the way a silent install under SYSTEM gives up (the
 * Abort/Retry/Ignore box nobody can see). Then it writes the new bytes and a
 * marker for the test to read, and exits with Inno's code for "in use" (5).
 */
const fs = require("node:fs");
const path = require("node:path");

const target = process.env.HANDOFF_TARGET;
const replacement = process.env.HANDOFF_REPLACEMENT;
const marker = process.env.HANDOFF_MARKER;
const startedAt = Date.now();

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const record = (outcome, extra = {}) => {
  fs.writeFileSync(marker, JSON.stringify({ outcome, pid: process.pid, ppid: process.ppid, startedAt, finishedAt: Date.now(), ...extra }));
};

let replaced = false;
let attempts = 0;
while (!replaced && attempts < 4) {
  attempts++;
  try {
    fs.unlinkSync(target);
    replaced = true;
  } catch (error) {
    if (error.code !== "EPERM" && error.code !== "EBUSY" && error.code !== "EACCES") throw error;
    sleepMs(250);
  }
}
if (!replaced) {
  // Inno: "An error occurred while trying to replace the existing file:
  // DeleteFile failed; code 5." - and a message box that a SYSTEM session
  // never shows. The real installer sits here for ever; this one stops.
  record("IN_USE", { attempts });
  process.exit(5);
}
fs.copyFileSync(replacement, target);
record("REPLACED", { attempts });
process.exit(0);
