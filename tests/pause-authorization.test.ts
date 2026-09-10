/**
 * Who may stop a สถานบริการ, and what the barrier actually covers.
 *
 * Two separate worries. The first is that only a SUPER_ADMIN can pause an
 * Agent, and that this is decided on the server rather than by which buttons a
 * page happens to draw - a FACILITY_ADMIN who crafts the request by hand must
 * be refused by the same code.
 *
 * The second is completeness. The barrier is only worth as much as its least
 * guarded path: one mutating endpoint that forgets to ask is one route through
 * which a paused Agent can still write, and a reset built on the barrier would
 * be built on nothing. So the guard is checked against a real paused row in a
 * real database, and every mutating entry point is checked for calling it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const SERVER = { host: "127.0.0.1", port: 3306, user: "root", password: "" };
const DB = "sdc_pause_auth";

let available = false;
let setupError: unknown = null;

function requireDatabase() {
  if (!available) {
    const detail = setupError instanceof Error ? setupError.message : String(setupError);
    throw new Error(
      `The pause-barrier gate needs MySQL on ${SERVER.host}:${SERVER.port} and a working ` +
        `fixture. It must never pass without one. Cause: ${detail}`,
    );
  }
}

beforeAll(async () => {
  try {
    const root = await mysql.createConnection(SERVER);
    await root.query(`DROP DATABASE IF EXISTS \`${DB}\``);
    await root.query(`CREATE DATABASE \`${DB}\` CHARACTER SET utf8mb4`);
    await root.end();

    process.env.DATABASE_URL = `mysql://root@127.0.0.1:3306/${DB}`;
    process.env.DATABASE_CA_FILE = "C:/laragon/data/mysql-8.4/ca.pem";

    const { drizzle } = await import("drizzle-orm/mysql2");
    const { migrate } = await import("drizzle-orm/mysql2/migrator");
    const connection = await mysql.createConnection({
      uri: process.env.DATABASE_URL,
      multipleStatements: true,
    });
    await migrate(drizzle(connection), { migrationsFolder: "./drizzle" });
    await connection.end();

    const c = await mysql.createConnection({ ...SERVER, database: DB });
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    await c.query(
      `INSERT INTO facilities (id, code, name, jhcis_pcucode, is_active, created_at, updated_at)
       VALUES ('fac-1','RPST-05957','ทดสอบ','05957',1,?,?)`,
      [now, now],
    );
    await c.query(
      `INSERT INTO agents (id, facility_id, name, status, sync_interval_minutes, reprocess_days,
         pending_batches, sync_count, failed_count, sync_control_state, control_revision,
         pause_reason, created_at, updated_at)
       VALUES ('agent-paused','fac-1','หยุดอยู่','ONLINE',60,7,0,0,0,'PAUSED',1,'เตรียมล้างข้อมูล',?,?),
              ('agent-running','fac-1','ทำงานอยู่','ONLINE',60,7,0,0,0,'RUNNING',0,NULL,?,?)`,
      [now, now, now, now],
    );
    await c.end();
    available = true;
  } catch (error) {
    console.error("[pause gate] setup failed:", error);
    setupError = error;
    available = false;
  }
}, 180_000);

afterAll(async () => {
  try {
    const root = await mysql.createConnection(SERVER);
    await root.query(`DROP DATABASE IF EXISTS \`${DB}\``);
    await root.end();
  } catch {
    /* a leftover test schema is not worth failing a run over */
  }
  delete process.env.DATABASE_URL;
  delete process.env.DATABASE_CA_FILE;
});

describe("the barrier itself", () => {
  it("refuses a paused agent and says why, without naming a credential", async () => {
    requireDatabase();
    const { assertAgentSyncAllowed, SyncPausedError } = await import(
      "@/lib/agent-auth/sync-control"
    );

    await expect(assertAgentSyncAllowed("agent-paused")).rejects.toThrow(SyncPausedError);

    let thrown: unknown;
    try {
      await assertAgentSyncAllowed("agent-paused");
    } catch (error) {
      thrown = error;
    }
    const error = thrown as { status: number; code: string; message: string; retryAfterSeconds: number };
    expect(error.status).toBe(503);
    expect(error.code).toBe("SYNC_PAUSED_BY_ADMIN");
    expect(error.retryAfterSeconds).toBe(45);
    // The operator's reason reaches the clinic, because "stopped, and here is
    // why" is a far better thing to read than an unexplained refusal.
    expect(error.message).toContain("เตรียมล้างข้อมูล");
    // And nothing about credentials, which is the message this replaced.
    expect(error.message).not.toContain("เพิกถอน");
  });

  it("lets a running agent through", async () => {
    requireDatabase();
    const { assertAgentSyncAllowed } = await import("@/lib/agent-auth/sync-control");
    await expect(assertAgentSyncAllowed("agent-running")).resolves.toBeUndefined();
  });

  it("reads the database every time, so a pause takes effect immediately", async () => {
    requireDatabase();
    const { assertAgentSyncAllowed } = await import("@/lib/agent-auth/sync-control");
    const { setAgentSyncControl } = await import("@/lib/services/fleet");

    await expect(assertAgentSyncAllowed("agent-running")).resolves.toBeUndefined();
    await setAgentSyncControl({
      agentId: "agent-running",
      desired: "PAUSED",
      actorUserId: "user-1",
      reason: null,
    });
    // No cache to invalidate and no agent to notify: the very next request is
    // refused. That immediacy is what lets an operator start a reset without
    // waiting to hear from fifteen machines.
    await expect(assertAgentSyncAllowed("agent-running")).rejects.toThrow();
  });
});

describe("every mutating path asks", () => {
  /**
   * A source check, deliberately.
   *
   * The runtime tests above prove the guard works; this proves nobody has
   * added a way around it. A new endpoint that writes dispensing data and
   * forgets the guard is the failure this catches, and it catches it at the
   * only moment it is cheap to fix.
   */
  const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

  it("is called by all three mutating routes", () => {
    for (const route of ["start", "upload", "complete"]) {
      const source = read(`src/app/api/agent/sync/${route}/route.ts`);
      expect(source, `${route} route must import the guard`).toContain(
        "assertAgentSyncAllowed",
      );
      expect(source, `${route} route must await the guard`).toMatch(
        /await assertAgentSyncAllowed\(/,
      );
    }
  });

  it("is called again inside the ingestion core", () => {
    // Defence in depth: the route is where a new endpoint forgets, the core is
    // the last place a write can be stopped.
    const source = read("src/lib/services/sync.ts");
    const calls = source.match(/await assertAgentSyncAllowed\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const fn of ["startBatch", "upsertDrugMaster", "ingestUsageRecords", "completeBatch"]) {
      const body = source.slice(source.indexOf(`export async function ${fn}`));
      expect(
        body.slice(0, 600),
        `${fn} must ask before it writes`,
      ).toContain("assertAgentSyncAllowed");
    }
  });

  it("is not called on the paths a paused agent still needs", () => {
    // Heartbeat, config and the time endpoint must keep working: an agent that
    // cannot heartbeat cannot be told to start again, and one whose clock is
    // wrong cannot authenticate at all.
    for (const path of [
      "src/app/api/agent/heartbeat/route.ts",
      "src/app/api/agent/config/route.ts",
      "src/app/api/time/route.ts",
    ]) {
      expect(read(path), `${path} must stay open while paused`).not.toContain(
        "assertAgentSyncAllowed",
      );
    }
  });
});

describe("who may press the button", () => {
  it("refuses anyone who is not a SUPER_ADMIN, on the server", async () => {
    requireDatabase();
    // The action is what a crafted request reaches - there is no separate API
    // route to bypass, and the role is re-read from the database by
    // requireApiUser rather than trusted from a token.
    vi.resetModules();
    vi.doMock("@/lib/auth/rbac", () => ({
      requireApiUser: async () => ({
        userId: "u-facility",
        email: "facility@example.test",
        role: "FACILITY_ADMIN",
        facilityId: "fac-1",
        fullName: "หัวหน้าสถานบริการ",
      }),
      isSuperAdmin: (user: { role: string }) => user.role === "SUPER_ADMIN",
      canApproveRegistration: () => false,
      canManageFacility: () => false,
      canManageUsers: () => false,
      canTriggerSync: () => false,
    }));
    vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
    vi.doMock("next/cache", () => ({ revalidatePath: () => undefined }));

    const actions = await import("@/app/(app)/admin/actions");
    const form = new FormData();
    form.set("scope", "selected");
    form.append("agentId", "agent-paused");

    const result = await actions.pauseAgentSyncAction({}, form);
    expect(result.error).toBeTruthy();
    expect(result.error).toContain("เฉพาะผู้ดูแลระบบส่วนกลาง");
    expect(result.success).toBeUndefined();

    const resumed = await actions.resumeAgentSyncAction({}, form);
    expect(resumed.error).toBeTruthy();

    vi.doUnmock("@/lib/auth/rbac");
    vi.resetModules();
  });
});
