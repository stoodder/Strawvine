import { describe, expect, it } from "vitest";
import { defaultSettings } from "./defaults";
import { buildModel } from "./insights";
import { achievements, checklist, streaks, type AppData } from "./gamify";
import { emptyDayLog, type Exercise, type MaxEntry, type Session } from "./schemas";
import { accessoryHint, blankSet, buildSession, planChanged, planMatches, planSignature, sessionCounts, sessionVolume } from "./session";
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
    expect(accessoryHint(10, "2026-11-16", [last], 5)).toEqual({
      lastWeight: 50,
      suggestedWeight: 55,
      reason: expect.stringContaining("+5 lb"),
    });
    expect(accessoryHint(10, "2026-11-16", [last], 2.5)?.suggestedWeight).toBe(52.5);
  });

  it("has no hint when a set fell short, had no load, or nothing was logged", () => {
    expect(
      accessoryHint(
        10,
        "2026-11-16",
        [
          sess("2026-11-09", [
            [12, 12, 50, true],
            [10, 12, 50, true],
          ]),
        ],
        5,
      ),
    ).toBeNull();
    expect(accessoryHint(10, "2026-11-16", [sess("2026-11-09", [[12, 12, null, true]])], 5)).toBeNull();
    expect(accessoryHint(10, "2026-11-16", [], 5)).toBeNull();
    expect(accessoryHint(10, "2026-11-16", [sess("2026-11-09", [[12, 12, 50, true]])], 0)).toBeNull();
  });

  it("looks at the most recent non-skipped performance before the date", () => {
    const good = sess("2026-11-02", [[12, 12, 40, true]]);
    const short = sess("2026-11-09", [[8, 12, 50, true]]);
    const skipped = sess("2026-11-16", [[12, 12, 60, true]], true);
    const unlogged = sess("2026-11-17", [[null, 12, 60, false]]);
    expect(accessoryHint(10, "2026-11-23", [good, short, skipped, unlogged], 5)).toBeNull(); // Nov 9 fell short
    expect(accessoryHint(10, "2026-11-09", [good, short, skipped, unlogged], 5)?.suggestedWeight).toBe(45); // before Nov 9
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

  it("bases the progression hint on the last normal week, against that session's targets", () => {
    const normal = session("2026-11-23", [{ exerciseId: 10, measure: "reps", sets: [set(50, 12, 12)] }]);
    const deload = session("2026-11-30", [{ exerciseId: 10, measure: "reps", sets: [set(40, 12, 12)] }]);
    expect(accessoryHint(10, "2026-12-07", [normal, deload], 5)?.suggestedWeight).toBe(55);
    const short = session("2026-11-23", [{ exerciseId: 10, measure: "reps", sets: [set(50, 12, 11)] }]);
    expect(accessoryHint(10, "2026-12-07", [short, deload], 5)).toBeNull();
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
