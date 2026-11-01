import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = ReturnType<typeof createDb>["db"];
export type Sql = ReturnType<typeof createDb>["sql"];

export function createDb(url: string) {
  const local = /@(localhost|127\.0\.0\.1|db)(:|\/)/.test(url);
  // Heroku Postgres requires TLS but presents a certificate that isn't publicly chained.
  const sql = postgres(url, { ssl: local ? false : { rejectUnauthorized: false }, max: 5, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  return { db, sql };
}

export async function runMigrations(db: Db) {
  await migrate(db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
}

/** Arbitrary constant naming the "schema changes" advisory lock ("strv" in ASCII). */
export const MIGRATION_LOCK_KEY = 0x73747276;

/**
 * Runs `fn` while holding a Postgres session-level advisory lock, so a release-phase migration
 * and a booting dyno (or two dynos) never migrate or seed at the same time. The lock is taken
 * on a reserved connection and released however `fn` ends.
 */
export async function withMigrationLock<T>(sql: Sql, fn: () => Promise<T>): Promise<T> {
  const conn = await sql.reserve();
  try {
    await conn`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    try {
      return await fn();
    } finally {
      await conn`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`.catch(() => {});
    }
  } finally {
    conn.release();
  }
}
