/**
 * JHCISDB connection.
 *
 * READ-ONLY by construction: every statement goes through query(), which
 * refuses anything that is not SELECT / SHOW / DESCRIBE. The agent must never
 * modify the source database (JHCIS_INTEGRATION, final instruction).
 */
import mysql, { type Pool, type PoolConnection, type RowDataPacket } from "mysql2/promise";

import {
  JHCIS_ACQUIRE_TIMEOUT_MS,
  JHCIS_CONNECT_TIMEOUT_MS,
  JHCIS_QUERY_TIMEOUT_MS,
  jhcisConfig,
  type JhcisConfig,
} from "../config";
import { log } from "../logger";

const READ_ONLY = /^\s*(select|show|describe|desc|explain)\b/i;

/**
 * The single statement allowed through that is not a read.
 *
 * It changes one setting of one session and touches no table, no row and no
 * schema - JHCIS stays read-only in every sense that matters. It is an exact
 * literal rather than a pattern, so "anything starting with SET" can never
 * become allowed by accident.
 */
const SESSION_CHARSET_SQL = "SET NAMES utf8";

/**
 * Thrown when the session cannot be made to carry Thai.
 *
 * Reading on through it is the one outcome worse than stopping: the server
 * replaces every Thai character with "?" on its way out, so what arrives is
 * indistinguishable from a drug genuinely named that, and the original bytes
 * are gone before anything downstream could notice. Nothing is extracted and
 * nothing is uploaded after this.
 */
export class UnsafeJhcisCharsetError extends Error {
  readonly code = "UNSAFE_JHCIS_CHARSET";
  constructor(readonly report: CharsetReport) {
    super(
      "การเชื่อมต่อ JHCIS ไม่สามารถใช้ชุดอักขระ UTF-8 ได้ " +
        `(client ${report.client} / connection ${report.connection} / results ${report.results}) ` +
        "หยุดการดึงและส่งข้อมูลเพื่อป้องกันข้อความภาษาไทยเสียหาย",
    );
    this.name = "UnsafeJhcisCharsetError";
  }
}

/** Thrown when JHCIS accepted the work and then stopped answering. */
export class JhcisTimeoutError extends Error {
  constructor(stage: string, ms: number) {
    super(`JHCIS ไม่ตอบสนองภายใน ${Math.round(ms / 1000)} วินาที (${stage})`);
    this.name = "JhcisTimeoutError";
  }
}

/** Rejects if `work` has not settled in time; the caller decides what to clean up. */
export function withDeadline<T>(work: Promise<T>, ms: number, stage: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new JhcisTimeoutError(stage, ms)), ms);
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** What the session actually ended up using, whatever we asked for. */
export interface CharsetReport {
  version: string;
  client: string;
  connection: string;
  results: string;
  /** true when the session is on a UTF-8 family that can carry Thai */
  ok: boolean;
  /** set when the session had to be corrected after connecting */
  repaired: boolean;
}

/** utf8 on 5.1, utf8mb3 on 8.x - the same three-byte family, and Thai fits. */
function utf8Family(name: string): boolean {
  return /^utf8(mb3|mb4)?$/i.test(String(name ?? "").trim());
}

export class JhcisConnection {
  private pool: Pool | null = null;

  constructor(private readonly config: JhcisConfig = jhcisConfig()) {}

  private getPool(): Pool {
    if (!this.pool) {
      this.pool = mysql.createPool({
        host: this.config.host,
        port: this.config.port,
        database: this.config.database,
        user: this.config.user,
        password: this.config.password,
        connectionLimit: 2,
        // Bounded on purpose rather than left to the driver's default, so the
        // limit is visible next to the others and moves with them.
        connectTimeout: JHCIS_CONNECT_TIMEOUT_MS,
        // The connection charset, and why it is this one.
        //
        // JHCIS stores Thai as UTF-8 in utf8-declared columns. Asking for
        // utf8mb4_general_ci reads it correctly on MySQL 5.6 and 8 - and
        // silently destroys it on 5.1, which has no utf8mb4 at all. The driver
        // does not fail: the unknown charset leaves the session at the server
        // default, which on a JHCIS box is latin1, so the server replaces every
        // Thai character with a literal "?" on its way out. By the time the row
        // arrives the text is gone, and no amount of decoding brings it back.
        //
        // Measured against the reference installation (MySQL 5.1.73, server
        // charset latin1, columns utf8_general_ci):
        //   utf8mb4_general_ci -> results latin1 -> "????????????-?????????? 60 ML"
        //   utf8_general_ci    -> results utf8   -> "ยกเลิกการใช้-ขวดพลาสติก 60 ML"
        //
        // utf8_general_ci exists on every version we support: 5.1 through 8.x,
        // where it is accepted as the three-byte utf8mb3 family. JHCIS holds no
        // four-byte characters - Thai is entirely inside the basic plane - so
        // nothing is lost by not asking for utf8mb4, and a clinic on 5.1 keeps
        // working. utf8mb3_general_ci is NOT usable: 5.1 does not know that
        // name either.
        charset: "utf8_general_ci",
        dateStrings: true,
        timezone: "local",
        supportBigNumbers: true,
      });

      // Belt and braces: the handshake charset above is what a healthy server
      // honours, and this is what makes it true on one that quietly ignored it.
      // Session-scoped, valid on 5.1 through 8.x, and it writes nothing.
      this.pool.on("connection", (connection) => {
        // The pool hands out the callback-style connection here, not the
        // promise wrapper, so this takes a callback. Treating it as a promise
        // made mysql2 print a warning on every new connection and, worse, meant
        // the statement never ran - leaving the fallback to charsetReport()
        // alone, which only fixes the one connection it happens to borrow.
        //
        // Fire and forget: a server that refuses it is caught by the assertion,
        // which is where that failure belongs.
        (
          connection as unknown as { query: (sql: string, cb: () => void) => void }
        ).query("SET NAMES utf8", () => undefined);
      });
    }
    return this.pool;
  }

  /**
   * Runs a read-only statement. Throws on any write attempt.
   *
   * Both waits are bounded, because they fail differently and the driver only
   * bounds one of them. Connecting has always had a timeout; waiting for a free
   * connection has not, and neither has waiting for a server that took the
   * query and went quiet. That second case is what stopped an agent for
   * twenty-five minutes with its process still running and nothing in the log.
   *
   * A statement that times out leaves the connection mid-protocol, so it is
   * destroyed rather than released. Returning it to the pool would hand the
   * next caller a socket that is still waiting for the previous answer.
   */
  async query<T extends RowDataPacket = RowDataPacket>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    if (!READ_ONLY.test(sql)) {
      throw new Error(`Refusing non read-only statement against JHCISDB: ${sql.slice(0, 60)}`);
    }

    // If this throws, nothing was handed over and there is nothing to dispose.
    const connection: PoolConnection = await withDeadline(
      this.getPool().getConnection(),
      JHCIS_ACQUIRE_TIMEOUT_MS,
      "รอช่องเชื่อมต่อ",
    );

    let poisoned = false;
    try {
      // The driver's own inactivity timeout, so the wait ends inside mysql2
      // rather than leaving an orphaned command behind a raced promise.
      const [rows] = await connection.query<T[]>({
        sql,
        values: params,
        timeout: JHCIS_QUERY_TIMEOUT_MS,
      });
      return rows;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "PROTOCOL_SEQUENCE_TIMEOUT") {
        poisoned = true;
        log.warn("JHCIS ไม่ตอบคำสั่งภายในเวลาที่กำหนด", { statement: sql.slice(0, 60) });
        throw new JhcisTimeoutError("คำสั่ง SQL", JHCIS_QUERY_TIMEOUT_MS);
      }
      throw error;
    } finally {
      if (poisoned) connection.destroy();
      else connection.release();
    }
  }

  async queryOne<T extends RowDataPacket = RowDataPacket>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  async mysqlVersion(): Promise<string> {
    const row = await this.queryOne<RowDataPacket & { v: string }>("SELECT VERSION() AS v");
    return row?.v ?? "unknown";
  }

/**
   * Proves the session really is on a UTF-8 family before any text is read.
   *
   * Asking for a charset is not the same as getting one. MySQL 5.1 has no
   * utf8mb4, and the driver does not fail on a name it does not know - it
   * leaves the session at the server default, which on a JHCIS box is latin1,
   * and the server then replaces every Thai character with a literal "?" on its
   * way out. That is how 2,919 drug names reached the centre as "???" with the
   * original bytes already gone.
   *
   * So the option is checked rather than trusted. Every pooled connection is
   * also sent an explicit SET NAMES utf8, which is valid on 5.1 through 8.x and
   * changes only this session - it does not touch the server, the database, or
   * a single row of JHCIS.
   */
  async charsetReport(): Promise<CharsetReport> {
    // One connection for the whole check.
    //
    // This is the entire fix. The old version read the session through the
    // pool, sent SET NAMES through the pool, and read again through the pool -
    // three acquisitions that are only the same socket when nothing else is
    // running. During a sync something else is always running, so the repair
    // could land on one connection and the verification on another, and the
    // result was a report that contradicted the session it claimed to
    // describe. Worse, the repair went through query(), whose read-only guard
    // refused it outright: on a genuinely latin1 server nothing was ever
    // repaired at all.
    const connection: PoolConnection = await withDeadline(
      this.getPool().getConnection(),
      JHCIS_ACQUIRE_TIMEOUT_MS,
      "รอช่องเชื่อมต่อ",
    );

    try {
      const read = async (): Promise<Omit<CharsetReport, "ok" | "repaired">> => {
        const [rows] = await connection.query<
          (RowDataPacket & { v: string; cl: string; cn: string; r: string })[]
        >({
          sql:
            "SELECT VERSION() AS v, @@character_set_client AS cl, " +
            "@@character_set_connection AS cn, @@character_set_results AS r",
          timeout: JHCIS_QUERY_TIMEOUT_MS,
        });
        const row = rows[0];
        return {
          version: String(row?.v ?? "unknown"),
          client: String(row?.cl ?? "unknown"),
          connection: String(row?.cn ?? "unknown"),
          results: String(row?.r ?? "unknown"),
        };
      };

      let seen = await read();
      let repaired = false;

      if (!utf8Family(seen.client) || !utf8Family(seen.connection) || !utf8Family(seen.results)) {
        log.warn("การเชื่อมต่อ JHCIS ไม่ได้ใช้ชุดอักขระ UTF-8 กำลังตั้งใหม่ให้ session นี้", {
          client: seen.client,
          connection: seen.connection,
          results: seen.results,
        });
        // Session-scoped, on THIS connection, and the only form every supported
        // version accepts. It writes nothing to JHCIS.
        await connection.query({ sql: SESSION_CHARSET_SQL, timeout: JHCIS_QUERY_TIMEOUT_MS });
        // Re-read on the same socket, so the answer is about the session that
        // was just corrected rather than whichever one the pool handed back.
        seen = await read();
        repaired = true;
      }

      const ok = utf8Family(seen.client) && utf8Family(seen.connection) && utf8Family(seen.results);
      if (!ok) {
        log.error("ตั้งชุดอักขระของการเชื่อมต่อ JHCIS ไม่สำเร็จ", {
          client: seen.client,
          connection: seen.connection,
          results: seen.results,
        });
      }
      return { ...seen, ok, repaired };
    } finally {
      connection.release();
    }
  }

  /**
   * The gate every read passes before any Thai is fetched.
   *
   * Reporting an encoding problem and carrying on was never enough: a warning
   * in a schema report is read by somebody afterwards, while "?" in a drug name
   * is permanent the moment it is stored. So an unsafe session stops the run.
   */
  async assertSafeCharset(): Promise<CharsetReport> {
    const report = await this.charsetReport();
    if (!report.ok) throw new UnsafeJhcisCharsetError(report);
    return report;
  }

  async ping(): Promise<void> {
    await this.query("SELECT 1");
  }

  describe(): string {
    return `${this.config.host}:${this.config.port}/${this.config.database}`;
  }

  /**
   * Health check the heartbeat can afford to wait for.
   *
   * Bounded separately and much more tightly than a statement, because a
   * heartbeat that waits for a sick database never arrives - and "JHCIS is not
   * answering" is precisely the thing the heartbeat exists to report.
   */
  async probe(ms: number): Promise<void> {
    await withDeadline(this.ping(), ms, "ตรวจสุขภาพ JHCIS");
  }

  /**
   * Closes the pool, but never waits on it forever.
   *
   * pool.end() waits for connections to finish, and a connection waiting on a
   * server that stopped answering never finishes. Giving up and dropping the
   * reference leaks a socket the operating system will reclaim; hanging here
   * would silence the agent, which is the failure being fixed.
   */
  async close(): Promise<void> {
    if (!this.pool) return;
    const pool = this.pool;
    this.pool = null;
    try {
      await withDeadline(pool.end(), JHCIS_ACQUIRE_TIMEOUT_MS, "ปิดการเชื่อมต่อ");
      log.debug("JHCIS connection closed");
    } catch (error) {
      log.warn("ปิดการเชื่อมต่อ JHCIS ไม่สำเร็จ ปล่อยทิ้งไว้แทนการรอ", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
