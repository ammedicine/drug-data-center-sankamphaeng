/**
 * Keeps the suite out of the installed Agent's data directory.
 *
 * Agent modules default AGENT_DATA_DIR to %ProgramData%\SDCAgent, which on a
 * machine that also runs the real Agent is the live installation. Tests that
 * imported a module with a logger therefore wrote their own lines into the
 * production log - including, deliberately, an ERROR about an unrepairable
 * charset produced by a fixture.
 *
 * That is not a tidiness problem. Those lines were later read back as evidence
 * about production and taken to mean a real สถานบริการ had an encoding fault,
 * which cost an investigation and nearly a wrong release decision. A test must
 * not be able to forge a production diagnostic.
 *
 * Files that set AGENT_DATA_DIR themselves are untouched.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

if (!process.env.AGENT_DATA_DIR) {
  process.env.AGENT_DATA_DIR = mkdtempSync(resolve(tmpdir(), "sdc-test-datadir-"));
}
