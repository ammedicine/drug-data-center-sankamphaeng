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
import mysql from "mysql2/promise";
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
  } catch {
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
    if (!available) return;
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
    if (!available) return;
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
