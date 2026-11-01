/**
 * Full-fidelity export (Settings → Export JSON, GET /api/export) and its inverse, restore
 * (`npm run restore -- <file.json>`). The export holds every raw row — nothing derived — with
 * the ids that link them, so a restore reproduces the database exactly.
 */
import { asc, sql } from "drizzle-orm";
import { z } from "zod";
import {
  dayLogSchema,
  emptyDayLog,
  exerciseSchema,
  maxEntrySchema,
  safeString,
  sessionSchema,
  settingsSchema,
  type DayLog,
  type Exercise,
  type MaxEntry,
  type Session,
  type Settings,
} from "../shared/schemas";
import type { Db } from "./db/client";
import { authState, dayLogs, exercises, idempotencyKeys, maxEntries, seenAchievements, sessions, settings } from "./db/schema";

export const EXPORT_FORMAT = "strawvine-export";
/** v1: unversioned exports without seen achievements or exercise timestamps. v2: complete. */
export const EXPORT_VERSION = 2;

export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  settings: Settings | null;
  days: DayLog[];
  exercises: Array<Exercise & { createdAt: string }>;
  maxEntries: MaxEntry[];
  sessions: Session[];
  seenAchievements: Array<{ key: string; seenAt: string }>;
}

type DayRow = typeof dayLogs.$inferSelect;
type ExerciseRow = typeof exercises.$inferSelect;
type MaxRow = typeof maxEntries.$inferSelect;

export const toDay = ({ updatedAt: _u, ...row }: DayRow): DayLog => ({ ...emptyDayLog(row.date), ...row });
export const toExercise = (r: ExerciseRow): Exercise => ({
  id: r.id,
  name: r.name,
  category: r.category as Exercise["category"],
  tracksMax: r.tracksMax,
  measure: r.measure as Exercise["measure"],
  archived: r.archived,
});
export const toMax = (r: MaxRow): MaxEntry => ({
  id: r.id,
  exerciseId: r.exerciseId,
  date: r.date,
  valueLb: r.valueLb,
  source: r.source as MaxEntry["source"],
  note: r.note,
  createdAt: r.createdAt.toISOString(),
});

export async function buildExport(db: Db, now = new Date()): Promise<ExportFile> {
  const [s, days, ex, maxes, sess, seen] = await Promise.all([
    db.select().from(settings),
    db.select().from(dayLogs).orderBy(asc(dayLogs.date)),
    db.select().from(exercises).orderBy(asc(exercises.id)),
    db.select().from(maxEntries).orderBy(asc(maxEntries.id)),
    db.select().from(sessions).orderBy(asc(sessions.date)),
    db.select().from(seenAchievements).orderBy(asc(seenAchievements.key)),
  ]);
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: now.toISOString(),
    settings: s[0]?.data ?? null,
    days: days.map(toDay),
    exercises: ex.map((r) => ({ ...toExercise(r), createdAt: r.createdAt.toISOString() })),
    maxEntries: maxes.map(toMax),
    sessions: sess.map((r) => r.data),
    seenAchievements: seen.map((r) => ({ key: r.key, seenAt: r.seenAt.toISOString() })),
  };
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

const timestamp = z.iso.datetime({ offset: true });
const rowId = z.number().int().min(1).max(2_147_483_647);

const exportFileSchema = z.object({
  format: z.literal(EXPORT_FORMAT).optional(),
  version: z.number().int().min(1).max(EXPORT_VERSION).optional(),
  settings: settingsSchema,
  days: z.array(dayLogSchema),
  exercises: z.array(exerciseSchema.extend({ id: rowId, createdAt: timestamp.optional() })),
  maxEntries: z.array(
    maxEntrySchema.extend({
      id: rowId,
      valueLb: z.number().min(0).max(2000),
      note: safeString().max(500).nullable(),
      createdAt: timestamp,
    }),
  ),
  sessions: z.array(sessionSchema),
  seenAchievements: z.array(z.union([safeString().max(120), z.object({ key: safeString().max(120), seenAt: timestamp })])).default([]),
});

export class RestoreError extends Error {
  override name = "RestoreError";
}

export interface RestoreSummary {
  /** The new session epoch: every session cookie issued before the restore is revoked. */
  sessionEpoch: number;
  days: number;
  exercises: number;
  maxEntries: number;
  sessions: number;
  seenAchievements: number;
}

const CHUNK = 500;
async function insertChunked<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += CHUNK) await insert(rows.slice(i, i + CHUNK));
}

/**
 * Replace the database contents with an export, in one transaction. Refuses when the database
 * already holds the athlete's data (anything beyond the untouched first-boot seed) unless
 * `force` is set. Rows keep their ids; id sequences are moved past them. Ends by bumping the
 * session epoch, which signs every device out.
 */
export async function restoreExport(db: Db, input: unknown, { force = false } = {}): Promise<RestoreSummary> {
  const parsed = exportFileSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new RestoreError(`Not a valid Strawvine export:\n  ${issues.join("\n  ")}`);
  }
  const data = parsed.data;
  const exerciseIds = new Set(data.exercises.map((e) => e.id));
  if (exerciseIds.size !== data.exercises.length) throw new RestoreError("Export has duplicate exercise ids.");
  const orphan = data.maxEntries.find((m) => !exerciseIds.has(m.exerciseId));
  if (orphan) throw new RestoreError(`Max entry ${orphan.id} refers to missing exercise ${orphan.exerciseId}.`);
  for (const [name, list] of [
    ["day", data.days.map((d) => d.date)],
    ["session", data.sessions.map((s) => s.date)],
    ["max entry", data.maxEntries.map((m) => String(m.id))],
  ] as const)
    if (new Set(list).size !== list.length) throw new RestoreError(`Export has duplicate ${name} keys.`);

  const now = new Date();
  const seen = data.seenAchievements.map((s) =>
    typeof s === "string" ? { key: s, seenAt: now } : { key: s.key, seenAt: new Date(s.seenAt) },
  );
  const uniqueSeen = [...new Map(seen.map((s) => [s.key, s])).values()];

  let sessionEpoch = 0;
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`lock table day_logs, sessions, max_entries, exercises, settings, seen_achievements, idempotency_keys in access exclusive mode`,
    );
    if (!force) {
      const [counts] = await tx.execute<{ days: number; sessions: number; maxes: number; seen: number; onboarded: boolean | null }>(sql`
        select (select count(*)::int from day_logs) as days,
               (select count(*)::int from sessions) as sessions,
               (select count(*)::int from max_entries) as maxes,
               (select count(*)::int from seen_achievements) as seen,
               (select (data->>'onboarded')::boolean from settings where id = 1) as onboarded`);
      const c = counts!;
      if (c.days || c.sessions || c.maxes || c.seen || c.onboarded)
        throw new RestoreError(
          `The database already has data (${c.days} days, ${c.sessions} sessions, ${c.maxes} max entries). ` +
            "Re-run with --force to replace all of it with the export.",
        );
    }

    await tx.delete(idempotencyKeys); // stored responses refer to rows being replaced
    await tx.delete(maxEntries);
    await tx.delete(sessions);
    await tx.delete(dayLogs);
    await tx.delete(seenAchievements);
    await tx.delete(settings);
    await tx.delete(exercises);

    await insertChunked(data.exercises, (chunk) =>
      tx.insert(exercises).values(
        chunk.map((e) => ({
          id: e.id,
          name: e.name,
          category: e.category,
          tracksMax: e.tracksMax,
          measure: e.measure,
          archived: e.archived,
          createdAt: e.createdAt ? new Date(e.createdAt) : now,
        })),
      ),
    );
    await insertChunked(data.maxEntries, (chunk) =>
      tx.insert(maxEntries).values(
        chunk.map((m) => ({
          id: m.id,
          exerciseId: m.exerciseId,
          date: m.date,
          valueLb: m.valueLb,
          source: m.source,
          note: m.note,
          createdAt: new Date(m.createdAt),
        })),
      ),
    );
    await insertChunked(data.days, (chunk) => tx.insert(dayLogs).values(chunk.map((d) => ({ ...d, updatedAt: now }))));
    await insertChunked(data.sessions, (chunk) =>
      tx.insert(sessions).values(chunk.map((s) => ({ date: s.date, data: s, updatedAt: now }))),
    );
    await insertChunked(uniqueSeen, (chunk) => tx.insert(seenAchievements).values(chunk));
    await tx.insert(settings).values({ id: 1, data: data.settings, updatedAt: now });

    for (const table of ["exercises", "max_entries"])
      await tx.execute(
        sql`select setval(pg_get_serial_sequence(${table}, 'id'), coalesce((select max(id) from ${sql.identifier(table)}), 0) + 1, false)`,
      );

    // Sign every device out: a restore can roll back sign-outs (and the data a device holds
    // offline no longer matches), so no cookie issued before it stays valid.
    const [epoch] = await tx
      .insert(authState)
      .values({ id: 1, sessionEpoch: 1 })
      .onConflictDoUpdate({ target: authState.id, set: { sessionEpoch: sql`${authState.sessionEpoch} + 1`, updatedAt: now } })
      .returning({ epoch: authState.sessionEpoch });
    sessionEpoch = epoch!.epoch;
  });

  return {
    sessionEpoch,
    days: data.days.length,
    exercises: data.exercises.length,
    maxEntries: data.maxEntries.length,
    sessions: data.sessions.length,
    seenAchievements: uniqueSeen.length,
  };
}
