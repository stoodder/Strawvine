/**
 * Release-phase entry point (`heroku.yml` → `node dist/server/migrate.js`): applies pending
 * migrations and seeds a fresh database before the new web dynos start. The web process still
 * runs the same (idempotent, locked) step on boot as a fallback for docker compose / local runs.
 */
import { minRehabBuildLevelFrom } from "./config";
import { createDb } from "./db/client";
import { prepareDatabase } from "./seed";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Missing required environment variable DATABASE_URL.");
  process.exit(1);
}
// Checked here too, so a value the web process would refuse to boot with aborts the release instead of a crash loop.
const problems: string[] = [];
minRehabBuildLevelFrom(process.env, problems);
if (problems.length) {
  console.error(`Refusing to release:\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}

const { db, sql } = createDb(url);
try {
  // The release phase may wait longer for the lock than a booting dyno (see index.ts).
  await prepareDatabase(db, sql, { lockTimeoutMs: 15 * 60_000 });
  console.log("Database is up to date.");
} catch (err) {
  console.error("Migration failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
