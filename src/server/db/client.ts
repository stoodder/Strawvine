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

export class MigrationLockTimeout extends Error {
  override name = "MigrationLockTimeout";
}

/**
 * Runs `fn` while holding a Postgres session-level advisory lock, so a release-phase migration
 * and a booting dyno (or two dynos) never migrate or seed at the same time. The lock is taken
 * on a reserved connection and released however `fn` ends. Waits at most `timeoutMs` for the
 * lock (polling, so a stuck holder can't hang a boot past the platform's boot timeout).
 */
export async function withMigrationLock<T>(sql: Sql, fn: () => Promise<T>, { timeoutMs = 10 * 60_000 } = {}): Promise<T> {
  const conn = await sql.reserve();
  try {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [row] = await conn<Array<{ ok: boolean }>>`select pg_try_advisory_lock(${MIGRATION_LOCK_KEY}) as ok`;
      if (row?.ok) break;
      if (Date.now() >= deadline)
        throw new MigrationLockTimeout(`Timed out after ${Math.round(timeoutMs / 1000)} s waiting for the migration lock.`);
      await new Promise((r) => setTimeout(r, Math.min(250, Math.max(0, deadline - Date.now()))));
    }
    try {
      return await fn();
    } finally {
      await conn`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`.catch(() => {});
    }
  } finally {
    conn.release();
  }
}
