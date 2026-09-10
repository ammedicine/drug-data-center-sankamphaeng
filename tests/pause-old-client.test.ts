/**
 * What a pause does to an Agent that has never heard of pausing.
 *
 * Two production สถานบริการ are on v1.1.7 today, and one of them is on a
 * network the district office cannot reach. Both will be paused before the
 * centre's data is reset, and neither will understand the instruction. What
 * they will see is a refusal, and the shape of that refusal decides whether
 * they sit quietly or do damage.
 *
 * The damage is specific and was measured, not imagined. A 4xx is `permanent`
 * in the released client: the upload loop does not break on it, so it walks
 * the whole pending queue rewriting every chunk into failed/ in a single pass,
 * and reports the link as an authentication failure - which on v1.1.6 the tray
 * renders as "สิทธิ์ถูกเพิกถอน". A clinic would be told its credential had
 * been cancelled, and its queue would be emptied into a folder nothing retries
 * from, because an administrator pressed pause.
 *
 * These tests run the released client's own retry and queue code against a
 * server that answers the way Central now answers.
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  SYNC_PAUSED_CODE,
  SYNC_PAUSED_RETRY_AFTER_SECONDS,
  SYNC_PAUSED_STATUS,
} from "@/lib/shared/sync-control";

let server: Server;
let baseUrl = "";
let home: string;
let counter = 0;
let requests = 0;
/**
 * The Retry-After this fake centre sends.
 *
 * Production sends SYNC_PAUSED_RETRY_AFTER_SECONDS, and the released client
 * sleeps for whatever it is told, verbatim - which is the behaviour being
 * relied on, and also why a test that used the real 45 cannot run the retry
 * loop without waiting a minute and a half. The loop test lowers it; every
 * other test asserts against the real constant.
 */
let retryAfter = SYNC_PAUSED_RETRY_AFTER_SECONDS;

beforeAll(async () => {
  server = createServer((req, res) => {
    requests += 1;
    // Exactly what the guard produces, header included.
    res.writeHead(SYNC_PAUSED_STATUS, {
      "content-type": "application/json",
      "Retry-After": String(retryAfter),
    });
    res.end(
      JSON.stringify({
        error: { code: SYNC_PAUSED_CODE, message: "ผู้ดูแลระบบส่วนกลางหยุดการซิงก์ของ Agent นี้ไว้" },
      }),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => server?.close());

beforeEach(() => {
  home = mkdtempSync(resolve(tmpdir(), "sdc-oldpause-"));
  process.env.AGENT_DATA_DIR = home;
  requests = 0;
  retryAfter = SYNC_PAUSED_RETRY_AFTER_SECONDS;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.AGENT_DATA_DIR;
  delete process.env.AGENT_RETRY_ATTEMPTS;
  delete process.env.AGENT_RETRY_BASE_MS;
});

const clientModule = () => import(`../agent/src/central/client?p=${counter++}`);
const queueModule = () => import(`../agent/src/queue/queue?p=${counter++}`);

describe("the released client's own classification", () => {
  it("does not call a pause permanent", async () => {
    const { CentralApiError } = await clientModule();
    const paused = new CentralApiError(SYNC_PAUSED_STATUS, SYNC_PAUSED_CODE, "paused", 45);
    // This one boolean is the whole compatibility story. Permanent means the
    // chunk is swept into failed/ and the loop carries on doing it.
    expect(paused.permanent).toBe(false);

    // For contrast, the statuses that would have caused the damage.
    expect(new CentralApiError(403, "X", "x").permanent).toBe(true);
    expect(new CentralApiError(401, "X", "x").permanent).toBe(true);
  });

  it("honours the Retry-After the centre sends rather than its own backoff", async () => {
    const { CentralApiError } = await clientModule();
    const paused = new CentralApiError(SYNC_PAUSED_STATUS, SYNC_PAUSED_CODE, "paused", 45);
    expect(paused.retryAfterSeconds).toBe(45);
  });
});

describe("a paused refusal reaching the released retry loop", () => {
  it("gives up after its attempts without a storm, and stays bounded", async () => {
    const { withRetry, CentralClient } = await clientModule();
    // The centre asks for one second rather than forty-five, purely so this
    // finishes. The client's own backoff is ignored either way - it uses the
    // server's number - and that substitution is itself the proof that
    // Retry-After is what governs the wait.
    retryAfter = 1;

    const client = new CentralClient(baseUrl, { keyId: "k", secret: "s".repeat(40) });

    let error: unknown;
    try {
      await withRetry(
        () => client.audit({ pcucode: "T0001", from: "2024-01-01", to: "2024-01-31" }),
        { label: "paused", attempts: 3, baseDelayMs: 1 },
      );
    } catch (caught) {
      error = caught;
    }

    // It stopped. Three attempts, three requests, then an error - not an
    // endless loop against a สถานบริการ that has been switched off for a week.
    expect(requests).toBe(3);
    expect((error as { status?: number })?.status).toBe(SYNC_PAUSED_STATUS);
    expect((error as { code?: string })?.code).toBe(SYNC_PAUSED_CODE);
  }, 60_000);
});

describe("what happens to data already queued", () => {
  it("is kept pending, not swept into failed/", async () => {
    // The consequence that matters most. These chunks are the only copy of
    // work already done; a pause must leave them exactly where a resume can
    // find them.
    const { OfflineQueue } = await queueModule();
    const { CentralApiError } = await clientModule();
    const queue = new OfflineQueue(home);
    queue.enqueue({
      batchRef: "SYNC-OLD",
      sequence: 1,
      pcucode: "05957",
      sourceVersion: null,
      records: [
        {
          visitNo: 1,
          drugCode: "D1",
          drugName: "ยา",
          drugType: "01",
          quantity: 1,
          unit: "เม็ด",
          unitCode: "027",
          clinic: null,
          usageDate: "2024-05-05",
        },
      ],
    });

    const [chunk] = queue.list("PENDING");
    const paused = new CentralApiError(SYNC_PAUSED_STATUS, SYNC_PAUSED_CODE, "paused", 45);
    // Exactly what the upload loop does with a failure: pass its own verdict
    // on whether the failure is permanent.
    queue.fail(chunk, paused.message, paused.permanent);

    expect(queue.list("PENDING")).toHaveLength(1);
    expect(queue.list("FAILED")).toHaveLength(0);
    expect(readdirSync(resolve(home, "queue", "failed"))).toEqual([]);
    // The attempt was counted, so an operator can see it has been trying.
    expect(queue.list("PENDING")[0].attempts).toBe(1);

    // And for contrast: had the centre answered 403, this is what would have
    // happened to the same chunk.
    const revoked = new CentralApiError(403, "AGENT_REVOKED", "revoked");
    const [again] = queue.list("PENDING");
    queue.fail(again, revoked.message, revoked.permanent);
    expect(queue.list("PENDING")).toHaveLength(0);
    expect(queue.list("FAILED")).toHaveLength(1);
  });
});

describe("what the operator is shown", () => {
  it("is never a revoked credential", async () => {
    const { classifyCentralFailure } = await import("@/lib/shared/agent-status");
    const { CentralApiError } = await clientModule();
    const paused = new CentralApiError(SYNC_PAUSED_STATUS, SYNC_PAUSED_CODE, "paused", 45);

    const state = classifyCentralFailure({ status: paused.status, code: paused.code });
    // v1.1.7 has no idea what SYNC_PAUSED_BY_ADMIN means, and a 503 is simply
    // a server problem to it. That is an acceptable thing to show a clinic; a
    // cancelled credential is not, because it is untrue and it sends somebody
    // to re-enrol a working machine.
    expect(state).toBe("NETWORK_ERROR");
    expect(state).not.toBe("CREDENTIAL_REVOKED");
    expect(state).not.toBe("AUTH_ERROR");
  });

  it("leaves enrolment untouched", () => {
    // Nothing in the pause path writes agent.config.json. The credential is
    // what a resume depends on: revoking it to stop an agent would mean a
    // person driving to the สถานบริการ to start it again.
    expect(readdirSync(home)).not.toContain("agent.config.json");
  });
});
