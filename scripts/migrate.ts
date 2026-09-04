/**
 * Applies generated migrations to TiDB Cloud.
 * Usage: npm run db:migrate   (requires DATABASE_URL)
 */
import "dotenv/config";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import mysql from "mysql2/promise";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  // TiDB Cloud refuses plaintext connections; Node's bundled CA store is enough.
  const connection = await mysql.createConnection({
    uri: url,
    multipleStatements: true,
    ssl: url.includes("ssl=") ? undefined : { minVersion: "TLSv1.2" },
  });
  const db = drizzle(connection);
  await migrate(db, { migrationsFolder: "./drizzle" });
  await connection.end();
  console.log("migrations applied");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
