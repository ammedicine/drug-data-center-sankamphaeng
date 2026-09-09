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
