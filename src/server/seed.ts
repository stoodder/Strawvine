import { eq } from "drizzle-orm";
import { localToday } from "../shared/dates";
import { defaultSettings, SEED_ACCESSORIES, SEED_EXERCISES, type SeedIds } from "../shared/defaults";
import type { Db } from "./db/client";
import { exercises, settings } from "./db/schema";

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
    await tx.insert(settings).values({ id: 1, data: defaultSettings(ids, today) }).onConflictDoNothing();
  });
}
