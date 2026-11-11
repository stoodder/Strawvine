import { describe, expect, it } from "vitest";
import { addDays } from "./dates";
import { defaultSettings } from "./defaults";
import { computeEnergySeries } from "./energy";
import { dateRange } from "./dates";
import { achievements, checklist, closedDates, dayChecklist, isClosed, streaks, type AppData } from "./gamify";
import { buildModel } from "./insights";
import { currentMax, cyclePosition, programDayFor, scheduledProgramDay, shiftCycleStart } from "./program";
import { emptyDayLog, type DayLog, type Exercise, type MaxEntry, type Session, type Settings } from "./schemas";
import { buildSessionFrom, sessionDoneEarly } from "./session";

const ids = { bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 };
// The program's first cycle starts Monday 2026-11-02.
const settings: Settings = { ...defaultSettings(ids, "2026-11-01"), onboarded: true };
const exercises: Exercise[] = [
  { id: 1, name: "Bench press", category: "primary", tracksMax: true, measure: "reps", weighted: true, archived: false },
];
const today = "2026-12-31";

const appData = (patch: Partial<AppData> = {}): AppData => ({ settings, days: [], exercises, maxEntries: [], sessions: [], ...patch });
const find = (data: AppData, key: string) => achievements(data, today).find((a) => a.key === key);
const loggedDay = (date: string): DayLog => ({ ...emptyDayLog(date), weightLb: 200, calories: 3000 });
const weighIn = (date: string, weightLb: number): DayLog => ({ ...emptyDayLog(date), weightLb });
const fullDay = (date: string): DayLog => ({
  ...emptyDayLog(date),
  weightLb: 200,
  calories: 3000,
  steps: 16000,
  metconDone: true,
  zone2Done: true,
});

describe("before the program starts", () => {
  it("doesn't expect a lift on program weekdays before the first cycle", () => {
    const tuesdayBefore = checklist("2026-10-27", fullDay("2026-10-27"), undefined, settings);
    expect(tuesdayBefore.map((i) => i.key)).not.toContain("lift");
    expect(isClosed(tuesdayBefore)).toBe(true);
    expect(checklist("2026-11-03", fullDay("2026-11-03"), undefined, settings).map((i) => i.key)).toContain("lift");
  });

  it("only plans lifts from the program start in the weekly check-in", () => {
    // Week of Wed Oct 28 – Tue Nov 3: program weekdays Oct 28–30 come before the start.
    expect(buildModel(appData(), "2026-11-04").checkin.lifts).toEqual({ planned: 2, done: 0 });
  });
});

describe("the day's checklist, as named", () => {
  it("the morning item is the 'Morning check-in' (it holds sleep and recovery too), still done by the weigh-in alone", () => {
    const date = "2026-11-03";
    const items = (day?: DayLog) => checklist(date, day, undefined, settings);
    const morning = (day?: DayLog) => items(day).find((i) => i.key === "morning")!;
    expect(morning()).toMatchObject({ key: "morning", label: "Morning check-in", done: false });
    expect(items()[0]!.key).toBe("morning");
    // Sleep, HRV and the ratings don't close it; the weight does.
    expect(morning({ ...emptyDayLog(date), sleepMinutes: 450, hrvMs: 60, energy: 4 }).done).toBe(false);
    expect(morning(weighIn(date, 200))).toMatchObject({ label: "Morning check-in", done: true });
    // It leads the list, ahead of Nutrition; the day's own reading (`dayChecklist`) names it the same.
    expect(
      items()
        .slice(0, 2)
        .map((i) => i.label),
    ).toEqual(["Morning check-in", "Nutrition"]);
    expect(dayChecklist(date, appData()).find((i) => i.key === "morning")!.label).toBe("Morning check-in");
  });
});

describe("max PR achievements", () => {
  const initial: MaxEntry = {
    id: 1,
    exerciseId: 1,
    date: "2026-11-01",
    valueLb: 315,
    source: "initial",
    note: null,
    createdAt: "2026-11-01T00:00:00Z",
  };
  const amrap = (id: number): MaxEntry => ({
    ...initial,
    id,
    date: "2026-11-02",
    valueLb: 318,
    source: "amrap",
    createdAt: "2026-11-02T18:00:00Z",
  });

  it("ignores the client's optimistic placeholder and keys the PR by the saved row", () => {
    const withTarget = { ...settings, strengthTargets: [{ id: "t1", exerciseId: 1, targetLb: 318, setOn: "2026-11-01" }] };
    const before = achievements(appData({ settings: withTarget, maxEntries: [initial] }), today);
    expect(achievements(appData({ settings: withTarget, maxEntries: [initial, amrap(-1)] }), today)).toEqual(before);

    const saved = achievements(appData({ settings: withTarget, maxEntries: [initial, amrap(42)] }), today).map((a) => a.key);
    expect(saved.filter((k) => k.startsWith("max-"))).toEqual(["max-42"]);
    expect(saved).toContain("target-t1");
  });
});

describe("which max changes are celebrated as PRs", () => {
  let nextId = 100;
  const entry = (valueLb: number, source: MaxEntry["source"], createdAt: string, date = createdAt.slice(0, 10)): MaxEntry => ({
    id: nextId++,
    exerciseId: 1,
    date,
    valueLb,
    source,
    note: null,
    createdAt,
  });
  const prs = (maxEntries: MaxEntry[]) =>
    achievements(appData({ maxEntries }), today)
      .filter((a) => a.tier === "pr")
      .map((a) => a.title);
  const base = () => entry(300, "initial", "2026-11-01T08:00:00.000Z");

  it("celebrates AMRAP and manual increases of at least 1 lb", () => {
    expect(prs([base(), entry(303, "amrap", "2026-11-02T18:00:00.000Z")])).toEqual(["Bench press 303"]);
    expect(prs([base(), entry(310, "manual", "2026-11-05T18:00:00.000Z")])).toEqual(["Bench press 310"]);
    expect(prs([base(), entry(300.5, "manual", "2026-11-05T18:00:00.000Z")])).toEqual([]);
    expect(prs([base(), entry(320, "initial", "2026-11-05T18:00:00.000Z")])).toEqual([]);
  });

  it("treats a quick re-entry as a correction of the previous entry", () => {
    // Typo 3150, fixed to 315 two minutes later: one PR (+15), keyed like the typo so it isn't re-celebrated.
    const typo = entry(3150, "manual", "2026-11-05T18:00:00.000Z");
    const fix = entry(315, "manual", "2026-11-05T18:02:00.000Z");
    const list = achievements(appData({ maxEntries: [base(), typo, fix] }), today).filter((a) => a.tier === "pr");
    expect(list.map((a) => [a.key, a.title, a.detail])).toEqual([[`max-${typo.id}`, "Bench press 315", "New max, +15 lb."]]);
    // ...and the typo doesn't become a high-water mark that later PRs must beat.
    expect(prs([base(), typo, fix, entry(320, "amrap", "2026-11-09T18:00:00.000Z")])).toContain("Bench press 320");
  });

  it("doesn't celebrate correcting a just-entered max upwards", () => {
    // Onboarding entered 135 instead of 315, fixed a minute later: no PR.
    expect(prs([entry(135, "initial", "2026-11-01T08:00:00.000Z"), entry(315, "manual", "2026-11-01T08:01:00.000Z")])).toEqual([]);
    // Same for a fat-fingered low manual entry (31) corrected to an unchanged max.
    expect(prs([base(), entry(31, "manual", "2026-11-05T18:00:00.000Z"), entry(300, "manual", "2026-11-05T18:01:00.000Z")])).toEqual([]);
  });

  it("only treats manual entries within the window as corrections", () => {
    const amrap = entry(303, "amrap", "2026-11-02T18:00:00.000Z");
    // A second AMRAP application minutes later is still its own PR.
    expect(prs([base(), amrap, entry(306, "amrap", "2026-11-02T18:05:00.000Z")]).sort()).toEqual(["Bench press 303", "Bench press 306"]);
    expect(prs([base(), entry(310, "manual", "2026-11-05T18:00:00.000Z"), entry(320, "manual", "2026-11-05T18:11:00.000Z")])).toHaveLength(
      2,
    );
  });

  it("keeps strength targets off corrected typos", () => {
    const withTarget = { ...settings, strengthTargets: [{ id: "t9", exerciseId: 1, targetLb: 400, setOn: "2026-11-01" }] };
    const maxEntries = [base(), entry(4000, "manual", "2026-11-05T18:00:00.000Z"), entry(305, "manual", "2026-11-05T18:03:00.000Z")];
    expect(achievements(appData({ settings: withTarget, maxEntries }), today).map((a) => a.key)).not.toContain("target-t9");
  });
});

describe("calibration milestones", () => {
  it("awards the first TDEE reading on the first logged day that has a TDEE", () => {
    // 8 days apart: the day before's 7-day weight window is empty, so Nov 10 has no TDEE.
    // Nov 17 is 7 days after Nov 10 — inside the window.
    const days = [loggedDay("2026-11-02"), loggedDay("2026-11-10"), loggedDay("2026-11-17")];
    const data = appData({ days });
    expect(find(data, "calib-1")?.date).toBe("2026-11-02");
    expect(find(data, "calib-2")?.date).toBe("2026-11-17");
    expect(computeEnergySeries(days, "2026-11-02", "2026-11-17").find((d) => d.tdee !== null)?.date).toBe("2026-11-17");
  });

  it("awards it on consecutive logged days as before, and not at all without a TDEE", () => {
    expect(find(appData({ days: [loggedDay("2026-11-02"), loggedDay("2026-11-03")] }), "calib-2")?.date).toBe("2026-11-03");
    expect(find(appData({ days: [loggedDay("2026-11-02"), loggedDay("2026-11-20")] }), "calib-2")).toBeUndefined();
  });

  it("keeps the other milestones on the nth logged day", () => {
    const days = Array.from({ length: 14 }, (_, i) => loggedDay(addDays("2026-11-02", i * 2)));
    const data = appData({ days });
    expect(find(data, "calib-7")?.date).toBe(days[6]!.date);
    expect(find(data, "calib-14")?.date).toBe(days[13]!.date);
  });
});

describe("goal weight achievement", () => {
  const withGoal = (goal: NonNullable<Settings["weightGoal"]>) => ({ ...settings, weightGoal: goal });
  const goalReached = (data: AppData) => achievements(data, today).find((a) => a.key.startsWith("goal-"));

  it("doesn't fire a gain goal straight away when there's no weigh-in before it was set", () => {
    const goal = withGoal({ targetLb: 190, pacePctPerWeek: 0.5, setOn: "2026-11-10" });
    const days = [weighIn("2026-11-12", 180), weighIn("2026-11-20", 185)];
    expect(goalReached(appData({ settings: goal, days }))).toBeUndefined();
    expect(goalReached(appData({ settings: goal, days: [...days, weighIn("2026-12-20", 190.2)] }))?.date).toBe("2026-12-20");
  });

  it("takes the direction from the start weight recorded with the goal", () => {
    // A stale weigh-in above the target would otherwise make this build look like a cut.
    const goal = withGoal({ targetLb: 190, pacePctPerWeek: 0.5, setOn: "2026-11-10", startLb: 180 });
    const days = [weighIn("2026-09-01", 195), weighIn("2026-11-11", 181), weighIn("2026-12-01", 190)];
    expect(goalReached(appData({ settings: goal, days }))?.date).toBe("2026-12-01");
  });

  it("otherwise uses the latest weigh-in on or before the day the goal was set", () => {
    const goal = withGoal({ targetLb: 190, pacePctPerWeek: 1, setOn: "2026-11-10" });
    const days = [weighIn("2026-11-01", 180), weighIn("2026-11-10", 200), weighIn("2026-11-20", 195), weighIn("2026-12-05", 189.8)];
    expect(goalReached(appData({ settings: goal, days }))?.date).toBe("2026-12-05");
  });

  it("has no achievement without any weigh-in", () => {
    expect(goalReached(appData({ settings: withGoal({ targetLb: 190, pacePctPerWeek: 1, setOn: "2026-11-10" }) }))).toBeUndefined();
  });
});

describe("explicit max corrections", () => {
  let nextId = 500;
  const entry = (valueLb: number, source: MaxEntry["source"], createdAt: string): MaxEntry => ({
    id: nextId++,
    exerciseId: 1,
    date: createdAt.slice(0, 10),
    valueLb,
    source,
    note: null,
    createdAt,
  });
  const prs = (maxEntries: MaxEntry[], s: Settings = settings) =>
    achievements(appData({ settings: s, maxEntries }), today)
      .filter((a) => a.tier === "pr")
      .map((a) => a.title);
  const base = () => entry(300, "initial", "2026-11-01T08:00:00.000Z");

  it("is never a PR, even when it raises the max", () => {
    expect(prs([base(), entry(320, "correction", "2026-11-05T18:00:00.000Z")])).toEqual([]);
  });

  it("becomes the current max and resets the high-water mark later PRs are measured against", () => {
    // A typo celebrated days ago (3150) is corrected to 315; 320 next week is a real PR again.
    const list = [
      base(),
      entry(3150, "manual", "2026-11-02T18:00:00.000Z"),
      entry(315, "correction", "2026-11-06T18:00:00.000Z"),
      entry(320, "amrap", "2026-11-09T18:00:00.000Z"),
    ];
    expect(prs(list)).toEqual(["Bench press 320", "Bench press 3150"]);
    expect(currentMax(list, 1)?.valueLb).toBe(320);
    // Lowering the max (a bad week, an injury) makes the next small gain a PR too.
    expect(prs([base(), entry(280, "correction", "2026-11-06T18:00:00.000Z"), entry(290, "manual", "2026-11-20T18:00:00.000Z")])).toEqual([
      "Bench press 290",
    ]);
  });

  it("replaces a just-entered typo like a quick manual re-entry, without celebrating it", () => {
    const typo = entry(3150, "manual", "2026-11-05T18:00:00.000Z");
    const fix = entry(315, "correction", "2026-11-05T18:03:00.000Z");
    expect(prs([base(), typo, fix])).toEqual([]);
    // Re-typing the correction a minute later is still a correction.
    expect(prs([base(), typo, fix, entry(316, "manual", "2026-11-05T18:04:00.000Z")])).toEqual([]);
  });

  it("never hits a strength target by itself", () => {
    const withTarget = { ...settings, strengthTargets: [{ id: "t5", exerciseId: 1, targetLb: 320, setOn: "2026-11-01" }] };
    const keys = (maxEntries: MaxEntry[]) => achievements(appData({ settings: withTarget, maxEntries }), today).map((a) => a.key);
    expect(keys([base(), entry(325, "correction", "2026-11-06T18:00:00.000Z")])).not.toContain("target-t5");
    expect(keys([base(), entry(325, "correction", "2026-11-06T18:00:00.000Z"), entry(326, "amrap", "2026-11-09T18:00:00.000Z")])).toContain(
      "target-t5",
    );
  });
});

describe("AMRAP rep PRs", () => {
  const amrapSession = (
    date: string,
    reps: number | null,
    weight: number,
    opts: { done?: boolean; exerciseId?: number; skipped?: boolean } = {},
  ): Session => ({
    date,
    label: "Push",
    cycle: 1,
    week: 1,
    deload: false,
    primaryMaxLb: 315,
    notes: "",
    completedAt: null,
    blocks: [
      {
        id: `p-${date}`,
        kind: "primary",
        exercises: [
          {
            exerciseId: opts.exerciseId ?? 1,
            measure: "reps",
            skipped: opts.skipped,
            sets: [
              { id: "a", targetReps: 6, targetWeight: weight, reps: 6, weight, done: true, amrap: false, appliedProgressionLb: null },
              {
                id: "b",
                targetReps: 6,
                targetWeight: weight,
                reps,
                weight,
                done: opts.done ?? true,
                amrap: true,
                appliedProgressionLb: null,
              },
            ],
          },
        ],
      },
    ],
  });
  const repPrs = (sessions: Session[]) =>
    achievements(appData({ sessions }), today)
      .filter((a) => a.key.startsWith("amrap-"))
      .map((a) => [a.key, a.title, a.detail]);

  it("celebrates beating the best earlier AMRAP at the same or a heavier load", () => {
    expect(repPrs([amrapSession("2026-11-02", 9, 200), amrapSession("2026-12-07", 11, 200)])).toEqual([
      ["amrap-2026-12-07-1", "Bench press rep PR", "11 @ 200 lb"],
    ]);
    // 10 @ 195 vs 12 earlier at a heavier 200: no PR. 13 @ 195 is.
    expect(repPrs([amrapSession("2026-11-02", 12, 200), amrapSession("2026-12-07", 10, 195)])).toEqual([]);
    expect(repPrs([amrapSession("2026-11-02", 12, 200), amrapSession("2026-12-07", 13, 195)])).toHaveLength(1);
  });

  it("needs an earlier AMRAP at that load or heavier, and only counts logged, not-skipped sets", () => {
    expect(repPrs([amrapSession("2026-11-02", 9, 200)])).toEqual([]);
    expect(repPrs([amrapSession("2026-11-02", 9, 200), amrapSession("2026-12-07", 12, 210)])).toEqual([]);
    expect(repPrs([amrapSession("2026-11-02", 9, 200), amrapSession("2026-12-07", 12, 200, { done: false })])).toEqual([]);
    expect(repPrs([amrapSession("2026-11-02", 9, 200), amrapSession("2026-12-07", 12, 200, { skipped: true })])).toEqual([]);
    expect(repPrs([amrapSession("2026-11-02", 9, 200), amrapSession("2026-12-07", 12, 200, { exerciseId: 2 })])).toEqual([]);
  });

  it("ignores a main lift skipped today", () => {
    const skippedMain = (s: Session): Session => ({ ...s, blocks: s.blocks.map((b) => ({ ...b, skipped: true })) });
    expect(repPrs([amrapSession("2026-11-02", 9, 200), skippedMain(amrapSession("2026-12-07", 12, 200))])).toEqual([]);
    // …and it doesn't set a baseline either.
    expect(repPrs([skippedMain(amrapSession("2026-11-02", 9, 200)), amrapSession("2026-12-07", 12, 200)])).toEqual([]);
  });
});

describe("benchmark PR achievements", () => {
  const metcon = (date: string, name: string, score: string): DayLog => ({
    ...emptyDayLog(date),
    metconDone: true,
    metconBenchmark: name,
    metconScore: score,
  });

  it("celebrates a parseable score that beats the previous best, not the first one", () => {
    const days = [metcon("2026-11-02", "Fran", "4:02"), metcon("2026-11-16", "fran ", "4:10"), metcon("2026-11-30", "Fran", "3:45")];
    const list = achievements(appData({ days }), today).filter((a) => a.key.startsWith("bench-"));
    expect(list).toEqual([
      { key: "bench-fran-2026-11-30", title: "Fran PR", detail: "3:45 · previous 4:02", date: "2026-11-30", tier: "pr" },
    ]);
  });

  it("ignores results after today", () => {
    const days = [metcon("2026-11-02", "Cindy", "18+3"), metcon("2027-01-04", "Cindy", "20+1")];
    expect(achievements(appData({ days }), today).filter((a) => a.key.startsWith("bench-"))).toEqual([]);
  });
});

describe("moved sessions (do this session today)", () => {
  // Sun Nov 8 does Mon Nov 9's plan (bench, cycle 1 week 2); Monday itself holds nothing.
  const ctx = { settings, exercises, maxEntries: [] as MaxEntry[], sessions: [] as Session[] };
  const moved = (done: boolean, date = "2026-11-08", plan = "2026-11-09"): Session => ({
    ...buildSessionFrom(plan, date, ctx),
    completedAt: done ? `${date}T18:00:00.000Z` : null,
  });
  const lift = (date: string, data: Pick<AppData, "days" | "sessions" | "settings">) =>
    dayChecklist(date, data).find((i) => i.key === "lift");

  it("finds the session that did a day's plan elsewhere, completed before only saved", () => {
    const saved = moved(false, "2026-11-07");
    const done = moved(true);
    expect(sessionDoneEarly("2026-11-09", [saved])).toBe(saved);
    expect(sessionDoneEarly("2026-11-09", [saved, done])).toBe(done);
    expect(sessionDoneEarly("2026-11-09", [done, saved])).toBe(done);
    expect(sessionDoneEarly("2026-11-08", [done])).toBeNull();
    // A session for its own date isn't "moved".
    expect(sessionDoneEarly("2026-11-09", [{ ...done, date: "2026-11-09", plannedFor: "2026-11-09" }])).toBeNull();
  });

  it("closes the source day's lift and gives the receiving rest day a lift of its own", () => {
    const data = appData({ days: [fullDay("2026-11-08"), fullDay("2026-11-09")], sessions: [moved(true)] });
    expect(lift("2026-11-09", data)).toMatchObject({ done: true, doneOn: "2026-11-08" });
    expect(lift("2026-11-08", data)).toMatchObject({ done: true, movedFrom: "2026-11-09" });
    expect(isClosed(dayChecklist("2026-11-09", data))).toBe(true);
    expect(isClosed(dayChecklist("2026-11-08", data))).toBe(true);
    // Before it's completed: the rest day expects it, and Monday's plan isn't done yet.
    const open = { ...data, sessions: [moved(false)] };
    expect(lift("2026-11-08", open)).toMatchObject({ done: false, movedFrom: "2026-11-09" });
    expect(lift("2026-11-09", open)).toMatchObject({ done: false });
    expect(lift("2026-11-09", open)!.doneOn).toBeUndefined();
    // Without a moved session a Sunday has no lift (and the old `checklist` is unchanged).
    expect(lift("2026-11-08", appData({ days: [fullDay("2026-11-08")] }))).toBeUndefined();
    expect(checklist("2026-11-09", fullDay("2026-11-09"), undefined, settings).find((i) => i.key === "lift")!.done).toBe(false);
  });

  it("keeps the streak going across the moved session", () => {
    const days = dateRange("2026-11-02", "2026-11-09").map(fullDay);
    const sessions: Session[] = [
      ...dateRange("2026-11-02", "2026-11-06").map((d) => ({ ...buildSessionFrom(d, d, ctx), completedAt: `${d}T18:00:00.000Z` })),
      moved(true),
    ];
    const data = appData({ days, sessions });
    expect(closedDates(data, "2026-11-09").has("2026-11-09")).toBe(true);
    expect(streaks(data, "2026-11-10")).toMatchObject({ current: 8, best: 8 });
    // Undo the move: Monday's lift is open again and the streak stops at Sunday.
    expect(streaks(appData({ days, sessions: sessions.slice(0, -1) }), "2026-11-10").current).toBe(0);
  });

  it("credits the week's check-in by plan", () => {
    const sessions: Session[] = [
      ...dateRange("2026-11-03", "2026-11-06").map((d) => ({ ...buildSessionFrom(d, d, ctx), completedAt: `${d}T18:00:00.000Z` })),
      moved(true),
    ];
    // Tue Nov 3 – Mon Nov 9: five program days, all done (Monday's on Sunday).
    expect(buildModel(appData({ sessions }), "2026-11-10").checkin.lifts).toEqual({ planned: 5, done: 5 });
    expect(buildModel(appData({ sessions: sessions.slice(0, -1) }), "2026-11-10").checkin.lifts).toEqual({ planned: 5, done: 4 });
    // A program day that did another day's plan hasn't done its own (Tue did Wed's, Wed rested).
    const tueDidWed = [{ ...moved(true, "2026-11-03", "2026-11-04") }];
    expect(buildModel(appData({ sessions: tueDidWed }), "2026-11-10").checkin.lifts).toEqual({ planned: 5, done: 1 });
  });

  it("credits a cycle by the day the session was planned for", () => {
    // Sun Dec 6 is cycle 1's last day; doing Mon Dec 7's plan on it is cycle 2's work.
    const s = moved(true, "2026-12-06", "2026-12-07");
    expect(cyclePosition(settings.program, "2026-12-06")!.cycle).toBe(1);
    const keys = (today: string) => achievements(appData({ sessions: [s] }), today).map((a) => a.key);
    expect(keys("2026-12-31")).not.toContain("cycle-1");
    expect(keys("2027-01-10")).toContain("cycle-2");
  });

  it("a cycle's completion follows the program: skipping ahead a week makes it appear, dated the new last day; moving back takes it away", () => {
    // Cycle 1 runs Oct 5 – Nov 8; Thursday Nov 5 is in its last week, with work done earlier in it.
    const program = { ...settings.program, cycleStartDate: "2026-10-05" };
    const s = { ...buildSessionFrom("2026-10-26", "2026-10-26", ctx), completedAt: "2026-10-26T18:00:00.000Z" };
    const cycles = (p: typeof program, on: string) =>
      achievements(appData({ settings: { ...settings, program: p }, sessions: [s] }), on)
        .filter((a) => a.key.startsWith("cycle-"))
        .map((a) => `${a.key}@${a.date}`);
    expect(cycles(program, "2026-11-05")).toEqual([]);
    // A week earlier: the cycle ended last Sunday — the same key the real completion will have.
    const ahead = shiftCycleStart(program, -1);
    expect(cycles(ahead, "2026-11-05")).toEqual(["cycle-1@2026-11-01"]);
    // Undone: gone again; and on the real last day it is there, under that key.
    expect(cycles(shiftCycleStart(ahead, 1), "2026-11-05")).toEqual([]);
    expect(cycles(program, "2026-11-08")).toEqual(["cycle-1@2026-11-08"]);
  });

  it("memoizes each day's checklist on the day log, the sessions and the settings", () => {
    const day = fullDay("2026-11-09");
    const data = appData({ days: [day], sessions: [moved(false)] });
    const first = dayChecklist("2026-11-09", data);
    // A new days array (another day edited) keeps this day's checklist.
    expect(dayChecklist("2026-11-09", { ...data, days: [day, fullDay("2026-11-10")] })).toBe(first);
    // Completing the moved session (a new session object) recomputes it.
    const after = dayChecklist("2026-11-09", { ...data, sessions: [moved(true)] });
    expect(after).not.toBe(first);
    expect(after.find((i) => i.key === "lift")!.done).toBe(true);
    // So does editing the day itself.
    expect(dayChecklist("2026-11-09", { ...data, days: [{ ...day, steps: 0 }] }).find((i) => i.key === "steps")!.done).toBe(false);
  });
});

describe("scheduledProgramDay", () => {
  it("matches the cycle position rule exactly", () => {
    const programs = [
      settings.program,
      { ...settings.program, weeks: [] },
      { ...settings.program, cycleStartDate: "2026-11-04" },
      { ...settings.program, days: { "0": settings.program.days["1"]! } },
    ];
    for (const program of programs)
      for (const date of dateRange("2026-10-20", "2027-02-01"))
        expect(scheduledProgramDay(program, date)).toBe(cyclePosition(program, date) ? programDayFor(program, date) : null);
  });
});
