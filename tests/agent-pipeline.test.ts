/**
 * End-to-end test of the agent pipeline against the REAL local JHCISDB and a
 * mock Central API.
 *
 * What this proves without needing TiDB:
 *  - the agent and the server agree on the HMAC signing string (both sides use
 *    src/lib/shared/canonical.ts, so a drift would fail here)
 *  - extraction from JHCIS V5.1 produces well-formed canonical records
 *  - uploads are chunked and every chunk is durable on disk before it is sent
 *  - a failed upload leaves the queue intact and a later flush delivers it
 *  - record keys are stable across runs (idempotency)
 *
 * The suite skips itself when JHCISDB is not reachable, so CI without the
 * database still passes.
 */
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AGENT_HEADERS,
  buildSigningString,
  drugUsageRecordKey,
  signRequest,
  type DrugUsageRecord,
} from "@/lib/shared/canonical";

const SECRET = "e2e-agent-secret-value";
const KEY_ID = "AKe2etest";
const PCUCODE = "05957";
const FACILITY_ID = "FAC_E2E";
const RANGE = { from: "2026-08-01", to: "2026-08-08" };

interface UploadCall {
  batchRef: string;
  records: DrugUsageRecord[];
  drugs: number;
}

const state = {
  startCalls: [] as Array<Record<string, unknown>>,
  uploads: [] as UploadCall[],
  completes: [] as Array<Record<string, unknown>>,
  heartbeats: 0,
  signatureFailures: 0,
  seenNonces: new Set<string>(),
  /** flip to make every upload fail, simulating a broken link */
  failUploads: false,
};

let server: Server;
let baseUrl = "";
let workDir = "";
let jhcisAvailable = false;

/** Same verification the production route performs, minus the database. */
function verify(method: string, path: string, headers: Record<string, string>, body: string) {
  const timestamp = headers[AGENT_HEADERS.timestamp];
  const nonce = headers[AGENT_HEADERS.nonce];
  const signature = headers[AGENT_HEADERS.signature];
  if (!timestamp || !nonce || !signature) return "missing headers";
  if (headers[AGENT_HEADERS.key] !== KEY_ID) return "unknown key";
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300) return "skew";
  if (state.seenNonces.has(nonce)) return "replay";
  state.seenNonces.add(nonce);

  const expected = signRequest(SECRET, buildSigningString({ method, path, timestamp, nonce, body }));
  return expected === signature ? null : "bad signature";
}

function startMockCentral(): Promise<string> {
  return new Promise((done) => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk as Buffer));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const path = new URL(req.url ?? "/", "http://localhost").pathname;
        const headers = req.headers as Record<string, string>;

        const failure = verify(req.method ?? "GET", path, headers, body);
        if (failure) {
          state.signatureFailures += 1;
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "BAD_SIGNATURE", message: failure } }));
          return;
        }

        const payload = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        const reply = (status: number, data: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(data));
        };

        const config = {
          facilityId: FACILITY_ID,
          facilityCode: "RPST-05957",
          facilityName: "รพ.สต. ทดสอบ",
          expectedPcucode: PCUCODE,
          syncIntervalMinutes: 60,
          reprocessDays: 7,
          lastSyncedVisitDate: null,
          uploadChunkSize: 500,
          disabled: false,
          syncRequested: false,
        };

        switch (path) {
          case "/api/agent/heartbeat":
            state.heartbeats += 1;
            return reply(200, { ok: true, serverTime: new Date().toISOString(), config });
          case "/api/agent/config":
            return reply(200, config);
          case "/api/agent/sync/start":
            state.startCalls.push(payload);
            return reply(200, { batchId: "B1", resumed: false, uploadChunkSize: 500 });
          case "/api/agent/sync/upload": {
            if (state.failUploads) {
              return reply(500, { error: { code: "INTERNAL_ERROR", message: "simulated outage" } });
            }
            const records = (payload.records ?? []) as DrugUsageRecord[];
            state.uploads.push({
              batchRef: String(payload.batchRef),
              records,
              drugs: ((payload.drugs ?? []) as unknown[]).length,
            });
            return reply(200, { accepted: records.length, rejected: 0, rejects: [] });
          }
          case "/api/agent/sync/complete":
            state.completes.push(payload);
            return reply(200, { ok: true });
          default:
            return reply(404, { error: { code: "NOT_FOUND", message: path } });
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      done(`http://127.0.0.1:${port}`);
    });
  });
}

/**
 * Loads agent/.env (which is git-ignored) so the JHCIS credentials used by this
 * test never have to live in the repository.
 */
function loadAgentEnv(): void {
  const envPath = resolve(__dirname, "../agent/.env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    const [, key, value] = match;
    if (key.startsWith("JHCIS_") && !process.env[key]) {
      process.env[key] = value.replace(/^["']|["']$/g, "");
    }
  }
}

async function jhcisReachable(): Promise<boolean> {
  loadAgentEnv();
  try {
    const mysql = await import("mysql2/promise");
    const connection = await mysql.default.createConnection({
      host: process.env.JHCIS_DB_HOST ?? "127.0.0.1",
      port: Number(process.env.JHCIS_DB_PORT ?? 3333),
      user: process.env.JHCIS_DB_USER ?? "root",
      password: process.env.JHCIS_DB_PASSWORD ?? "",
      database: process.env.JHCIS_DB_DATABASE ?? "jhcisdb",
      connectTimeout: 3000,
    });
    await connection.end();
    return true;
  } catch {
    return false;
  }
}

/** Imported lazily so agent modules read the env we set up first. */
async function loadRunner() {
  const module = await import("../agent/src/sync");
  return new module.SyncRunner();
}

beforeAll(async () => {
  // The agent reads JHCIS settings from the environment, populated from agent/.env.
  loadAgentEnv();
  // keep the simulated-outage case quick; production defaults stay 5 x 2s
  process.env.AGENT_RETRY_ATTEMPTS = "2";
  process.env.AGENT_RETRY_BASE_MS = "50";

  jhcisAvailable = await jhcisReachable();
  if (!jhcisAvailable) return;

  baseUrl = await startMockCentral();

  workDir = mkdtempSync(join(tmpdir(), "sdc-agent-e2e-"));
  process.env.AGENT_DATA_DIR = resolve(workDir, "data");
  process.env.CENTRAL_API_URL = baseUrl;

  writeFileSync(
    resolve(workDir, "agent.config.json"),
    JSON.stringify({
      agentId: "AG_E2E",
      keyId: KEY_ID,
      secret: SECRET,
      centralApiUrl: baseUrl,
      facilityId: FACILITY_ID,
      facilityCode: "RPST-05957",
      facilityName: "รพ.สต. ทดสอบ",
      expectedPcucode: PCUCODE,
      installationId: "e2e-installation",
      syncIntervalMinutes: 60,
      reprocessDays: 7,
      enrolledAt: new Date().toISOString(),
    }),
    "utf8",
  );
}, 30_000);

afterAll(async () => {
  server?.close();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe.runIf(await jhcisReachable())("agent pipeline against real JHCISDB", () => {
  it("extracts, signs, chunks and uploads a date range", async () => {
    const runner = await loadRunner();
    const result = await runner.run({ mode: "MANUAL_RANGE", from: RANGE.from, to: RANGE.to });

    expect(state.signatureFailures).toBe(0);
    expect(state.startCalls).toHaveLength(1);
    expect(state.startCalls[0]).toMatchObject({ pcucode: PCUCODE, mode: "MANUAL_RANGE" });

    expect(result.recordsRead).toBeGreaterThan(0);
    expect(result.recordsSent).toBe(result.recordsRead);
    expect(result.pendingChunks).toBe(0);

    const uploaded = state.uploads.flatMap((call) => call.records);
    expect(uploaded).toHaveLength(result.recordsSent);
    expect(state.uploads.some((call) => call.drugs > 0)).toBe(true);
  }, 120_000);

  it("produces canonical records with no patient-identifying fields", () => {
    const record = state.uploads.flatMap((call) => call.records)[0];
    expect(record).toBeDefined();
    expect(Object.keys(record).sort()).toEqual(
      ["clinic", "drugCode", "drugName", "drugType", "quantity", "unit", "usageDate", "visitNo"].sort(),
    );
    expect(record.usageDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(record.usageDate >= RANGE.from && record.usageDate <= RANGE.to).toBe(true);
    expect(Number.isFinite(record.quantity)).toBe(true);
    expect(record.drugCode.length).toBeGreaterThan(0);
  });

  it("keeps every chunk within the server's upload limit", () => {
    for (const call of state.uploads) expect(call.records.length).toBeLessThanOrEqual(500);
  });

  it("closes the batch and advances the watermark", () => {
    expect(state.completes).toHaveLength(1);
    expect(state.completes[0]).toMatchObject({ status: "COMPLETED", lastVisitDate: RANGE.to });

    const saved = JSON.parse(
      readFileSync(resolve(process.env.AGENT_DATA_DIR as string, "state.json"), "utf8"),
    );
    expect(saved.lastSyncedVisitDate).toBe(RANGE.to);
  });

  it("derives stable, unique record keys (idempotent re-upload)", () => {
    const records = state.uploads.flatMap((call) => call.records);
    const keys = records.map((record) =>
      drugUsageRecordKey({
        facilityId: FACILITY_ID,
        pcucode: PCUCODE,
        visitNo: record.visitNo,
        drugCode: record.drugCode,
      }),
    );
    // JHCIS visitdrug PK is (pcucode, visitno, drugcode): no duplicates expected
    expect(new Set(keys).size).toBe(keys.length);

    const again = records.map((record) =>
      drugUsageRecordKey({
        facilityId: FACILITY_ID,
        pcucode: PCUCODE,
        visitNo: record.visitNo,
        drugCode: record.drugCode,
      }),
    );
    expect(again).toEqual(keys);
  });

  it("survives an outage: the queue holds the data and a later flush delivers it", async () => {
    const runner = await loadRunner();

    state.failUploads = true;
    const failed = await runner.run({ mode: "MANUAL_RANGE", from: RANGE.from, to: RANGE.to });
    expect(failed.pendingChunks).toBeGreaterThan(0);
    expect(state.completes.at(-1)).toMatchObject({ status: "FAILED" });

    const before = state.uploads.length;
    state.failUploads = false;
    const flushed = await runner.flushQueue();

    expect(flushed.remaining).toBe(0);
    expect(state.uploads.length).toBeGreaterThan(before);
    expect(flushed.accepted).toBe(failed.recordsSent);
  }, 180_000);
});
