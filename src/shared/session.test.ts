import { describe, expect, it } from "vitest";
import { defaultSettings } from "./defaults";
import { buildModel } from "./insights";
import { achievements, checklist, streaks, type AppData } from "./gamify";
import { emptyDayLog, type Exercise, type MaxEntry, type Session } from "./schemas";
import { buildSession } from "./session";
import { addDays } from "./dates";

const ids = { bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 };
const settings = { ...defaultSettings(ids, "2026-11-01"), onboarded: true };
const exercises: Exercise[] = [
  { id: 1, name: "Bench press", category: "primary", tracksMax: true, measure: "reps", archived: false },
  { id: 2, name: "Deadlift", category: "primary", tracksMax: true, measure: "reps", archived: false },
  { id: 10, name: "Dumbbell fly", category: "accessory", tracksMax: false, measure: "reps", archived: false },
  { id: 11, name: "Hollow hold", category: "core", tracksMax: false, measure: "seconds", archived: false },
];
const maxEntries: MaxEntry[] = [
  { id: 1, exerciseId: 1, date: "2026-11-01", valueLb: 315, source: "initial", note: null, createdAt: "2026-11-01T00:00:00Z" },
];

describe("buildSession", () => {
  it("calculates Monday's bench from the max (week 1)", () => {
    const s = buildSession("2026-11-02", { settings, exercises, maxEntries, sessions: [] });
    expect(s.label).toBe("Push");
    expect([s.cycle, s.week, s.deload]).toEqual([1, 1, false]);
    const sets = s.blocks[0]!.exercises[0]!.sets;
    // 315 × pct × 0.9 rounded to 5
    expect(sets.map((x) => x.targetWeight)).toEqual([240, 225, 215, 200]);
    expect(sets.map((x) => x.amrap)).toEqual([false, false, false, true]);
  });

  it("carries accessories + supersets from the last same-weekday session, deloading at 80%", () => {
    const prior: Session = {
      ...buildSession("2026-11-23", { settings, exercises, maxEntries, sessions: [] }),
      blocks: [
        {
          id: "b",
          kind: "accessory",
          exercises: [
            {
              exerciseId: 10,
              measure: "reps",
              sets: [
                { id: "s1", targetReps: 12, targetWeight: 40, reps: 12, weight: 50, done: true, amrap: false, appliedProgressionLb: null },
              ],
            },
            {
              exerciseId: 11,
              measure: "seconds",
              sets: [
                {
                  id: "s2",
                  targetReps: 30,
                  targetWeight: null,
                  reps: 45,
                  weight: null,
                  done: true,
                  amrap: false,
                  appliedProgressionLb: null,
                },
              ],
            },
          ],
        },
      ],
    };
    const normal = buildSession("2026-12-07", { settings, exercises, maxEntries, sessions: [prior] });
    const acc = normal.blocks.find((b) => b.kind === "accessory")!;
    expect(acc.exercises).toHaveLength(2); // superset preserved
    expect(acc.exercises[0]!.sets[0]!.targetWeight).toBe(50);
    expect(acc.exercises[1]!.sets[0]!.targetReps).toBe(45);

    const deload = buildSession("2026-11-30", { settings, exercises, maxEntries, sessions: [prior] });
    expect(deload.deload).toBe(true);
    expect(deload.blocks.find((b) => b.kind === "accessory")!.exercises[0]!.sets[0]!.targetWeight).toBe(40);
    expect(deload.blocks[0]!.exercises[0]!.sets.map((x) => x.targetReps)).toEqual([10, 10, 10, 10]);
  });

  it("makes light accessories lighter on a deload instead of rounding back up", () => {
    const set = (weight: number) => ({
      id: `w${weight}`,
      targetReps: 12,
      targetWeight: weight,
      reps: 12,
      weight,
      done: true,
      amrap: false,
      appliedProgressionLb: null,
    });
    const prior: Session = {
      ...buildSession("2026-11-23", { settings, exercises, maxEntries, sessions: [] }),
      blocks: [{ id: "b", kind: "accessory", exercises: [{ exerciseId: 10, measure: "reps", sets: [50, 10, 5, 4, 3, 2.5, 0].map(set) }] }],
    };
    const deload = buildSession("2026-11-30", { settings, exercises, maxEntries, sessions: [prior] });
    const weights = deload.blocks.find((b) => b.kind === "accessory")!.exercises[0]!.sets.map((s) => s.targetWeight);
    // 80% rounded to 5 lb where that is lighter; otherwise a 2.5 lb increment, then one 2.5 lb step, never below 0.
    expect(weights).toEqual([40, 7.5, 2.5, 2.5, 2.5, 0, 0]);
  });

  it("has no main lift on the carry day", () => {
    const s = buildSession("2026-11-06", { settings, exercises, maxEntries, sessions: [] });
    expect(s.label).toBe("Carries & pull");
    expect(s.blocks).toHaveLength(0);
  });
});

describe("checklist & streaks", () => {
  const full = (date: string) => ({
    ...emptyDayLog(date),
    weightLb: 200,
    calories: 3000,
    steps: 16000,
    metconDone: true,
    zone2Done: true,
  });

  it("schedules items by weekday", () => {
    expect(checklist("2026-11-08", full("2026-11-08"), undefined, settings).map((i) => i.key)).toEqual(["morning", "fuel", "steps"]); // Sunday
    expect(checklist("2026-11-02", full("2026-11-02"), undefined, settings).map((i) => i.key)).toEqual([
      "morning",
      "fuel",
      "steps",
      "lift",
      "metcon",
      "zone2",
    ]);
  });

  it("counts a streak and doesn't break it for an in-progress today", () => {
    // Saturday + Sunday closed (no lifting days).
    const data: AppData = {
      settings,
      days: [full("2026-11-07"), full("2026-11-08"), { ...emptyDayLog("2026-11-09"), weightLb: 200 }],
      exercises,
      maxEntries,
      sessions: [],
    };
    expect(streaks(data, "2026-11-09")).toEqual({ current: 2, best: 2, todayClosed: false });
    expect(achievements(data, "2026-11-09").some((a) => a.key === "close-1")).toBe(true);
  });
});

describe("buildModel", () => {
  it("bases today's targets on yesterday so logging food doesn't move them", () => {
    const days = Array.from({ length: 20 }, (_, i) => ({ ...emptyDayLog(addDays("2026-11-02", i)), weightLb: 200, calories: 3000 }));
    const data: AppData = { settings, days, exercises, maxEntries, sessions: [] };
    const today = "2026-11-21";
    const a = buildModel(data, today).targets.recommendation!.calories;
    const b = buildModel({ ...data, days: [...days, { ...emptyDayLog(today), weightLb: 200, calories: 900 }] }, today).targets
      .recommendation!.calories;
    expect(a).toBe(b);
    expect(a).toBe(3000);
  });
});
