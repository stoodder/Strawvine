import { eq } from "drizzle-orm";
import { localToday } from "../shared/dates";
import { defaultSettings, SEED_ACCESSORIES, SEED_EXERCISES, type SeedIds } from "../shared/defaults";
import { runMigrations, withMigrationLock, type Db, type Sql } from "./db/client";
import { exercises, settings } from "./db/schema";
import { pruneIdempotencyKeys } from "./idempotency";

/** First boot: create the tracked lifts and the default program. Idempotent. */
export async function ensureSeeded(db: Db, today: string = localToday()) {
  const existing = await db.select().from(settings).where(eq(settings.id, 1));
  if (existing.length) return;

  await db.transaction(async (tx) => {
    const ids = {} as SeedIds;
    for (const s of SEED_EXERCISES) {
      const [row] = await tx
        .insert(exercises)
        .values({ name: s.name, category: s.category, tracksMax: s.tracksMax, measure: s.measure })
        .returning({ id: exercises.id });
      ids[s.key] = row!.id;
    }
    for (const a of SEED_ACCESSORIES) await tx.insert(exercises).values({ name: a.name, category: a.category, measure: a.measure });
    await tx
      .insert(settings)
      .values({ id: 1, data: defaultSettings(ids, today) })
      .onConflictDoNothing();
  });
}

/**
 * Apply pending migrations, seed a fresh database and prune expired idempotency keys, under the
 * migration advisory lock (waiting at most `lockTimeoutMs` for it).
 */
export async function prepareDatabase(db: Db, sql: Sql, { lockTimeoutMs }: { lockTimeoutMs?: number } = {}) {
  await withMigrationLock(
    sql,
    async () => {
      await runMigrations(db);
      await ensureSeeded(db);
      await pruneIdempotencyKeys(db);
    },
    { timeoutMs: lockTimeoutMs },
  );
}
