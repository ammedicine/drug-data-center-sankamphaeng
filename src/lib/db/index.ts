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

  // TiDB Cloud requires TLS; serverless functions must keep the pool small.
  return mysql.createPool({
    uri: url,
    connectionLimit: Number(process.env.DATABASE_POOL_SIZE ?? 5),
    enableKeepAlive: true,
    timezone: "Z",
    charset: "utf8mb4_general_ci",
    ssl: url.includes("ssl=") ? undefined : { minVersion: "TLSv1.2" },
  });
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
