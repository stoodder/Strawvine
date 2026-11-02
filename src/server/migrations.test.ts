/**
 * Data migrations, run against a database populated the way it was before them: migrate up to the
 * migration before, insert rows as the app wrote them then, run the rest, check the data.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations } from "./db/client";
import { assertDisposableDatabase } from "./testDb";

const url = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5432/strawvine_test";
// These tests drop and recreate the schema: never against anything but a local throwaway database.
assertDisposableDatabase(url);
const { db, sql: client } = createDb(url);
const drizzleDir = path.resolve(process.cwd(), "drizzle");
let tmp = "";

/** Applies the repo's migrations up to (and including) the one tagged `lastTag`. */
async function migrateUpTo(lastTag: string) {
  const folder = path.join(tmp, lastTag);
  cpSync(drizzleDir, folder, { recursive: true });
  const journalPath = path.join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
  const end = journal.entries.findIndex((e) => e.tag === lastTag);
  expect(end, lastTag).toBeGreaterThanOrEqual(0);
  writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, end + 1) }));
  await migrate(db, { migrationsFolder: folder });
}

const set = (weight: number | null, targetWeight: number | null) => ({
  id: "s",
  targetReps: 10,
  targetWeight,
  reps: 10,
  weight,
  done: true,
  amrap: false,
  appliedProgressionLb: null,
});
const block = (kind: "primary" | "accessory", exercises: Array<[id: number, sets: ReturnType<typeof set>[]]>) => ({
  id: "b",
  kind,
  exercises: exercises.map(([exerciseId, sets]) => ({ exerciseId, measure: "reps", sets })),
});

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "strawvine-migrations-"));
  await db.execute(sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`);
});

afterAll(async () => {
  // Leave a fully migrated schema behind, as the other database tests expect to find (they reset it anyway).
  await db.execute(sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`);
  await runMigrations(db);
  await client.end();
  rmSync(tmp, { recursive: true, force: true });
});

describe("0006 exercise weighted backfill", () => {
  it("turns weighted off for exercises with no sign of a load, and only for those", async () => {
    await migrateUpTo("0004_dataset_version_revoked_sessions");
    // Exercises as they were before the flag (ids in insertion order).
    const fixtures: Array<[name: string, category: string, tracksMax: boolean, measure: string, archived: boolean]> = [
      ["Bench press", "primary", true, "reps", false], // 1: tracks a max
      ["Pause squat", "primary", false, "reps", false], // 2: primary category
      ["Landmine press", "accessory", false, "reps", false], // 3: a program day's main lift
      ["Cable row", "accessory", false, "reps", false], // 4: a logged load
      ["Goblet squat", "accessory", false, "reps", false], // 5: a planned load only
      ["Plank", "core", false, "seconds", false], // 6: never loaded (null / 0)
      ["Shuttle run", "conditioning", false, "meters", false], // 7: never used
      ["Old curl", "accessory", false, "reps", true], // 8: archived, never loaded
      ["Old row", "accessory", false, "reps", true], // 9: archived, loaded
      ["Ring dip", "accessory", false, "reps", false], // 10: has a max entry
      ["Zercher squat", "accessory", false, "reps", false], // 11: in a main-lift block, no load
      ["Weighted chin", "accessory", false, "reps", false], // 12: a strength target
      ["Pull-up", "accessory", false, "reps", false], // 13: loads of 0 only
    ];
    for (const [name, category, tracksMax, measure, archived] of fixtures)
      await db.execute(
        sql`insert into exercises (name, category, tracks_max, measure, archived) values (${name}, ${category}, ${tracksMax}, ${measure}, ${archived})`,
      );
    const settingsDoc = {
      onboarded: true,
      program: {
        days: {
          "1": { label: "Mon", primaryExerciseId: 1 },
          "3": { label: "Wed", primaryExerciseId: 3 },
          "5": { primaryExerciseId: null },
        },
      },
      strengthTargets: [{ id: "t", exerciseId: 12, targetLb: 90, setOn: "2026-10-01" }],
    };
    await db.execute(sql`insert into settings (id, data) values (1, ${JSON.stringify(settingsDoc)}::jsonb)`);
    await db.execute(sql`insert into max_entries (exercise_id, date, value_lb, source) values (10, '2026-10-01', 40, 'manual')`);
    const sessionsDocs = [
      {
        date: "2026-10-05",
        blocks: [
          block("primary", [[1, [set(200, 200)]]]),
          block("accessory", [
            [4, [set(null, null), set(50, null)]],
            [6, [set(null, null), set(0, 0)]],
          ]),
          block("accessory", [[5, [set(null, 40)]]]),
        ],
      },
      {
        date: "2026-10-07",
        blocks: [
          block("primary", [[11, [set(null, null)]]]),
          block("accessory", [
            [9, [set(30, 30)]],
            [13, [set(0, 0), set(null, 0)]],
            [8, [set(null, null)]],
          ]),
          // Odd shapes from old builds never fail the migration.
          { id: "x", kind: "accessory", exercises: [{ exerciseId: 7, measure: "meters", sets: [{ weight: "heavy" }] }] },
          { id: "y", kind: "accessory", exercises: [{ exerciseId: 7 }] },
        ],
      },
      { date: "2026-10-09", blocks: null },
    ];
    for (const doc of sessionsDocs)
      await db.execute(sql`insert into sessions (date, data) values (${doc.date}, ${JSON.stringify(doc)}::jsonb)`);

    await runMigrations(db); // 0005 (every exercise weighted) and 0006 (the backfill)

    const rows = await db.execute<{ id: number; weighted: boolean }>(sql`select id, weighted from exercises order by id`);
    const unweighted = rows.filter((r) => !r.weighted).map((r) => fixtures[r.id - 1]![0]);
    expect(unweighted).toEqual(["Plank", "Shuttle run", "Old curl", "Pull-up"]);

    // Running it again changes nothing.
    const backfill = readFileSync(path.join(drizzleDir, "0006_exercise_weighted_backfill.sql"), "utf8");
    const again = await client.unsafe(backfill);
    expect(again.count).toBe(0);
  });

  it("does nothing on a fresh database", async () => {
    await db.execute(sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`);
    await runMigrations(db);
    expect(await db.execute(sql`select id from exercises`)).toHaveLength(0);
  });
});
