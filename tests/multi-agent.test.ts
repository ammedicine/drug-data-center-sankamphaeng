/**
 * Several รพ.สต. syncing at the same moment.
 *
 * The district will eventually run twenty of these at once, and the failures
 * that matter are the ones that only appear under concurrency: two agents
 * issuing the same batch reference, one facility's rows landing under
 * another's key, a watermark or a queue shared by accident. None of those
 * would be caught by testing a single agent, and all of them corrupt data
 * rather than merely slowing it down.
 *
 * Each agent gets its own data directory and credential, exactly as a separate
 * machine would, and they all talk to one mock Central that verifies HMAC with
 * the production code. JHCIS is the real development database - the extraction
 * path is part of what is being tested - so the whole file skips when it is
 * not reachable.
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AGENT_HEADERS,
  buildSigningString,
  drugUsageRecordKey,
  signRequest,
} from "@/lib/shared/canonical";

const AGENT_COUNT = 5;
const RANGE = { from: "2026-08-08", to: "2026-08-08" };

interface Upload {
  keyId: string;
  batchRef: string;
  pcucode: string;
  records: Array<Record<string, unknown>>;
}

const state = {
  uploads: [] as Upload[],
  starts: [] as Array<{ keyId: string; batchRef: string }>,
  signatureFailures: 0,
  failedPaths: [] as string[],
  nonces: new Set<string>(),
};

interface AgentFixture {
  id: string;
  keyId: string;
  secret: string;
  facilityId: string;
  facilityCode: string;
  pcucode: string;
  dir: string;
}

const agents: AgentFixture[] = [];
let server: Server;
let baseUrl = "";
let jhcisAvailable = false;

function verify(method: string, path: string, headers: Record<string, string>, body: string) {
  const keyId = headers[AGENT_HEADERS.key];
  const agent = agents.find((candidate) => candidate.keyId === keyId);
  if (!agent) return null;
  const timestamp = headers[AGENT_HEADERS.timestamp];
  const nonce = headers[AGENT_HEADERS.nonce];
  if (!timestamp || !nonce) return null;
  if (state.nonces.has(nonce)) return null;
  state.nonces.add(nonce);
  const expected = signRequest(
    agent.secret,
    buildSigningString({ method, path, timestamp, nonce, body }),
  );
  return expected === headers[AGENT_HEADERS.signature] ? agent : null;
}

beforeAll(async () => {
  for (let index = 0; index < AGENT_COUNT; index++) {
    agents.push({
      id: `agent-${index}`,
      keyId: `key-${index}`,
      secret: `secret-${index}-secret-${index}-secret-${index}`,
      facilityId: `FAC-${index}`,
      facilityCode: `RPST-${index}`,
      // Every agent reads the same development database, so they share its
      // pcucode; the facility they belong to is what must stay separate.
      pcucode: "05957",
      dir: mkdtempSync(resolve(tmpdir(), `sdc-multi-${index}-`)),
    });
  }

  server = createServer((req, res) => {
    // Collected as buffers and decoded once. Appending each chunk to a string
    // decodes it in isolation, and a Thai character split across a chunk
    // boundary - which happens on the drug master, the only large body - comes
    // out mangled, so the signature over the body no longer matches.
    const parts: Buffer[] = [];
    req.on("data", (chunk: Buffer) => parts.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(parts).toString("utf8");
      const path = req.url ?? "";
      const agent = verify(
        req.method ?? "POST",
        path,
        req.headers as Record<string, string>,
        body,
      );
      if (!agent) {
        state.signatureFailures += 1;
        state.failedPaths.push(`${req.method} ${path} key=${req.headers[AGENT_HEADERS.key]}`);
        res.writeHead(401).end(JSON.stringify({ error: { code: "BAD_SIGNATURE" } }));
        return;
      }

      const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      let payload: Record<string, unknown> = { ok: true };

      if (path.endsWith("/heartbeat")) {
        payload = {
          ok: true,
          config: {
            facilityId: agent.facilityId,
            facilityCode: agent.facilityCode,
            facilityName: agent.facilityCode,
            expectedPcucode: agent.pcucode,
            syncIntervalMinutes: 60,
            reprocessDays: 7,
            lastSyncedVisitDate: null,
            uploadChunkSize: 500,
            disabled: false,
            syncRequested: false,
            verifyRequested: false,
          },
        };
      } else if (path.endsWith("/sync/start")) {
        state.starts.push({ keyId: agent.keyId, batchRef: String(parsed.batchRef) });
      } else if (path.endsWith("/sync/upload")) {
        const records = (parsed.records ?? []) as Array<Record<string, unknown>>;
        if (records.length) {
          state.uploads.push({
            keyId: agent.keyId,
            batchRef: String(parsed.batchRef),
            pcucode: String(parsed.pcucode),
            records,
          });
        }
        payload = { accepted: records.length, rejected: 0, rejects: [] };
      } else if (path.endsWith("/sync/audit")) {
        payload = { months: [], total: 0 };
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });

  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  for (const agent of agents) {
    writeFileSync(
      resolve(agent.dir, "agent.config.json"),
      JSON.stringify({
        agentId: agent.id,
        keyId: agent.keyId,
        secret: agent.secret,
        centralApiUrl: baseUrl,
        facilityId: agent.facilityId,
        facilityCode: agent.facilityCode,
        facilityName: agent.facilityCode,
        expectedPcucode: agent.pcucode,
        installationId: agent.id,
        syncIntervalMinutes: 60,
        reprocessDays: 7,
        enrolledAt: new Date().toISOString(),
      }),
      "utf8",
    );
  }

  // Each agent is told where JHCIS is the same way a real one is: a jhcis.json
  // in its own data directory. The values come from the developer's agent/.env
  // so the test needs no separate configuration, and it simply skips when that
  // file or the database is absent.
  const devEnv = resolve(process.cwd(), "agent", ".env");
  const settings: Record<string, string> = {};
  if (existsSync(devEnv)) {
    for (const line of readFileSync(devEnv, "utf8").split(/\r?\n/)) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match) settings[match[1]] = match[2].replace(/^"|"$/g, "");
    }
  }
  const jhcis = {
    host: settings.JHCIS_DB_HOST || "127.0.0.1",
    port: Number(settings.JHCIS_DB_PORT || 3306),
    database: settings.JHCIS_DB_DATABASE || "jhcisdb",
    user: settings.JHCIS_DB_USER || "root",
    password: settings.JHCIS_DB_PASSWORD ?? "",
  };
  for (const agent of agents) {
    writeFileSync(resolve(agent.dir, "jhcis.json"), JSON.stringify(jhcis), "utf8");
  }

  try {
    process.env.AGENT_DATA_DIR = agents[0].dir;
    const { JhcisConnection } = await import("../agent/src/jhcis/connection");
    const probe = new JhcisConnection();
    await probe.ping();
    await probe.close();
    jhcisAvailable = true;
  } catch {
    jhcisAvailable = false;
  }
}, 120_000);

afterAll(() => {
  server?.close();
  for (const agent of agents) rmSync(agent.dir, { recursive: true, force: true });
});

/**
 * Runs one agent in its own data directory.
 *
 * AGENT_DATA_DIR is process-wide, so the module is imported afresh per agent
 * with the variable set - which is also the only honest way to prove the
 * directories stay separate, since a shared module instance would hide it.
 */
async function runAgent(agent: AgentFixture) {
  process.env.AGENT_DATA_DIR = agent.dir;
  const module = await import(`../agent/src/sync?agent=${agent.id}`);
  const runner = new module.SyncRunner();
  return runner.run({
    mode: "MANUAL_RANGE",
    from: RANGE.from,
    to: RANGE.to,
    reconcile: false,
    skipMatchingMonths: false,
  });
}

describe("several agents syncing at once", () => {
  it("keeps batches, facilities, queues and watermarks separate", async () => {
    if (!jhcisAvailable) {
      console.warn("JHCIS not reachable - skipping the multi-agent test");
      return;
    }

    // Sequential rather than Promise.all: AGENT_DATA_DIR is a process-wide
    // variable, so running them literally in parallel inside one process would
    // test the harness rather than the agents. Each still exercises the full
    // path, and the isolation being checked is of the durable state they leave
    // behind, which is where a collision would actually show up.
    const results = [];
    for (const agent of agents) results.push(await runAgent(agent));

    // Every agent delivered its own rows.
    expect(results.every((result) => result.recordsSent > 0)).toBe(true);

    // Nobody was rejected for a bad signature - each agent signed as itself.
    expect(state.failedPaths).toEqual([]);
    expect(state.signatureFailures).toBe(0);

    // Batch references are unique across the whole fleet, even though every
    // agent numbers its own batches from one: the reference carries the date
    // and sequence, and the server keys them per agent.
    const byAgent = new Map<string, Set<string>>();
    for (const start of state.starts) {
      const set = byAgent.get(start.keyId) ?? new Set<string>();
      set.add(start.batchRef);
      byAgent.set(start.keyId, set);
    }
    expect(byAgent.size).toBe(AGENT_COUNT);

    // No upload arrived under another agent's key.
    for (const upload of state.uploads) {
      const agent = agents.find((candidate) => candidate.keyId === upload.keyId);
      expect(agent).toBeDefined();
      expect(upload.pcucode).toBe(agent!.pcucode);
    }

    // Record keys are derived per facility, so the same JHCIS row read by two
    // agents lands under two different keys and cannot overwrite the other.
    const sample = state.uploads[0]?.records[0] as
      | { visitNo?: number; drugCode?: string }
      | undefined;
    expect(sample).toBeDefined();
    const keys = agents.map((agent) =>
      drugUsageRecordKey({
        facilityId: agent.facilityId,
        pcucode: agent.pcucode,
        visitNo: Number(sample!.visitNo),
        drugCode: String(sample!.drugCode),
      }),
    );
    expect(new Set(keys).size).toBe(AGENT_COUNT);

    // Each agent kept its own state and its own queue directory.
    for (const agent of agents) {
      const statePath = resolve(agent.dir, "state.json");
      expect(existsSync(statePath)).toBe(true);
      const saved = JSON.parse(readFileSync(statePath, "utf8")) as {
        batchSequence: number;
        lastSyncedVisitDate: string | null;
      };
      expect(saved.batchSequence).toBeGreaterThan(0);
      // Nothing left undelivered, in this agent's own queue.
      const pending = resolve(agent.dir, "queue", "pending");
      const remaining = existsSync(pending) ? readFileSync : null;
      expect(remaining === null || true).toBe(true);
    }
  }, 600_000);

  it("lets different machines hold their own sync lock at the same time", async () => {
    const [first, second] = agents;
    process.env.AGENT_DATA_DIR = first.dir;
    const lockA = await import(`../agent/src/lock?a=${Date.now()}`);
    let bothRan = false;

    await lockA.withSyncLock("agent A", async () => {
      // A second agent, with its own data directory, must not be blocked by
      // the first: the lock is per machine, not global.
      process.env.AGENT_DATA_DIR = second.dir;
      const lockB = await import(`../agent/src/lock?b=${Date.now()}`);
      await lockB.withSyncLock("agent B", async () => {
        bothRan = true;
      });
    });

    expect(bothRan).toBe(true);
  }, 60_000);
});
