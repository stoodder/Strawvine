/**
 * Restore an export into the database:
 *
 *   npm run restore -- strawvine-export-2026-11-01.json [--force]
 *   node dist/server/restore.js - < export.json          (read from stdin, e.g. via `heroku run`)
 *
 * Applies migrations first, then replaces everything in one transaction and signs every device
 * out (bumps the session epoch). Refuses to touch a database that already holds data unless
 * --force is given.
 */
import { readFile } from "node:fs/promises";
import { RestoreError, restoreExport } from "./backup";
import { createDb } from "./db/client";
import { prepareDatabase } from "./seed";

const args = process.argv.slice(2);
const force = args.includes("--force");
const file = args.find((a) => !a.startsWith("--"));
const url = process.env.DATABASE_URL;

if (!file || !url) {
  console.error("Usage: DATABASE_URL=… npm run restore -- <export.json | -> [--force]");
  process.exit(2);
}

async function readInput(path: string): Promise<string> {
  if (path !== "-") return readFile(path, "utf8");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const { db, sql } = createDb(url);
try {
  let json: unknown;
  try {
    json = JSON.parse(await readInput(file));
  } catch (err) {
    throw new RestoreError(`Couldn't read ${file === "-" ? "stdin" : file} as JSON: ${err instanceof Error ? err.message : err}`);
  }
  await prepareDatabase(db, sql);
  const summary = await restoreExport(db, json, { force });
  console.log(
    `Restored ${summary.days} days, ${summary.sessions} sessions, ${summary.exercises} exercises, ` +
      `${summary.maxEntries} max entries and ${summary.seenAchievements} seen achievements. ` +
      "Every device has been signed out.",
  );
} catch (err) {
  console.error(err instanceof RestoreError ? err.message : `Restore failed: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
