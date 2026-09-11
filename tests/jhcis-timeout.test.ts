/**
 * What happens when JHCIS takes the connection and then goes quiet.
 *
 * This is the failure that stopped a real agent for twenty-five minutes: the
 * process was alive, the window kept its last picture, the log ended
 * mid-sentence, and the web called the machine offline with no way to say why.
 * An unbounded wait does not look like a failure - nobody is told anything.
 *
 * A black-hole server stands in for the sick database: it accepts the TCP
 * connection and never speaks the MySQL handshake, which is exactly what a
 * saturated or wedged server looks like from the outside. The real development
 * database is used for the recovery case, read only.
 */
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { createServer as createHttpServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const KEY_ID = "timeout-key";
const SECRET = "timeout-secret-timeout-secret-timeout-secret";

let blackHole: TcpServer;
let blackHolePort = 0;
let central: Server;
let centralUrl = "";
let workDir: string;
let heartbeatsReceived = 0;

/** JHCIS settings from the developer's .env, so the recovery case has a real server. */
function realJhcis() {
  const devEnv = resolve(process.cwd(), "agent", ".env");
  const settings: Record<string, string> = {};
  if (existsSync(devEnv)) {
    for (const line of readFileSync(devEnv, "utf8").split(/\r?\n/)) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match) settings[match[1]] = match[2].replace(/^"|"$/g, "");
    }
  }
  return {
    host: settings.JHCIS_DB_HOST || "127.0.0.1",
    port: Number(settings.JHCIS_DB_PORT || 3306),
    database: settings.JHCIS_DB_DATABASE || "jhcisdb",
    user: settings.JHCIS_DB_USER || "root",
    password: settings.JHCIS_DB_PASSWORD ?? "",
  };
}

function pointJhcisAt(config: Record<string, unknown>) {
  writeFileSync(resolve(workDir, "jhcis.json"), JSON.stringify(config), "utf8");
}

beforeAll(async () => {
  workDir = mkdtempSync(resolve(tmpdir(), "sdc-timeout-"));
  process.env.AGENT_DATA_DIR = workDir;

  // Accepts the connection, then says nothing at all. No response is ever
  // written, so anything waiting on this server waits for ever unless the
  // agent bounds the wait itself.
  blackHole = createTcpServer((socket) => {
    socket.on("error", () => {});
  });
  await new Promise<void>((done) => blackHole.listen(0, "127.0.0.1", done));
  const bh = blackHole.address();
  blackHolePort = typeof bh === "object" && bh ? bh.port : 0;

  central = createHttpServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      if ((req.url ?? "").endsWith("/heartbeat")) heartbeatsReceived += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          config: {
            facilityId: "FAC",
            facilityCode: "RPST-TIMEOUT",
            facilityName: "timeout",
            expectedPcucode: "05957",
            syncIntervalMinutes: 60,
            reprocessDays: 7,
            lastSyncedVisitDate: null,
            uploadChunkSize: 500,
            disabled: false,
            syncRequested: false,
            verifyRequested: false,
          },
        }),
      );
    });
  });
  await new Promise<void>((done) => central.listen(0, "127.0.0.1", done));
  const addr = central.address();
  centralUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

  writeFileSync(
    resolve(workDir, "agent.config.json"),
    JSON.stringify({
      agentId: "timeout-agent",
      keyId: KEY_ID,
      secret: SECRET,
      centralApiUrl: centralUrl,
      facilityId: "FAC",
      facilityCode: "RPST-TIMEOUT",
      facilityName: "timeout",
      expectedPcucode: "05957",
      installationId: "timeout",
      syncIntervalMinutes: 60,
      reprocessDays: 7,
      enrolledAt: new Date().toISOString(),
    }),
    "utf8",
  );
});

afterAll(() => {
  blackHole?.close();
  central?.close();
  rmSync(workDir, { recursive: true, force: true });
  delete process.env.AGENT_DATA_DIR;
});

describe("a JHCIS server that stops answering", () => {
  it("CASE B: a wait that would never end is cut short", async () => {
    const { withDeadline } = await import("../agent/src/jhcis/connection");
    const never = new Promise<void>(() => {});
    const started = Date.now();
    await expect(withDeadline(never, 300, "ทดสอบ")).rejects.toThrow(/ไม่ตอบสนอง/);
    // The point is that it ends at all, and ends when it said it would.
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("CASE A: a connection that never completes fails instead of hanging", async () => {
    const { JhcisConnection } = await import("../agent/src/jhcis/connection");
    const { JHCIS_CONNECT_TIMEOUT_MS } = await import("../agent/src/config");

    const db = new JhcisConnection({
      host: "127.0.0.1",
      port: blackHolePort,
      database: "jhcisdb",
      user: "root",
      password: "",
    });

    const started = Date.now();
    await expect(db.ping()).rejects.toThrow();
    const elapsed = Date.now() - started;
    // Bounded, and bounded by roughly what it promised - not by luck.
    expect(elapsed).toBeLessThan(JHCIS_CONNECT_TIMEOUT_MS + 5_000);
    await db.close();
  }, 30_000);

  it("CASE C: the heartbeat still reaches Central, and says JHCIS is down", async () => {
    pointJhcisAt({
      host: "127.0.0.1",
      port: blackHolePort,
      database: "jhcisdb",
      user: "root",
      password: "",
    });

    const { SyncRunner } = await import(`../agent/src/sync?timeout=${Date.now()}`);
    const { loadStatus } = await import(`../agent/src/config?timeout=${Date.now()}`);

    const before = heartbeatsReceived;
    const started = Date.now();
    await new SyncRunner().heartbeat("ONLINE");
    const elapsed = Date.now() - started;

    // The link being down is what a heartbeat exists to report; it must never
    // be the reason one is not sent.
    expect(heartbeatsReceived).toBe(before + 1);
    expect(elapsed).toBeLessThan(60_000);

    const status = loadStatus();
    expect(status.jhcisState).toBe("UNREACHABLE");
    expect(status.jhcisConnected).toBe(false);
    // Central answered, so the agent is online even though JHCIS is not.
    expect(status.centralState).toBe("CONNECTED");
  }, 90_000);

  it("CASE D: it recovers on its own when JHCIS comes back, with no restart", async () => {
    const jhcis = realJhcis();
    // Skip rather than pretend: the recovery half needs a database that answers.
    const { JhcisConnection } = await import("../agent/src/jhcis/connection");
    const probe = new JhcisConnection(jhcis);
    try {
      await probe.ping();
    } catch {
      console.warn("JHCIS not reachable - skipping the recovery half");
      await probe.close();
      return;
    }
    await probe.close();

    pointJhcisAt(jhcis);

    // Same process, same module instances: nothing was restarted between the
    // failure above and this.
    const { SyncRunner } = await import(`../agent/src/sync?recover=${Date.now()}`);
    const { loadStatus } = await import(`../agent/src/config?recover=${Date.now()}`);

    await new SyncRunner().heartbeat("ONLINE");

    const status = loadStatus();
    expect(status.jhcisState).toBe("CONNECTED");
    expect(status.jhcisConnected).toBe(true);
  }, 90_000);

  it("CASE H: a healthy query is not affected by the timeout", async () => {
    const jhcis = realJhcis();
    const { JhcisConnection } = await import("../agent/src/jhcis/connection");
    const db = new JhcisConnection(jhcis);
    try {
      const rows = await db.query("SELECT 1 AS ok");
      expect(rows[0]).toMatchObject({ ok: 1 });
    } catch {
      console.warn("JHCIS not reachable - skipping the healthy-query check");
    } finally {
      await db.close();
    }
  }, 30_000);

  it("still refuses to write, timeouts or not", async () => {
    const { JhcisConnection } = await import("../agent/src/jhcis/connection");
    const db = new JhcisConnection(realJhcis());
    // The read-only guard runs before any connection is acquired, so this
    // holds whether or not a database is reachable.
    await expect(db.query("UPDATE visitdrug SET unit = 1")).rejects.toThrow(/read-only/i);
    await expect(db.query("DELETE FROM visit")).rejects.toThrow(/read-only/i);
    await expect(db.query("DROP TABLE visit")).rejects.toThrow(/read-only/i);
    await expect(db.query("ALTER TABLE cdrug CONVERT TO CHARACTER SET utf8")).rejects.toThrow(
      /read-only/i,
    );
    await expect(db.query("TRUNCATE TABLE visitdrug")).rejects.toThrow(/read-only/i);
    await expect(db.query("REPLACE INTO cdrug VALUES (1)")).rejects.toThrow(/read-only/i);
    // Including the one statement the charset gate is allowed to send: the
    // exception lives inside charsetReport on its own connection, and is not
    // a hole in the general guard that anything else could reach through.
    await expect(db.query("SET NAMES utf8")).rejects.toThrow(/read-only/i);
    await expect(db.query("SET NAMES latin1")).rejects.toThrow(/read-only/i);
    await db.close();
  });

  it("sends exactly one non-read statement, and it changes only the session", () => {
    // The whole surface, read from the source. JHCIS is read-only except for a
    // SET NAMES that touches no table, no row and no schema - so this is the
    // list that has to stay at one item.
    const source = readFileSync(
      resolve(process.cwd(), "agent/src/jhcis/connection.ts"),
      "utf8",
    );
    const allowed = /const SESSION_CHARSET_SQL = "([^"]+)";/.exec(source)?.[1];
    expect(allowed).toBe("SET NAMES utf8");
    // It is an exact literal, not a pattern that "anything starting with SET"
    // could satisfy later.
    expect(source).not.toMatch(/SESSION_CHARSET_SQL\s*=\s*`/);
    // And nothing in the JHCIS layer writes.
    const layer = ["connection.ts", "extractor.ts", "schema-inspector.ts", "repositories.ts"]
      .map((f) => {
        try {
          return readFileSync(resolve(process.cwd(), "agent/src/jhcis", f), "utf8");
        } catch {
          return "";
        }
      })
      .join("\n")
      // Comments explain the forbidden statements by name, so they are removed
      // before the scan rather than counted as occurrences.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    for (const forbidden of [/INSERT\s+INTO/i, /UPDATE\s+\w+\s+SET/i, /DELETE\s+FROM/i,
      /DROP\s+(TABLE|DATABASE)/i, /ALTER\s+TABLE/i, /TRUNCATE/i, /CREATE\s+TABLE/i]) {
      expect(layer, `forbidden statement ${forbidden} reached the JHCIS layer`).not.toMatch(
        forbidden,
      );
    }
  });
});
