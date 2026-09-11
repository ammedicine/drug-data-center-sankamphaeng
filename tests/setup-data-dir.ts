/**
 * Keeps the suite out of the installed Agent's data directory - airtight.
 *
 * Agent modules default AGENT_DATA_DIR to %ProgramData%\SDCAgent, which on a
 * machine that also runs the real Agent is the live installation. The first
 * version of this file set the variable once, and that was not enough: test
 * files that `delete process.env.AGENT_DATA_DIR` in their own afterEach let
 * every module imported after that point fall back to production. A fixture's
 * deliberate ERROR about an unrepairable charset landed in the live agent log,
 * was read back as evidence about production, and nearly changed a release
 * decision. A test must not be able to forge a production diagnostic.
 *
 * So the variable is now guarded at the environment itself:
 *
 *  - deleting it puts the sandbox back instead of leaving it empty;
 *  - setting it to anything under ProgramData throws immediately;
 *  - every test starts and ends with it pointing somewhere under the sandbox.
 *
 * Files that set their own temporary AGENT_DATA_DIR keep working - a temp
 * directory is not ProgramData - and child processes inherit whatever the
 * guard allowed, so a spawned `agent run` is covered too.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach } from "vitest";

const KEY = "AGENT_DATA_DIR";
const FORBIDDEN = /programdata[\\/]+sdcagent/i;

export const TEST_DATA_DIR_SANDBOX = mkdtempSync(resolve(tmpdir(), "sdc-test-datadir-"));

function refuse(value: unknown): never {
  throw new Error(
    `Refusing to point ${KEY} at the installed Agent (${String(value)}). ` +
      "Tests never touch %ProgramData%\\SDCAgent.",
  );
}

const real = process.env;
if (FORBIDDEN.test(String(real[KEY] ?? ""))) {
  // Inherited from the machine, not chosen by a test: this development PC
  // carries a user-level AGENT_DATA_DIR pointing at the installed Agent, which
  // is how the suite reached production in the first place. Overridden and
  // said out loud, rather than failing every run on the one machine the suite
  // is most often run on.
  console.warn(
    `[setup-data-dir] ${KEY} inherited as ${real[KEY]} - overriding with ${TEST_DATA_DIR_SANDBOX} ` +
      "so no test can touch the installed Agent.",
  );
  real[KEY] = TEST_DATA_DIR_SANDBOX;
}
if (!real[KEY]) real[KEY] = TEST_DATA_DIR_SANDBOX;

process.env = new Proxy(real, {
  set(target, key, value) {
    if (key === KEY && FORBIDDEN.test(String(value))) refuse(value);
    target[key as string] = value as string;
    return true;
  },
  deleteProperty(target, key) {
    if (key === KEY) {
      // "No override" must never mean "production". The sandbox is the
      // default from here on, not ProgramData.
      target[KEY] = TEST_DATA_DIR_SANDBOX;
      return true;
    }
    return delete target[key as string];
  },
});

beforeEach(() => {
  const current = process.env[KEY];
  if (!current || FORBIDDEN.test(current)) process.env[KEY] = TEST_DATA_DIR_SANDBOX;
});

afterEach(() => {
  const current = process.env[KEY];
  if (!current || FORBIDDEN.test(current)) process.env[KEY] = TEST_DATA_DIR_SANDBOX;
});
