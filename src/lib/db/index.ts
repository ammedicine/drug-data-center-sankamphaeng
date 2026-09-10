import { readFileSync } from "node:fs";

import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";

import * as schema from "./schema";

declare global {
  // eslint-disable-next-line no-var
  var __centralPool: mysql.Pool | undefined;
  // eslint-disable-next-line no-var
  var __centralDb: MySql2Database<typeof schema> | undefined;
}

function createPool(): mysql.Pool {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env and point it at TiDB Cloud.",
    );
  }

  // TiDB Cloud requires TLS, and this connection carries every patient-free
  // but facility-identifying row in the system, so the encryption is not left
  // to the connection string: a URL that tries to turn off certificate
  // verification is refused rather than quietly honoured.
  if (/ssl=/i.test(url) && /rejectUnauthorized["'\s:=]+false/i.test(decodeURIComponent(url))) {
    throw new Error(
      "DATABASE_URL disables TLS certificate verification. Remove rejectUnauthorized=false; " +
        "TiDB Cloud presents a publicly trusted certificate and does not need it.",
    );
  }

  return mysql.createPool({
    uri: url,
    // A report page fires up to eight aggregates at once; a pool smaller than
    // that turns the tail of them into a queue and adds a full query's latency
    // to the page for no reason.
    connectionLimit: Number(process.env.DATABASE_POOL_SIZE ?? 10),
    enableKeepAlive: true,
    timezone: "Z",
    charset: "utf8mb4_general_ci",
    // Verified TLS 1.2+, always. A CA bundle may be added; nothing may weaken
    // this. rejectUnauthorized stays true in every branch below, which is the
    // property that matters - DATABASE_CA_FILE can only ever make the trust
    // store larger, never turn verification off.
    ssl: {
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
      ...(extraCertificateAuthority() ? { ca: extraCertificateAuthority() } : {}),
    },
  });
}

/**
 * An additional CA to trust, for a server that is not TiDB Cloud.
 *
 * The release gates run the real service against a real MySQL, and MySQL 8.4
 * generates its own self-signed CA on first start. Without this, proving those
 * queries against a real database would mean either turning verification off -
 * never - or not proving them at all, which is how a column that exists in
 * schema.ts and not in the database reaches production.
 *
 * Unset in production, where TiDB Cloud presents a publicly trusted
 * certificate and Node's own store is the right answer.
 */
function extraCertificateAuthority(): string | undefined {
  const path = process.env.DATABASE_CA_FILE;
  if (!path) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `DATABASE_CA_FILE points at ${path}, which could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Lazily created: the build must not need a database connection, and Vercel
 * reuses the instance across warm invocations.
 */
function getDb(): MySql2Database<typeof schema> {
  if (!global.__centralDb) {
    global.__centralPool ??= createPool();
    global.__centralDb = drizzle(global.__centralPool, { schema, mode: "default" });
  }
  return global.__centralDb;
}

/** Proxy so `db.select(...)` connects on first use, not on import. */
export const db: MySql2Database<typeof schema> = new Proxy({} as MySql2Database<typeof schema>, {
  get(_target, property, receiver) {
    return Reflect.get(getDb(), property, receiver);
  },
});

export { schema };
export type Database = MySql2Database<typeof schema>;
