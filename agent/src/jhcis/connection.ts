/**
 * JHCISDB connection.
 *
 * READ-ONLY by construction: every statement goes through query(), which
 * refuses anything that is not SELECT / SHOW / DESCRIBE. The agent must never
 * modify the source database (JHCIS_INTEGRATION, final instruction).
 */
import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";

import { jhcisConfig, type JhcisConfig } from "../config";
import { log } from "../logger";

const READ_ONLY = /^\s*(select|show|describe|desc|explain)\b/i;

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
        // JHCIS stores Thai text as UTF-8 even on utf8-declared columns
        charset: "utf8mb4_general_ci",
        dateStrings: true,
        timezone: "local",
        supportBigNumbers: true,
      });
    }
    return this.pool;
  }

  /** Runs a read-only statement. Throws on any write attempt. */
  async query<T extends RowDataPacket = RowDataPacket>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    if (!READ_ONLY.test(sql)) {
      throw new Error(`Refusing non read-only statement against JHCISDB: ${sql.slice(0, 60)}`);
    }
    const [rows] = await this.getPool().query<T[]>(sql, params);
    return rows;
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

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      log.debug("JHCIS connection closed");
    }
  }
}
