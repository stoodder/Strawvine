/**
 * Ten years of daily use must stay cheap to derive: the client recomputes the model, streaks
 * and achievements after every write. Budgets are generous (CI machines vary); they catch
 * accidental quadratic work, not micro-regressions.
 */
import { describe, expect, it } from "vitest";
import { addDays, dateRange } from "./dates";
import { defaultSettings } from "./defaults";
import { achievements, amrapPrs, streaks, type AppData } from "./gamify";
import { buildModel } from "./insights";
import { emptyDayLog, type DayLog, type Exercise, type MaxEntry, type Session } from "./schemas";
import { blankSet, buildSession } from "./session";

const ids = { bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 };
const start = "2016-11-07";
const today = "2026-11-01";
const settings = { ...defaultSettings(ids, start), onboarded: true };
const exercises: Exercise[] = [
  { id: 1, name: "Bench press", category: "primary", tracksMax: true, measure: "reps", archived: false },
  { id: 2, name: "Deadlift", category: "primary", tracksMax: true, measure: "reps", archived: false },
  { id: 3, name: "Back squat", category: "primary", tracksMax: true, measure: "reps", archived: false },
  { id: 5, name: "Strict press", category: "primary", tracksMax: true, measure: "reps", archived: false },
  { id: 10, name: "Dumbbell fly", category: "accessory", tracksMax: false, measure: "reps", archived: false },
  { id: 11, name: "Row", category: "accessory", tracksMax: false, measure: "reps", archived: false },
];

function fixture(): AppData {
  const dates = dateRange(start, today);
  const days: DayLog[] = dates.map((date, i) => ({
    ...emptyDayLog(date),
    weightLb: 200 + Math.sin(i / 30) * 5,
    calories: 2800 + (i % 7) * 50,
    proteinG: 190,
    steps: 14000 + (i % 5) * 600,
    sleepMinutes: 420,
    hrvMs: 55 + (i % 9),
    zone2Done: i % 7 !== 0,
    metconDone: i % 7 !== 6,
    metconBenchmark: i % 30 === 0 ? "Fran" : null,
    metconScore: i % 30 === 0 ? `${4 + (i % 4)}:${String(10 + (i % 40)).padStart(2, "0")}` : null,
  }));
  const maxEntries: MaxEntry[] = [];
  let id = 1;
  for (const exerciseId of [1, 2, 3, 5])
    for (let w = 0; w < dates.length; w += 35)
      maxEntries.push({
        id: id++,
        exerciseId,
        date: dates[w]!,
        valueLb: 200 + exerciseId * 50 + w / 35,
        source: w === 0 ? "initial" : "amrap",
        note: null,
        createdAt: `${dates[w]}T12:00:00.000Z`,
      });
  const sessions: Session[] = [];
  for (const date of dates) {
    const s = buildSession(date, { settings, exercises, maxEntries, sessions: [] });
    if (s.label === "Training") continue; // not a program day
    s.blocks.push({
      id: `acc-${date}`,
      kind: "accessory",
      exercises: [10, 11].map((exerciseId) => ({
        exerciseId,
        measure: "reps" as const,
        sets: [1, 2, 3].map((n) =>
          blankSet({ id: `${date}-${exerciseId}-${n}`, targetReps: 12, targetWeight: 50, reps: 12, weight: 50, done: true }),
        ),
      })),
    });
    for (const b of s.blocks)
      for (const e of b.exercises)
        for (const set of e.sets) {
          set.done = true;
          set.reps = (set.targetReps ?? 0) + (set.amrap ? date.charCodeAt(9) % 4 : 0);
        }
    s.completedAt = `${date}T20:00:00.000Z`;
    sessions.push(s);
  }
  return { settings, days, exercises, maxEntries, sessions };
}

const time = (fn: () => unknown) => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

describe("ten years of data", () => {
  const data = fixture();

  it("is a realistic size", () => {
    expect(data.days.length).toBeGreaterThan(3600);
    expect(data.sessions.length).toBeGreaterThan(2500);
  });

  it("derives the model, streaks and achievements within budget", () => {
    // Warm up the JIT on a different (equal) data set, so the memo doesn't hide the cold cost.
    const warm = fixture();
    buildModel(warm, today);
    streaks(warm, today);
    achievements(warm, today);

    expect(time(() => buildModel(data, today))).toBeLessThan(50);
    expect(time(() => streaks(data, today))).toBeLessThan(50);
    expect(time(() => achievements(data, today))).toBeLessThan(50);
  });

  it("only recomputes what a write touched", () => {
    achievements(data, today);
    // A new day log: sessions and maxes keep their identity, so their PRs come from the memo.
    const day = { ...emptyDayLog(addDays(today, 1)), steps: 100 };
    const next = { ...data, days: [...data.days, day] };
    expect(time(() => achievements(next, today))).toBeLessThan(25);
    expect(achievements(next, today)).toEqual(achievements(data, today));
  });

  it("finds AMRAP PRs in a single pass with the same results", () => {
    const prs = amrapPrs(data.sessions);
    expect(prs.length).toBeGreaterThan(0);
    expect(amrapPrs(data.sessions, "2020-01-01").every((p) => p.date <= "2020-01-01")).toBe(true);
    expect(time(() => amrapPrs([...data.sessions]))).toBeLessThan(25);
  });
});
