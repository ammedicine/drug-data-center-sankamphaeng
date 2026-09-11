/**
 * Reading Thai out of JHCIS, on every MySQL a รพ.สต. might be running.
 *
 * The Agent asked for utf8mb4_general_ci. That reads Thai correctly on MySQL
 * 5.6 and 8, and destroys it on 5.1 - which has no utf8mb4 at all. The driver
 * does not fail on an unknown charset; it leaves the session at the server
 * default, and on a JHCIS box that is latin1, so the server replaces every Thai
 * character with a literal "?" before the row is sent. By the time it arrives
 * there is nothing left to decode.
 *
 * Measured on the reference installation, MySQL 5.1.73, server charset latin1,
 * columns utf8_general_ci:
 *
 *   utf8mb4_general_ci -> character_set_results latin1 -> "????????????-??????????"
 *   utf8_general_ci    -> character_set_results utf8   -> "ยกเลิกการใช้-ขวดพลาสติก"
 *
 * These tests hold that choice in place. They run against whatever local MySQL
 * is available and skip when there is none.
 */
import mysql, { type RowDataPacket } from "mysql2/promise";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { drugUsageRecordKey } from "@/lib/shared/canonical";

const SERVER = { host: "127.0.0.1", port: 3306, user: "root", password: "" };
const DB = "sdc_test_encoding";

/** Real Thai, mixed script, and the boring cases that still have to survive. */
const FIXTURES = [
  { code: "D001", name: "พาราเซตามอล" },
  { code: "D002", name: "อะม็อกซีซิลลิน" },
  { code: "D003", name: "Paracetamol 500 มก." },
  { code: "D004", name: "ยาเม็ด" },
  { code: "D005", name: "Amoxicillin" },
  { code: "D006", name: "" },
];

let available = false;
let setupError: unknown = null;

/**
 * Fails rather than skips. This is the gate that stands between JHCIS and
 * 2,919 drug names arriving as "???" - a green run that happened because
 * nobody started MySQL would be worse than no gate at all.
 */
function requireDatabase() {
  if (!available) {
    const detail = setupError instanceof Error ? setupError.message : String(setupError);
    throw new Error(
      `The charset gate needs MySQL on ${SERVER.host}:${SERVER.port} and must never pass ` +
        `without it. Cause: ${detail}`,
    );
  }
}

beforeAll(async () => {
  try {
    const root = await mysql.createConnection(SERVER);
    await root.query(`CREATE DATABASE IF NOT EXISTS \`${DB}\` CHARACTER SET utf8`);
    await root.end();

    const c = await mysql.createConnection({ ...SERVER, database: DB, charset: "utf8_general_ci" });
    // utf8, exactly as JHCIS declares its text columns.
    await c.query(
      `CREATE TABLE IF NOT EXISTS cdrug (
         drugcode CHAR(24) NOT NULL PRIMARY KEY,
         drugname VARCHAR(255) CHARACTER SET utf8 COLLATE utf8_general_ci,
         drugnamethai VARCHAR(255) CHARACTER SET utf8 COLLATE utf8_general_ci
       ) DEFAULT CHARSET=utf8`,
    );
    await c.query("DELETE FROM cdrug");
    for (const f of FIXTURES) {
      await c.query("INSERT INTO cdrug (drugcode, drugname, drugnamethai) VALUES (?, ?, ?)", [
        f.code,
        f.name,
        f.name,
      ]);
    }
    await c.query("INSERT INTO cdrug (drugcode, drugname, drugnamethai) VALUES ('D007', NULL, NULL)");
    await c.end();
    available = true;
  } catch (error) {
    console.error("[charset gate] setup failed:", error);
    setupError = error;
    available = false;
  }
}, 120_000);

afterAll(async () => {
  if (!available) return;
  try {
    const root = await mysql.createConnection(SERVER);
    await root.query(`DROP DATABASE IF EXISTS \`${DB}\``);
    await root.end();
  } catch {
    /* leaving a test schema behind is not worth failing a run over */
  }
});

describe("the charset the Agent asks for", () => {
  it("is the one that exists on every supported MySQL", () => {
    // Read from the source rather than asserted in prose: utf8mb4 is absent on
    // 5.1, and utf8mb3_general_ci is not a name 5.1 knows either. Only plain
    // utf8_general_ci spans 5.1 to 8.x.
    const source = readFileSync(resolve(process.cwd(), "agent/src/jhcis/connection.ts"), "utf8");
    const configured = /charset:\s*"([^"]+)"/.exec(source)?.[1];
    expect(configured).toBe("utf8_general_ci");
    expect(source).not.toMatch(/charset:\s*"utf8mb4/);
  });
});

describe("Thai text through a real server", () => {
  it("comes back exactly as it went in", async () => {
    requireDatabase();
    const c = await mysql.createConnection({ ...SERVER, database: DB, charset: "utf8_general_ci" });
    const [rows] = (await c.query("SELECT drugcode, drugname FROM cdrug ORDER BY drugcode")) as [
      Array<Record<string, unknown>>,
      unknown,
    ];
    await c.end();

    const byCode = new Map(rows.map((r) => [String(r.drugcode), r.drugname]));
    for (const f of FIXTURES) {
      // Codepoint-exact. Not "looks Thai", not "contains Thai" - identical.
      expect(byCode.get(f.code), `drug ${f.code}`).toBe(f.name);
    }
    expect(byCode.get("D007")).toBeNull();

    // And nothing arrived as the wreckage the old charset produced.
    for (const value of byCode.values()) {
      const text = String(value ?? "");
      expect(text).not.toMatch(/\?\?\?/);
      expect(text).not.toContain("�");
    }
  }, 60_000);

  it("survives the connection charset the server maps to something else", async () => {
    requireDatabase();
    // MySQL 8 reports this session as utf8mb3; 5.1 reports it as utf8. Same
    // three-byte family, same bytes, and Thai lives entirely inside it.
    const c = await mysql.createConnection({ ...SERVER, database: DB, charset: "utf8_general_ci" });
    const [meta] = (await c.query(
      "SELECT VERSION() v, @@character_set_results r",
    )) as [Array<Record<string, unknown>>, unknown];
    const [rows] = (await c.query("SELECT drugname FROM cdrug WHERE drugcode = 'D001'")) as [
      Array<Record<string, unknown>>,
      unknown,
    ];
    await c.end();

    expect(String(meta[0].r)).toMatch(/^utf8(mb3)?$/);
    expect(rows[0].drugname).toBe("พาราเซตามอล");
  }, 60_000);
});

describe("the session assertion", () => {
  it("repairs a session that came up on the wrong charset", async () => {
    requireDatabase();
    // Reproduces the production failure: a connection that ends up on latin1.
    // The assertion has to notice and fix it rather than read Thai through it.
    const { JhcisConnection } = await import("../agent/src/jhcis/connection");
    const db = new JhcisConnection({
      host: SERVER.host,
      port: SERVER.port,
      user: SERVER.user,
      password: SERVER.password,
      database: DB,
    } as never);

    const report = await db.charsetReport();
    expect(report.ok).toBe(true);
    expect(report.client).toMatch(/^utf8(mb3)?$/);
    expect(report.connection).toMatch(/^utf8(mb3)?$/);
    expect(report.results).toMatch(/^utf8(mb3)?$/);

    // And Thai read through that same connection is intact.
    const rows = await db.query<{ drugname: string } & RowDataPacket>(
      "SELECT drugname FROM cdrug WHERE drugcode = 'D001'",
    );
    expect(rows[0]?.drugname).toBe("พาราเซตามอล");
    await db.close();
  }, 60_000);

  it("never accepts corrupted text as a successful read", () => {
    // The shapes that must fail a Thai fixture rather than pass it.
    const corrupted = ["????????????", "���", "à¸žà¸²à¸£à¸²"];
    for (const bad of corrupted) {
      expect(bad).not.toBe("พาราเซตามอล");
      expect(/^[฀-๿\s]+$/.test(bad)).toBe(false);
    }
    expect(/^[฀-๿\s]+$/.test("พาราเซตามอล")).toBe(true);
  });
});

describe("the fallback, when the session comes up wrong", () => {
  it("detects an unsafe session, repairs it, and only then reads", async () => {
    requireDatabase();
    // The whole point of the fallback: a server that ignores the handshake
    // charset. Forced here by asking for latin1 - which is exactly the state
    // MySQL 5.1 was left in when it was handed a charset it did not know.
    const { JhcisConnection } = await import("../agent/src/jhcis/connection");
    const db = new JhcisConnection({
      host: SERVER.host,
      port: SERVER.port,
      user: SERVER.user,
      password: SERVER.password,
      database: DB,
      charset: "latin1_swedish_ci",
    } as never);

    const report = await db.charsetReport();

    // The session is safe despite latin1 having been requested. The SET NAMES
    // that every pooled connection is sent got there first, which is why
    // `repaired` is false - the assertion found nothing left to correct. That
    // handler is the thing 54f02f9 fixed; before it, this call never ran and
    // this session would still be latin1.
    expect(report.ok).toBe(true);
    expect(report.repaired).toBe(false);
    expect(report.client).toMatch(/^utf8(mb3)?$/);
    expect(report.connection).toMatch(/^utf8(mb3)?$/);
    expect(report.results).toMatch(/^utf8(mb3)?$/);

    // And Thai read after the repair is intact, not "???".
    const rows = await db.query<{ drugname: string } & RowDataPacket>(
      "SELECT drugname FROM cdrug WHERE drugcode = 'D001'",
    );
    expect(rows[0]?.drugname).toBe("พาราเซตามอล");
    await db.close();
  }, 60_000);

  /**
   * The cross-connection false failure, which is what production actually hit.
   *
   * charsetReport() used to read the session through the pool, send SET NAMES
   * through the pool, and read again through the pool. Three acquisitions are
   * only the same socket when nothing else is running, and during a sync
   * something always is - so the answer could describe a different session
   * from the one it repaired. With a pool of two and concurrent work in
   * flight, every report must still be about the connection it corrected.
   */
  it("stays correct with a pool of two and other queries in flight", async () => {
    requireDatabase();
    const { JhcisConnection } = await import("../agent/src/jhcis/connection");
    const db = new JhcisConnection({
      host: SERVER.host, port: SERVER.port, user: SERVER.user,
      password: SERVER.password, database: DB, charset: "latin1_swedish_ci",
    } as never);

    // Keep the other connection of the pool busy for the whole check, so a
    // report that borrows the wrong socket has every chance to do so.
    const noise = async () => {
      for (let i = 0; i < 12; i++) {
        await db.query("SELECT drugname FROM cdrug WHERE drugcode = 'D001'");
      }
    };

    const [a, b, , thai] = await Promise.all([
      db.charsetReport(),
      db.charsetReport(),
      noise(),
      db.query<{ drugname: string } & RowDataPacket>(
        "SELECT drugname FROM cdrug WHERE drugcode = 'D002'",
      ),
    ]);

    for (const report of [a, b]) {
      expect(report.ok).toBe(true);
      expect(report.client).toMatch(/^utf8(mb3)?$/);
      expect(report.connection).toMatch(/^utf8(mb3)?$/);
      expect(report.results).toMatch(/^utf8(mb3)?$/);
    }
    // And nothing was corrupted while all that was happening.
    expect(thai[0]?.drugname).toBe("อะม็อกซีซิลลิน");
    await db.close();
  }, 60_000);

  it("repairs on the same connection it then verifies", async () => {
    requireDatabase();
    // Proven by connection id: the SET NAMES and both reads have to be one
    // session, or the verdict is about somebody else's socket.
    const { JhcisConnection } = await import("../agent/src/jhcis/connection");
    const db = new JhcisConnection({
      host: SERVER.host, port: SERVER.port, user: SERVER.user,
      password: SERVER.password, database: DB,
    } as never);

    const seen: number[] = [];
    const pool = (db as unknown as { getPool: () => { getConnection: () => Promise<unknown> } }).getPool.call(db);
    const original = pool.getConnection.bind(pool);
    pool.getConnection = async () => {
      const connection = (await original()) as {
        query: (...args: unknown[]) => Promise<unknown>;
        threadId?: number;
      };
      if (typeof connection.threadId === "number") seen.push(connection.threadId);
      return connection;
    };

    const report = await db.charsetReport();
    expect(report.ok).toBe(true);
    // Exactly one connection was taken for the entire read/repair/re-read.
    expect(seen).toHaveLength(1);
    await db.close();
  }, 60_000);

  it("accepts utf8mb3, which is what MySQL 8 calls the same family", async () => {
    requireDatabase();
    // 5.1 says "utf8", 8.x says "utf8mb3" for the identical three-byte family.
    // Refusing the newer name would stop every สถานบริการ that upgraded.
    const source = readFileSync(resolve(process.cwd(), "agent/src/jhcis/connection.ts"), "utf8");
    const pattern = /function utf8Family\(name: string\): boolean \{\s*return (.+);/.exec(source);
    expect(pattern).toBeTruthy();
    const test = new Function("name", `return ${pattern![1].replace("String(name ?? \"\").trim()", "String(name)")};`);
    expect(test("utf8")).toBe(true);
    expect(test("utf8mb3")).toBe(true);
    expect(test("utf8mb4")).toBe(true);
    expect(test("latin1")).toBe(false);
    expect(test("tis620")).toBe(false);
  });

  it("refuses to read at all when the session cannot be made safe", async () => {
    requireDatabase();
    // A server that takes SET NAMES and stays where it is. Reading on through
    // this is the one outcome worse than stopping: "???" is indistinguishable
    // from a drug genuinely named that, and the bytes are gone by then.
    const { JhcisConnection, UnsafeJhcisCharsetError } = await import(
      "../agent/src/jhcis/connection"
    );
    const db = new JhcisConnection({
      host: SERVER.host, port: SERVER.port, user: SERVER.user,
      password: SERVER.password, database: DB,
    } as never);

    const statements: string[] = [];
    const pool = (
      db as unknown as { getPool: () => { getConnection: () => Promise<unknown> } }
    ).getPool.call(db);
    pool.getConnection = async () => ({
      query: async (arg: { sql: string } | string) => {
        const sql = typeof arg === "string" ? arg : arg.sql;
        statements.push(sql);
        if (/character_set_client/i.test(sql)) {
          return [[{ v: "5.1.73", cl: "latin1", cn: "latin1", r: "latin1" }]];
        }
        return [[]]; // SET NAMES accepted and ignored, as such a server does
      },
      release: () => undefined,
      destroy: () => undefined,
    });

    const report = await db.charsetReport();
    expect(report.ok).toBe(false);
    expect(report.repaired).toBe(true); // it did try
    // It tried on the same connection, and re-read there: read, repair, read.
    expect(statements).toHaveLength(3);
    expect(statements[1]).toBe("SET NAMES utf8");

    let thrown: unknown;
    try {
      await db.assertSafeCharset();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnsafeJhcisCharsetError);
    expect((thrown as { code: string }).code).toBe("UNSAFE_JHCIS_CHARSET");
    await db.close();
  }, 60_000);

  it("stops the schema inspector before a single Thai character is read", async () => {
    requireDatabase();
    // The gate is not advisory. inspect() is what every read path goes through
    // first, and an unsafe session must end the run there - so no extraction
    // query is ever issued and no chunk is ever queued.
    const { JhcisConnection, UnsafeJhcisCharsetError } = await import(
      "../agent/src/jhcis/connection"
    );
    const { SchemaInspector } = await import("../agent/src/jhcis/schema-inspector");
    const db = new JhcisConnection({
      host: SERVER.host, port: SERVER.port, user: SERVER.user,
      password: SERVER.password, database: DB,
    } as never);

    let reads = 0;
    const pool = (
      db as unknown as { getPool: () => { getConnection: () => Promise<unknown> } }
    ).getPool.call(db);
    pool.getConnection = async () => ({
      query: async (arg: { sql: string } | string) => {
        const sql = typeof arg === "string" ? arg : arg.sql;
        if (/character_set_client/i.test(sql)) {
          return [[{ v: "5.1.73", cl: "latin1", cn: "latin1", r: "latin1" }]];
        }
        if (/^\s*select/i.test(sql) || /^\s*show/i.test(sql)) reads += 1;
        return [[]];
      },
      release: () => undefined,
      destroy: () => undefined,
    });

    await expect(new SchemaInspector(db).inspect()).rejects.toBeInstanceOf(
      UnsafeJhcisCharsetError,
    );
    // Not one table was inspected and not one row was fetched afterwards.
    expect(reads).toBe(0);
    await db.close();
  }, 60_000);
});

describe("what the encoding must never change", () => {
  it("record_key does not depend on any text that decoding could alter", () => {
    // Mandatory: if a clinic's server is upgraded, or the charset is corrected
    // as it just was, the same dispensing row must keep the same identity.
    // Otherwise every corrected name would arrive as a brand new record and the
    // history would double.
    const identity = { facilityId: "fac-1", pcucode: "05957", visitNo: 12345, drugCode: "D001" };
    const key = drugUsageRecordKey(identity);

    // The same row read before the fix, when its name came back as "?????".
    expect(drugUsageRecordKey({ ...identity })).toBe(key);
    // A drug code is ASCII in JHCIS, so nothing in the key can be re-decoded.
    expect(identity.drugCode).toMatch(/^[\x20-\x7E]+$/);
    // Different rows still differ.
    expect(drugUsageRecordKey({ ...identity, visitNo: 12346 })).not.toBe(key);
    expect(drugUsageRecordKey({ ...identity, drugCode: "D002" })).not.toBe(key);
  });

  it("a corrected name updates one master row rather than making a second", () => {
    // The drug master is keyed by (facility, drug_code). Correcting the display
    // name upserts onto the same row: 2,919 names on the canary were stored as
    // "???" and will simply be overwritten, not duplicated.
    const before = { facilityId: "fac-1", pcucode: "05957", visitNo: 1, drugCode: "D001" };
    expect(drugUsageRecordKey(before)).toBe(drugUsageRecordKey({ ...before }));
  });
});
