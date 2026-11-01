/**
 * Release-phase entry point (`heroku.yml` → `node dist/server/migrate.js`): applies pending
 * migrations and seeds a fresh database before the new web dynos start. The web process still
 * runs the same (idempotent, locked) step on boot as a fallback for docker compose / local runs.
 */
import { createDb } from "./db/client";
import { prepareDatabase } from "./seed";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Missing required environment variable DATABASE_URL.");
  process.exit(1);
}

const { db, sql } = createDb(url);
try {
  await prepareDatabase(db, sql);
  console.log("Database is up to date.");
} catch (err) {
  console.error("Migration failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
