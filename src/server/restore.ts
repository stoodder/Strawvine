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

/**
 * What went wrong, without echoing data: an error's name, code and (Postgres) detail, never its
 * message — driver and parser messages can quote the values being written.
 */
function describe(err: unknown): string {
  if (!(err instanceof Error)) return "unknown error";
  const e = err as Error & { code?: unknown; detail?: unknown; cause?: { code?: unknown; detail?: unknown } };
  const code = e.code ?? e.cause?.code;
  const detail = e.detail ?? e.cause?.detail;
  return [e.name, code !== undefined && `code ${String(code)}`, typeof detail === "string" && detail].filter(Boolean).join(", ");
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
  const source = file === "-" ? "stdin" : file;
  const text = await readInput(file).catch((err: unknown) => {
    throw new RestoreError(`Couldn't read ${source}: ${describe(err)}`);
  });
  try {
    json = JSON.parse(text);
  } catch {
    // The parser's message quotes the input around the error — health data — so it isn't shown.
    throw new RestoreError(`Couldn't read ${source} as JSON (is it a Strawvine export?).`);
  }
  await prepareDatabase(db, sql);
  const summary = await restoreExport(db, json, { force });
  console.log(
    `Restored ${summary.days} days, ${summary.sessions} sessions, ${summary.exercises} exercises, ` +
      `${summary.maxEntries} max entries and ${summary.seenAchievements} seen achievements. ` +
      "Every device has been signed out.",
  );
} catch (err) {
  console.error(err instanceof RestoreError ? err.message : `Restore failed: ${describe(err)}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
