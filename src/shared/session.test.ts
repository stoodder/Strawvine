import { describe, expect, it } from "vitest";
import { defaultSettings } from "./defaults";
import { buildModel } from "./insights";
import { achievements, checklist, streaks, type AppData } from "./gamify";
import { emptyDayLog, type BlockExercise, type Exercise, type MaxEntry, type Session, type SetEntry } from "./schemas";
import {
  accessoryHint,
  blankSet,
  buildSession,
  buildSessionFrom,
  defaultTarget,
  effectiveTargetWeight,
  isWeighted,
  logAtTargets,
  loggedWeightFor,
  needsLoadBeforeLogging,
  nextSession,
  nextSetAfter,
  planChanged,
  planMatches,
  planSignature,
  sessionCounts,
  sessionVolume,
  setsForAddedExercise,
  shownLoad,
} from "./session";
import { addDays } from "./dates";

const ids = { bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 };
const settings = { ...defaultSettings(ids, "2026-11-01"), onboarded: true };
const exercises: Exercise[] = [
  { id: 1, name: "Bench press", category: "primary", tracksMax: true, measure: "reps", weighted: true, archived: false },
  { id: 2, name: "Deadlift", category: "primary", tracksMax: true, measure: "reps", weighted: true, archived: false },
  { id: 10, name: "Dumbbell fly", category: "accessory", tracksMax: false, measure: "reps", weighted: true, archived: false },
  { id: 11, name: "Hollow hold", category: "core", tracksMax: false, measure: "seconds", weighted: true, archived: false },
];
const maxEntries: MaxEntry[] = [
  { id: 1, exerciseId: 1, date: "2026-11-01", valueLb: 315, source: "initial", note: null, createdAt: "2026-11-01T00:00:00Z" },
];
/** `accessoryHint`'s option for a weighted exercise. */
const W = { weighted: true };

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
    // Targets carry over, not what was done (45 s held against a 30 s target stays a 30 s target).
    expect(acc.exercises[1]!.sets[0]!.targetReps).toBe(30);

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

describe("skipping an accessory today", () => {
  const set = (weight: number, reps: number, done = true) => ({
    id: `s${weight}-${reps}`,
    targetReps: reps,
    targetWeight: weight,
    reps: done ? reps : null,
    weight: done ? weight : null,
    done,
    amrap: false,
    appliedProgressionLb: null,
  });
  const withAccessories = (date: string, exercises: Session["blocks"][number]["exercises"]): Session => ({
    ...buildSession(date, { settings, exercises: [], maxEntries: [], sessions: [] }),
    blocks: [{ id: `b-${date}`, kind: "accessory", exercises }],
  });

  it("keeps a skipped exercise on next week's plan, prefilled from its last real performance", () => {
    const done = withAccessories("2026-11-09", [
      { exerciseId: 10, measure: "reps", sets: [set(50, 12)] },
      { exerciseId: 11, measure: "seconds", sets: [{ ...set(0, 45), weight: null, targetWeight: null }] },
    ]);
    const skipped = withAccessories("2026-11-16", [
      { exerciseId: 10, measure: "reps", sets: [set(55, 12, false)], skipped: true },
      { exerciseId: 11, measure: "seconds", sets: [{ ...set(0, 50), weight: null, targetWeight: null }] },
    ]);
    const next = buildSession("2026-11-23", { settings, exercises, maxEntries, sessions: [done, skipped] });
    const acc = next.blocks.find((b) => b.kind === "accessory")!;
    expect(acc.exercises.map((e) => e.exerciseId)).toEqual([10, 11]);
    expect(acc.exercises[0]!.skipped).toBeUndefined();
    // From Nov 9 (the last time it was done), not the skipped prefill of 55.
    expect(acc.exercises[0]!.sets.map((s) => [s.targetReps, s.targetWeight])).toEqual([[12, 50]]);
    expect(acc.exercises[1]!.sets[0]!.targetReps).toBe(50);
  });

  it("falls back to the skipped prefill when it was never done", () => {
    const skipped = withAccessories("2026-11-16", [{ exerciseId: 10, measure: "reps", sets: [set(55, 10, false)], skipped: true }]);
    const next = buildSession("2026-11-23", { settings, exercises, maxEntries, sessions: [skipped] });
    const ex = next.blocks.find((b) => b.kind === "accessory")!.exercises[0]!;
    expect([ex.skipped, ex.sets[0]!.targetReps, ex.sets[0]!.targetWeight]).toEqual([undefined, 10, 55]);
  });

  it("deloads the carried load relative to the session it comes from", () => {
    const done = withAccessories("2026-11-16", [{ exerciseId: 10, measure: "reps", sets: [set(50, 12)] }]);
    const skipped = withAccessories("2026-11-23", [{ exerciseId: 10, measure: "reps", sets: [set(50, 12, false)], skipped: true }]);
    const deload = buildSession("2026-11-30", { settings, exercises, maxEntries, sessions: [done, skipped] });
    expect(deload.blocks.find((b) => b.kind === "accessory")!.exercises[0]!.sets[0]!.targetWeight).toBe(40);
  });

  it("carries a skipped exercise's last real load only while it is weighted", () => {
    const done = withAccessories("2026-11-02", [{ exerciseId: 10, measure: "reps", sets: [set(50, 12)] }]);
    const skipped = withAccessories("2026-11-09", [{ exerciseId: 10, measure: "reps", sets: [set(55, 12, false)], skipped: true }]);
    const carried = (weighted: boolean) =>
      buildSession("2026-11-16", {
        settings,
        exercises: exercises.map((e) => (e.id === 10 ? { ...e, weighted } : e)),
        maxEntries,
        sessions: [done, skipped],
      }).blocks.find((b) => b.kind === "accessory")!.exercises[0]!.sets[0]!;
    expect([carried(true).targetReps, carried(true).targetWeight]).toEqual([12, 50]);
    expect([carried(false).targetReps, carried(false).targetWeight]).toEqual([12, null]);
  });

  it("leaves skipped exercises out of the volume", () => {
    const s = withAccessories("2026-11-16", [
      { exerciseId: 10, measure: "reps", sets: [set(50, 10)] },
      { exerciseId: 12, measure: "reps", sets: [set(100, 10)], skipped: true },
    ]);
    expect(sessionVolume(s)).toBe(500);
  });
});

describe("planMatches", () => {
  const ctx = { settings, exercises, maxEntries, sessions: [] as Session[] };

  it("matches a freshly built session, ignoring ids and added back-off sets", () => {
    const s = buildSession("2026-11-02", ctx);
    expect(planMatches(s, ctx)).toBe(true);
    const primary = s.blocks[0]!;
    const withBackoff: Session = {
      ...s,
      blocks: [
        { ...primary, exercises: [{ ...primary.exercises[0]!, sets: [...primary.exercises[0]!.sets, blankSet({ targetReps: 10 })] }] },
      ],
    };
    expect(planMatches(withBackoff, ctx)).toBe(true);
    // No main lift planned (carry day) and none saved.
    expect(planMatches(buildSession("2026-11-06", ctx), ctx)).toBe(true);
  });

  it("notices a new max, an edited program and a missing or extra main lift", () => {
    const s = buildSession("2026-11-02", ctx);
    const newMax: MaxEntry = { ...maxEntries[0]!, id: 2, valueLb: 335, createdAt: "2026-11-01T01:00:00Z" };
    expect(planMatches(s, { ...ctx, maxEntries: [...maxEntries, newMax] })).toBe(false);

    const weeks = settings.program.weeks.map((w, i) => (i === 0 ? { ...w, reps: [5, 5, 5, 5] } : w));
    expect(planMatches(s, { ...ctx, settings: { ...settings, program: { ...settings.program, weeks } } })).toBe(false);
    const noAmrap = { ...settings, program: { ...settings.program, amrapLastSet: false } };
    expect(planMatches(s, { ...ctx, settings: noAmrap })).toBe(false);

    expect(planMatches({ ...s, blocks: [] }, ctx)).toBe(false);
    const days = { ...settings.program.days, "1": { label: "Push", primaryExerciseId: null, progression: true } };
    expect(planMatches(s, { ...ctx, settings: { ...settings, program: { ...settings.program, days } } })).toBe(false);

    const fewer: Session = {
      ...s,
      blocks: [{ ...s.blocks[0]!, exercises: [{ ...s.blocks[0]!.exercises[0]!, sets: s.blocks[0]!.exercises[0]!.sets.slice(0, 3) }] }],
    };
    expect(planMatches(fewer, ctx)).toBe(false);
  });
});

describe("accessoryHint", () => {
  const sess = (
    date: string,
    sets: Array<[reps: number | null, target: number | null, weight: number | null, done: boolean]>,
    skipped?: boolean,
  ): Session => ({
    ...buildSession(date, { settings, exercises: [], maxEntries: [], sessions: [] }),
    blocks: [
      {
        id: `b-${date}`,
        kind: "accessory",
        exercises: [
          {
            exerciseId: 10,
            measure: "reps",
            skipped,
            sets: sets.map(([reps, targetReps, weight, done], i) =>
              blankSet({ id: `${date}-${i}`, reps, targetReps, weight, targetWeight: weight, done }),
            ),
          },
        ],
      },
    ],
  });

  it("suggests +increment when every logged set met its target reps", () => {
    const last = sess("2026-11-09", [
      [12, 12, 50, true],
      [13, 12, 50, true],
      [null, 12, 50, false], // not logged: doesn't count
    ]);
    expect(accessoryHint(10, "2026-11-16", [last], 5, W)).toEqual({
      kind: "increase",
      measure: "reps",
      lastWeight: 50,
      suggestedWeight: 55,
      reason: expect.stringContaining("+5 lb"),
    });
    expect(accessoryHint(10, "2026-11-16", [last], 2.5, W)?.suggestedWeight).toBe(52.5);
  });

  it("holds the load when a set fell short of its target", () => {
    const short = sess("2026-11-09", [
      [12, 12, 50, true],
      [10, 12, 50, true],
    ]);
    expect(accessoryHint(10, "2026-11-16", [short], 5, W)).toEqual({
      kind: "hold",
      measure: "reps",
      lastWeight: 50,
      suggestedWeight: 50,
      reason: "Missed reps at 50 lb on Nov 9 — hold",
    });
    // Hints off: no hold either.
    expect(accessoryHint(10, "2026-11-16", [short], 0, W)).toBeNull();
  });

  it("has no hint when a set had no load or target, or nothing was logged", () => {
    expect(accessoryHint(10, "2026-11-16", [sess("2026-11-09", [[12, null, 50, true]])], 5, W)).toBeNull();
    expect(accessoryHint(10, "2026-11-16", [sess("2026-11-09", [[12, 12, null, true]])], 5, W)).toBeNull();
    expect(accessoryHint(10, "2026-11-16", [], 5, W)).toBeNull();
    expect(accessoryHint(10, "2026-11-16", [sess("2026-11-09", [[12, 12, 50, true]])], 0, W)).toBeNull();
  });

  it("looks at the most recent non-skipped performance before the date", () => {
    const good = sess("2026-11-02", [[12, 12, 40, true]]);
    const short = sess("2026-11-09", [[8, 12, 50, true]]);
    const skipped = sess("2026-11-16", [[12, 12, 60, true]], true);
    const unlogged = sess("2026-11-17", [[null, 12, 60, false]]);
    expect(accessoryHint(10, "2026-11-23", [good, short, skipped, unlogged], 5, W)).toMatchObject({ kind: "hold", lastWeight: 50 }); // Nov 9 fell short
    expect(accessoryHint(10, "2026-11-09", [good, short, skipped, unlogged], 5, W)?.suggestedWeight).toBe(45); // before Nov 9
  });

  it("has no hint for an unweighted exercise, even with old loads logged", () => {
    const last = sess("2026-11-09", [[12, 12, 50, true]]);
    expect(accessoryHint(10, "2026-11-16", [last], 5, { weighted: false })).toBeNull();
    expect(accessoryHint(10, "2026-11-16", [last], 5, { weighted: true })?.kind).toBe("increase");
  });

  it("looks past a performance logged without a load (while unweighted) to the last one with a load", () => {
    const loaded = sess("2026-11-02", [[12, 12, 40, true]]);
    // Logged while unweighted: no load recorded, though the pre-filled target load is still there.
    const unloaded: Session = {
      ...sess("2026-11-09", []),
      blocks: [
        {
          id: "b",
          kind: "accessory",
          exercises: [{ exerciseId: 10, measure: "reps", sets: [blankSet({ targetReps: 12, reps: 12, targetWeight: 25, weight: null, done: true })] }],
        },
      ],
    };
    expect(accessoryHint(10, "2026-11-16", [loaded, unloaded], 5, W)).toMatchObject({
      kind: "increase",
      lastWeight: 40,
      suggestedWeight: 45,
      reason: "All reps at 40 lb on Nov 2 → +5 lb",
    });
    expect(accessoryHint(10, "2026-11-16", [unloaded], 5, W)).toBeNull();
    // Some sets with a load and some without: no hint (the load progression is unclear).
    expect(accessoryHint(10, "2026-11-16", [sess("2026-11-09", [[12, 12, 40, true], [12, 12, null, true]])], 5, W)).toBeNull();
  });

  it("takes the measure from the entry that was logged when the exercise appears twice", () => {
    const twice: Session = {
      ...sess("2026-11-09", []),
      blocks: [
        { id: "a", kind: "accessory", exercises: [{ exerciseId: 10, measure: "reps", sets: [blankSet({ targetReps: 12, targetWeight: 25 })] }] },
        {
          id: "b",
          kind: "accessory",
          exercises: [
            { exerciseId: 10, measure: "seconds", sets: [blankSet({ targetReps: 30, reps: 30, targetWeight: 25, weight: 25, done: true })] },
          ],
        },
      ],
    };
    expect(accessoryHint(10, "2026-11-16", [twice], 5, W)).toMatchObject({
      measure: "seconds",
      reason: "Full duration at 25 lb on Nov 9 → +5 lb",
    });
  });

  describe("weighted time and distance", () => {
    const timed = (date: string, measure: "seconds" | "meters", sets: Array<[done: number, target: number, weight: number]>): Session => ({
      ...buildSession(date, { settings, exercises: [], maxEntries: [], sessions: [] }),
      blocks: [
        {
          id: `b-${date}`,
          kind: "accessory",
          exercises: [
            {
              exerciseId: 10,
              measure,
              sets: sets.map(([reps, targetReps, weight], i) =>
                blankSet({ id: `${date}-${i}`, reps, targetReps, weight, targetWeight: weight, done: true }),
              ),
            },
          ],
        },
      ],
    });

    it("suggests +increment when every hold lasted its target time at a load", () => {
      const hang = timed("2026-11-09", "seconds", [
        [30, 30, 25],
        [35, 30, 25],
      ]);
      expect(accessoryHint(10, "2026-11-16", [hang], 5, W)).toEqual({
        kind: "increase",
        measure: "seconds",
        lastWeight: 25,
        suggestedWeight: 30,
        reason: "Full duration at 25 lb on Nov 9 → +5 lb",
      });
    });

    it("holds when a hold or a carry fell short", () => {
      const hang = timed("2026-11-09", "seconds", [[20, 30, 25]]);
      expect(accessoryHint(10, "2026-11-16", [hang], 5, W)).toMatchObject({
        kind: "hold",
        suggestedWeight: 25,
        reason: "Short on duration at 25 lb on Nov 9 — hold",
      });
      const carry = timed("2026-11-09", "meters", [[30, 40, 70]]);
      expect(accessoryHint(10, "2026-11-16", [carry], 5, W)?.reason).toBe("Short on distance at 70 lb on Nov 9 — hold");
    });

    it("uses the increment from settings for a carry that went the full distance", () => {
      const carry = timed("2026-11-09", "meters", [[40, 40, 70]]);
      expect(accessoryHint(10, "2026-11-16", [carry], 10, W)).toMatchObject({
        kind: "increase",
        measure: "meters",
        suggestedWeight: 80,
        reason: "Full distance at 70 lb on Nov 9 → +10 lb",
      });
    });
  });
});

describe("isWeighted / setsForAddedExercise", () => {
  it("counts an exercise without the flag (or an unknown one) as weighted", () => {
    expect(isWeighted({ weighted: false })).toBe(false);
    expect(isWeighted({ weighted: true })).toBe(true);
    expect(isWeighted({} as Exercise)).toBe(true);
    expect(isWeighted(undefined)).toBe(true);
    expect(isWeighted(null)).toBe(true);
  });

  const plan = (date: string) => buildSession(date, { settings, exercises: [], maxEntries: [], sessions: [] });
  const withBlock = (date: string, exs: BlockExercise[], kind: "accessory" | "primary" = "accessory"): Session => ({
    ...plan(date),
    blocks: [{ id: `b-${date}`, kind, exercises: exs }],
  });
  const targets = (sets: ReadonlyArray<SetEntry>) => sets.map((s) => [s.targetReps, s.targetWeight]);
  const logged = (targetReps: number | null, reps: number, weight: number | null) =>
    blankSet({ targetReps, targetWeight: weight, reps, weight, done: true });
  const hang = { id: 20, measure: "seconds" as const, weighted: true };
  const carry = { id: 21, measure: "meters" as const, weighted: true };

  it("starts a new exercise at three sets of the measure's default target", () => {
    expect(defaultTarget("reps")).toBe(10);
    expect(targets(setsForAddedExercise(hang, plan("2026-11-16"), { settings, sessions: [] }))).toEqual([
      [30, null],
      [30, null],
      [30, null],
    ]);
    const run = { id: 22, measure: "meters" as const, weighted: false };
    expect(setsForAddedExercise(run, plan("2026-11-16"), { settings, sessions: [] }).map((s) => s.targetReps)).toEqual([40, 40, 40]);
  });

  it("pre-fills targets (not missed reps) and the load lifted; an unweighted exercise gets no load", () => {
    const prev = withBlock("2026-11-09", [
      { exerciseId: 20, measure: "seconds", sets: [logged(30, 35, 25), logged(30, 20, 25), logged(null, 40, 25)] },
    ]);
    const ctx = { settings, sessions: [prev] };
    expect(targets(setsForAddedExercise(hang, plan("2026-11-16"), ctx))).toEqual([
      [30, 25],
      [30, 25],
      [40, 25], // added without a target: carries what was done
    ]);
    expect(targets(setsForAddedExercise({ ...hang, weighted: false }, plan("2026-11-16"), ctx))).toEqual([
      [30, null],
      [30, null],
      [40, null],
    ]);
  });

  it("never pre-fills from a skipped performance, a main-lift block or the session itself", () => {
    const done = withBlock("2026-11-02", [{ exerciseId: 20, measure: "seconds", sets: [logged(30, 30, 20)] }]);
    const skipped = withBlock("2026-11-09", [
      { exerciseId: 20, measure: "seconds", sets: [blankSet({ targetReps: 45, targetWeight: 60 })], skipped: true },
    ]);
    const primary = withBlock("2026-11-10", [{ exerciseId: 20, measure: "seconds", sets: [logged(50, 50, 90)] }], "primary");
    const today = withBlock("2026-11-16", [{ exerciseId: 20, measure: "seconds", sets: [logged(60, 60, 99)] }]);
    const sets = setsForAddedExercise(hang, plan("2026-11-16"), { settings, sessions: [done, skipped, primary, today] });
    expect(targets(sets)).toEqual([[30, 20]]);
  });

  it("agrees with the session pre-fill for a carry last done only in a deload week", () => {
    // Default program: week 5 (Nov 30 – Dec 6) is the deload; Dec 4 and Dec 11 are Fridays.
    const deloadFriday = withBlock("2026-12-04", [{ exerciseId: 21, measure: "meters", sets: [logged(40, 30, 80), logged(40, 40, 80)] }]);
    expect(deloadFriday.deload).toBe(true);
    const library: Exercise[] = [
      ...exercises,
      { id: 21, name: "Farmer's carry", category: "carry", tracksMax: false, measure: "meters", weighted: true, archived: false },
    ];
    const next = buildSession("2026-12-11", { settings, exercises: library, maxEntries, sessions: [deloadFriday] });
    expect(next.deload).toBe(false);
    const prefilled = next.blocks.find((b) => b.kind === "accessory")!.exercises[0]!;
    expect(targets(prefilled.sets)).toEqual([
      [40, 100],
      [40, 100],
    ]);
    // Added by hand to the same day instead: the same sets (scaled back up from 80%, targets kept).
    expect(targets(setsForAddedExercise(carry, plan("2026-12-11"), { settings, sessions: [deloadFriday] }))).toEqual(targets(prefilled.sets));
  });

  it("deloads into a deload week, and prefers a normal week's performance", () => {
    const normalFriday = withBlock("2026-11-27", [{ exerciseId: 21, measure: "meters", sets: [logged(40, 40, 100)] }]);
    const deloadFriday = withBlock("2026-12-04", [{ exerciseId: 21, measure: "meters", sets: [logged(40, 30, 80), logged(40, 40, 80)] }]);
    expect(plan("2026-12-04").deload).toBe(true);
    expect(targets(setsForAddedExercise(carry, plan("2026-12-04"), { settings, sessions: [normalFriday] }))).toEqual([[40, 80]]);
    expect(targets(setsForAddedExercise(carry, plan("2026-12-11"), { settings, sessions: [normalFriday, deloadFriday] }))).toEqual([
      [40, 100],
    ]);
  });
});

describe("loads of weighted and unweighted exercises", () => {
  const pending = blankSet({ targetReps: 10, targetWeight: 25 });

  it("logs an unweighted exercise's set without the target load it still holds", () => {
    expect(logAtTargets(pending, false)).toMatchObject({ done: true, reps: 10, weight: null, targetWeight: 25 });
    expect(logAtTargets(pending, true)).toMatchObject({ done: true, reps: 10, weight: 25 });
    expect(logAtTargets({ ...pending, weight: 30, reps: 8 }, true)).toMatchObject({ reps: 8, weight: 30 });
    expect(logAtTargets({ ...pending, weight: 30 }, false).weight).toBeNull();
    expect([loggedWeightFor(pending, true), loggedWeightFor(pending, false)]).toEqual([25, null]);
    expect([effectiveTargetWeight(pending, true), effectiveTargetWeight(pending, false)]).toEqual([25, null]);
  });

  it("shows an already-logged load as data, but no pending target load, once unweighted", () => {
    const done = { ...pending, done: true, reps: 10, weight: 30 };
    expect([shownLoad(done, false), shownLoad(done, true)]).toEqual([30, 30]);
    expect([shownLoad(pending, false), shownLoad(pending, true)]).toEqual([null, 25]);
    expect(shownLoad({ ...pending, done: true }, true)).toBeNull(); // logged without a load
  });

  it("counts no volume for a Pull-up pre-filled at 25 lb, made unweighted, then logged", () => {
    const pullups = (weighted: boolean): Session => ({
      ...buildSession("2026-11-16", { settings, exercises: [], maxEntries: [], sessions: [] }),
      blocks: [
        {
          id: "b",
          kind: "accessory",
          exercises: [{ exerciseId: 30, measure: "reps", sets: [logAtTargets(blankSet({ targetReps: 10, targetWeight: 25 }), weighted)] }],
        },
      ],
    });
    expect(sessionVolume(pullups(false))).toBe(0);
    expect(sessionVolume(pullups(true))).toBe(250);
  });

  it("asks for a load before one tap logs a weighted set that has none", () => {
    const none = blankSet({ targetReps: 10 });
    expect(needsLoadBeforeLogging(none, true)).toBe(true);
    expect(needsLoadBeforeLogging({ ...none, targetWeight: 0 }, true)).toBe(true);
    expect(needsLoadBeforeLogging({ ...none, targetWeight: 25 }, true)).toBe(false);
    expect(needsLoadBeforeLogging({ ...none, weight: 25 }, true)).toBe(false);
    expect(needsLoadBeforeLogging({ ...none, done: true }, true)).toBe(false); // unlogging needs nothing
    expect(needsLoadBeforeLogging(none, false)).toBe(false);
  });

  it("adds a set after the last one: its load only for a weighted exercise", () => {
    const legacy = blankSet({ targetReps: 10, targetWeight: 25, reps: 8, weight: 30, done: true });
    expect(nextSetAfter(legacy, false)).toMatchObject({ targetReps: 8, targetWeight: null, weight: null, done: false });
    expect(nextSetAfter(legacy, true)).toMatchObject({ targetReps: 8, targetWeight: 30, done: false });
    expect(nextSetAfter(blankSet({ targetReps: 12, targetWeight: 25 }), true)).toMatchObject({ targetReps: 12, targetWeight: 25 });
    expect(nextSetAfter(undefined, true)).toMatchObject({ targetReps: null, targetWeight: null });
    expect(nextSetAfter(legacy, true).id).not.toBe(legacy.id);
  });
});

describe("carrying numbers across weeks", () => {
  const set = (weight: number, target: number | null, reps: number | null, done = true) =>
    blankSet({ id: `s${weight}-${target}-${reps}`, targetReps: target, targetWeight: weight, reps, weight: done ? weight : null, done });
  const session = (date: string, ex: Session["blocks"][number]["exercises"]): Session => ({
    ...buildSession(date, { settings, exercises: [], maxEntries: [], sessions: [] }),
    blocks: [{ id: `b-${date}`, kind: "accessory", exercises: ex }],
  });
  const fly = (s: Session) => s.blocks.find((b) => b.kind === "accessory")!.exercises.find((e) => e.exerciseId === 10)!;
  // Default program: cycle starts Mon 2026-11-02, week 5 (Nov 30 – Dec 6) is the deload.

  it("keeps a missed rep from becoming next week's target", () => {
    const last = session("2026-11-09", [
      { exerciseId: 10, measure: "reps", sets: [set(50, 12, 10), set(50, null, 8)] }, // 2nd set added by the athlete
    ]);
    const next = buildSession("2026-11-16", { settings, exercises, maxEntries, sessions: [last] });
    expect(fly(next).sets.map((s) => [s.targetReps, s.targetWeight])).toEqual([
      [12, 50],
      [8, 50],
    ]);
  });

  it("never carries a deload load into a normal week after a skip", () => {
    const normal = session("2026-11-23", [{ exerciseId: 10, measure: "reps", sets: [set(50, 12, 12)] }]);
    const deload = session("2026-11-30", [{ exerciseId: 10, measure: "reps", sets: [set(40, 12, 12)] }]);
    expect(deload.deload).toBe(true);
    const skipped = session("2026-12-07", [{ exerciseId: 10, measure: "reps", sets: [set(50, 12, null, false)], skipped: true }]);
    const next = buildSession("2026-12-14", { settings, exercises, maxEntries, sessions: [normal, deload, skipped] });
    expect(fly(next).sets[0]!.targetWeight).toBe(50); // from Nov 23, not the deload's 40

    // Only a deload performance exists: its load is scaled back up (40 / 0.8 = 50).
    const onlyDeload = buildSession("2026-12-14", { settings, exercises, maxEntries, sessions: [deload, skipped] });
    expect(fly(onlyDeload).sets[0]!.targetWeight).toBe(50);
    // …and so is a deload week used as the template itself.
    const fromDeload = buildSession("2026-12-07", { settings, exercises, maxEntries, sessions: [deload] });
    expect(fly(fromDeload).sets[0]!.targetWeight).toBe(50);
  });

  it("pre-fills and deloads the load of a weighted hold and carry like any other accessory", () => {
    const loaded: Exercise[] = [
      ...exercises,
      { id: 20, name: "Weighted hang", category: "accessory", tracksMax: false, measure: "seconds", weighted: true, archived: false },
      { id: 21, name: "Farmer's carry", category: "carry", tracksMax: false, measure: "meters", weighted: true, archived: false },
    ];
    const normal = session("2026-11-23", [
      { exerciseId: 20, measure: "seconds", sets: [set(25, 30, 30)] },
      { exerciseId: 21, measure: "meters", sets: [set(100, 40, 40)] },
    ]);
    const ex = (s: Session, id: number) => s.blocks.find((b) => b.kind === "accessory")!.exercises.find((e) => e.exerciseId === id)!;
    const deload = buildSession("2026-11-30", { settings, exercises: loaded, maxEntries, sessions: [normal] });
    expect(deload.deload).toBe(true);
    expect([ex(deload, 20).sets[0]!.targetReps, ex(deload, 20).sets[0]!.targetWeight]).toEqual([30, 20]);
    expect([ex(deload, 21).sets[0]!.targetReps, ex(deload, 21).sets[0]!.targetWeight]).toEqual([40, 80]);
    const next = buildSession("2026-11-23", {
      settings,
      exercises: loaded,
      maxEntries,
      sessions: [session("2026-11-16", normal.blocks[0]!.exercises)],
    });
    expect(ex(next, 21).sets[0]!.targetWeight).toBe(100);
  });

  it("carries no load for an unweighted exercise (an old load stays in its own session)", () => {
    const bodyweight: Exercise[] = exercises.map((e) => (e.id === 10 ? { ...e, weighted: false } : e));
    const last = session("2026-11-09", [{ exerciseId: 10, measure: "reps", sets: [set(50, 12, 12)] }]);
    const next = buildSession("2026-11-16", { settings, exercises: bodyweight, maxEntries, sessions: [last] });
    expect(fly(next).sets.map((s) => [s.targetReps, s.targetWeight])).toEqual([[12, null]]);
    // Without the flag (an exercise saved before it existed) the load carries, as it always did.
    const legacy = exercises.map((e) => (e.id === 10 ? (({ weighted: _w, ...rest }) => rest)(e) : e)) as Exercise[];
    expect(fly(buildSession("2026-11-16", { settings, exercises: legacy, maxEntries, sessions: [last] })).sets[0]!.targetWeight).toBe(50);
  });

  it("counts only rep-measured sets toward volume, and an unloaded set as 0", () => {
    const s = session("2026-11-16", [
      { exerciseId: 10, measure: "reps", sets: [set(50, 10, 10)] },
      { exerciseId: 20, measure: "seconds", sets: [set(25, 30, 30)] },
      { exerciseId: 21, measure: "meters", sets: [set(100, 40, 40)] },
      { exerciseId: 22, measure: "reps", sets: [blankSet({ targetReps: 8, reps: 8, done: true })] },
    ]);
    expect(sessionVolume(s)).toBe(500);
  });

  it("bases the progression hint on the last normal week, against that session's targets", () => {
    const normal = session("2026-11-23", [{ exerciseId: 10, measure: "reps", sets: [set(50, 12, 12)] }]);
    const deload = session("2026-11-30", [{ exerciseId: 10, measure: "reps", sets: [set(40, 12, 12)] }]);
    expect(accessoryHint(10, "2026-12-07", [normal, deload], 5, W)?.suggestedWeight).toBe(55);
    const short = session("2026-11-23", [{ exerciseId: 10, measure: "reps", sets: [set(50, 12, 11)] }]);
    expect(accessoryHint(10, "2026-12-07", [short, deload], 5, W)).toMatchObject({ kind: "hold", suggestedWeight: 50 });
  });
});

describe("plan signature", () => {
  const ctx = { settings, exercises, maxEntries, sessions: [] as Session[] };

  it("is stored by buildSession and null without a main lift", () => {
    const s = buildSession("2026-11-02", ctx);
    expect(s.planSig).toBe(planSignature("2026-11-02", ctx));
    expect(typeof s.planSig).toBe("string");
    expect(buildSession("2026-11-06", ctx).planSig).toBeNull();
    expect(planSignature("2026-11-06", ctx)).toBeNull();
  });

  it("flags program and max changes, but not the athlete's own edits", () => {
    const s = buildSession("2026-11-02", ctx);
    expect(planChanged(s, ctx)).toBe(false);
    const primary = s.blocks[0]!;
    const edited: Session = {
      ...s,
      blocks: [
        {
          ...primary,
          exercises: [
            { ...primary.exercises[0]!, sets: primary.exercises[0]!.sets.map((x) => ({ ...x, targetWeight: 135, targetReps: 3 })) },
          ],
        },
      ],
    };
    expect(planChanged(edited, ctx)).toBe(false);
    expect(planChanged({ ...edited, blocks: [] }, ctx)).toBe(false);

    const newMax: MaxEntry = { ...maxEntries[0]!, id: 2, valueLb: 335, createdAt: "2026-11-01T01:00:00Z" };
    expect(planChanged(s, { ...ctx, maxEntries: [...maxEntries, newMax] })).toBe(true);
    const noAmrap = { ...settings, program: { ...settings.program, amrapLastSet: false } };
    expect(planChanged(s, { ...ctx, settings: noAmrap })).toBe(true);
    // A day that had no main lift gains one.
    const days = { ...settings.program.days, "5": { label: "Carries", primaryExerciseId: 1, progression: false } };
    expect(
      planChanged(buildSession("2026-11-06", ctx), { ...ctx, settings: { ...settings, program: { ...settings.program, days } } }),
    ).toBe(true);
  });

  it("falls back to comparing sets for sessions saved before the signature existed", () => {
    const { planSig: _sig, ...legacy } = buildSession("2026-11-02", ctx);
    expect(planChanged(legacy, ctx)).toBe(false);
    const newMax: MaxEntry = { ...maxEntries[0]!, id: 2, valueLb: 335, createdAt: "2026-11-01T01:00:00Z" };
    expect(planChanged(legacy, { ...ctx, maxEntries: [...maxEntries, newMax] })).toBe(true);
  });
});

describe("sessionCounts", () => {
  it("counts logged and total sets, leaving out skipped exercises", () => {
    const s: Session = {
      ...buildSession("2026-11-06", { settings, exercises: [], maxEntries: [], sessions: [] }),
      blocks: [
        {
          id: "a",
          kind: "accessory",
          exercises: [
            { exerciseId: 10, measure: "reps", sets: [blankSet({ done: true }), blankSet()] },
            { exerciseId: 11, measure: "seconds", sets: [blankSet({ done: true }), blankSet({ done: true })], skipped: true },
          ],
        },
        { id: "b", kind: "accessory", exercises: [{ exerciseId: 12, measure: "reps", sets: [blankSet({ done: true })] }] },
      ],
    };
    expect(sessionCounts(s)).toEqual({ done: 2, total: 3 });
  });
});

describe("skipping the main lift", () => {
  const ctx = { settings, exercises, maxEntries, sessions: [] as Session[] };
  const skipMain = (s: Session): Session => ({ ...s, blocks: s.blocks.map((b) => (b.kind === "primary" ? { ...b, skipped: true } : b)) });

  it("leaves its sets out of the counts and the volume", () => {
    const s = buildSession("2026-11-02", ctx);
    const withAccessory: Session = {
      ...s,
      blocks: [
        ...s.blocks.map((b) => ({
          ...b,
          exercises: b.exercises.map((e) => ({ ...e, sets: e.sets.map((x) => ({ ...x, done: true, reps: 6 })) })),
        })),
        {
          id: "acc",
          kind: "accessory",
          exercises: [{ exerciseId: 10, measure: "reps", sets: [blankSet({ done: true, reps: 10, weight: 50 }), blankSet()] }],
        },
      ],
    };
    expect(sessionCounts(withAccessory)).toEqual({ done: 5, total: 6 });
    const skipped = skipMain(withAccessory);
    expect(sessionCounts(skipped)).toEqual({ done: 1, total: 2 });
    expect(sessionVolume(skipped)).toBe(500);
    // Nothing else to log: a session with only the skipped main lift has no open sets to finish.
    expect(sessionCounts(skipMain(s))).toEqual({ done: 0, total: 0 });
  });

  it("is not a plan change", () => {
    const s = buildSession("2026-11-02", ctx);
    expect(planChanged(skipMain(s), ctx)).toBe(false);
    const { planSig: _sig, ...legacy } = skipMain(s);
    expect(planChanged(legacy, ctx)).toBe(false);
  });
});

describe("buildSessionFrom (do this session today)", () => {
  const ctx = { settings, exercises, maxEntries, sessions: [] as Session[] };

  it("saves the source day's plan under the target date", () => {
    // Monday's bench, done on Sunday.
    const s = buildSessionFrom("2026-11-09", "2026-11-08", ctx);
    const monday = buildSession("2026-11-09", ctx);
    expect(s.date).toBe("2026-11-08");
    expect(s.plannedFor).toBe("2026-11-09");
    expect(s.label).toBe(monday.label);
    expect([s.cycle, s.week, s.deload, s.primaryMaxLb]).toEqual([monday.cycle, monday.week, monday.deload, monday.primaryMaxLb]);
    expect(s.blocks[0]!.exercises[0]!.sets.map((x) => [x.targetReps, x.targetWeight, x.amrap])).toEqual(
      monday.blocks[0]!.exercises[0]!.sets.map((x) => [x.targetReps, x.targetWeight, x.amrap]),
    );
    expect(s.planSig).toBe(monday.planSig);
    // The plan check follows the source day, not the date it was moved to.
    expect(planChanged(s, ctx)).toBe(false);
    expect(planMatches(s, ctx)).toBe(true);
    // Same day: nothing moved.
    expect(buildSessionFrom("2026-11-09", "2026-11-09", ctx).plannedFor).toBeNull();
  });

  it("carries the source day's accessories, and later counts as a session of that day type", () => {
    const lastMonday: Session = {
      ...buildSession("2026-11-02", ctx),
      blocks: [
        {
          id: "acc",
          kind: "accessory",
          exercises: [{ exerciseId: 10, measure: "reps", sets: [blankSet({ targetReps: 12, weight: 50, reps: 12, done: true })] }],
        },
      ],
    };
    const moved = buildSessionFrom("2026-11-09", "2026-11-08", { ...ctx, sessions: [lastMonday] });
    const acc = moved.blocks.find((b) => b.kind === "accessory")!;
    expect(acc.exercises[0]!.sets.map((x) => [x.targetReps, x.targetWeight])).toEqual([[12, 50]]);
    // The Sunday session (a Monday plan) is the template for the next Monday.
    const done: Session = {
      ...moved,
      blocks: [
        {
          id: "acc2",
          kind: "accessory",
          exercises: [{ exerciseId: 10, measure: "reps", sets: [blankSet({ targetReps: 12, weight: 55, reps: 12, done: true })] }],
        },
      ],
    };
    const next = buildSession("2026-11-16", { ...ctx, sessions: [lastMonday, done] });
    expect(next.blocks.find((b) => b.kind === "accessory")!.exercises[0]!.sets[0]!.targetWeight).toBe(55);
  });
});

describe("nextSession", () => {
  it("is the next program day after today, with its lift and week", () => {
    // Program starts Mon Nov 2; Mon–Thu have main lifts, Fri is carries.
    expect(nextSession("2026-11-01", { settings, exercises })).toEqual({
      date: "2026-11-02",
      label: "Push",
      liftName: "Bench press",
      weekLabel: settings.program.weeks[0]!.label,
    });
    expect(nextSession("2026-11-02", { settings, exercises })).toMatchObject({ date: "2026-11-03", liftName: "Deadlift" });
    // Friday → the carry day has no main lift.
    expect(nextSession("2026-11-05", { settings, exercises })).toMatchObject({ date: "2026-11-06", liftName: null });
    // Weekend → Monday of week 2.
    expect(nextSession("2026-11-07", { settings, exercises })).toMatchObject({
      date: "2026-11-09",
      weekLabel: settings.program.weeks[1]!.label,
    });
  });

  it("passes over a day whose session was done early, and gives up after 14 days", () => {
    const early = { ...buildSessionFrom("2026-11-09", "2026-11-08", { settings, exercises, maxEntries, sessions: [] }) };
    expect(nextSession("2026-11-08", { settings, exercises, sessions: [early] })).toMatchObject({ date: "2026-11-10" });
    const noDays = { ...settings, program: { ...settings.program, days: {} } };
    expect(nextSession("2026-11-08", { settings: noDays, exercises })).toBeNull();
    // Before the first cycle starts, nothing is scheduled.
    const late = { ...settings, program: { ...settings.program, cycleStartDate: "2027-01-04" } };
    expect(nextSession("2026-11-08", { settings: late, exercises })).toBeNull();
  });
});
