/**
 * Plans over time (SPEC §6.4): a date reads under the plan in force on it; cycle numbers continue
 * across plans; setting up, cancelling and moving plans; the choice at the end of a cycle (§7); and
 * the pre-fill that follows the program day rather than the weekday (§6.5).
 */
import { describe, expect, it } from "vitest";
import { addDays, dateRange, weekdayOf } from "./dates";
import { defaultSettings } from "./defaults";
import { achievements, checklist, type AppData } from "./gamify";
import {
  cancelPlan,
  currentPlan,
  cycleEndCard,
  newCycleStart,
  nextPlan,
  offersCycleChoice,
  planList,
  removeNewPlan,
  repeatCycleKey,
  restorePlan,
  startNewCycle,
  updatePlan,
  withPlans,
} from "./plans";
import {
  cyclePosition,
  planAt,
  planTargets,
  planTimeline,
  previewCycleShift,
  programDayFor,
  scheduledProgramDay,
  shiftCycleStart,
  shiftRefusal,
} from "./program";
import { emptyDayLog, settingsSchema, type Exercise, type Session, type Settings } from "./schemas";
import { blankSet, buildSession, planDateOf, templateSource } from "./session";

const ids = { bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 };
// Cycle 1: Oct 5 – Nov 8, cycle 2: Nov 9 – Dec 13, cycle 3 from Dec 14 (five-week cycles).
const base: Settings = { ...defaultSettings(ids, "2026-10-01"), onboarded: true };
const exercises: Exercise[] = [
  { id: 1, name: "Bench press", category: "primary", tracksMax: true, measure: "reps", weighted: true, archived: false },
  { id: 2, name: "Deadlift", category: "primary", tracksMax: true, measure: "reps", weighted: true, archived: false },
  { id: 3, name: "Back squat", category: "primary", tracksMax: true, measure: "reps", weighted: true, archived: false },
  { id: 4, name: "Front squat", category: "primary", tracksMax: true, measure: "reps", weighted: true, archived: false },
  { id: 5, name: "Strict press", category: "primary", tracksMax: true, measure: "reps", weighted: true, archived: false },
  ...[10, 11, 12, 13, 14].map((id) => ({
    id,
    name: `Accessory ${id}`,
    category: "accessory" as const,
    tracksMax: false,
    measure: "reps" as const,
    weighted: true,
    archived: false,
  })),
];
const maxEntries = [1, 2, 3, 4, 5].map((exerciseId) => ({
  id: exerciseId,
  exerciseId,
  date: "2026-09-01",
  valueLb: 200 + exerciseId * 20,
  source: "initial" as const,
  note: null,
  createdAt: "2026-09-01T10:00:00.000Z",
}));

/** A completed session on `date` with one accessory (`accessory`) at `lb`. */
function done(settings: Settings, date: string, accessory: number, lb = 50, sessions: Session[] = []): Session {
  const s = buildSession(date, { settings, exercises, maxEntries, sessions });
  return {
    ...s,
    blocks: [
      ...s.blocks.filter((b) => b.kind === "primary"),
      {
        id: `acc-${date}`,
        kind: "accessory",
        exercises: [{ exerciseId: accessory, measure: "reps", sets: [blankSet({ id: `${date}-1`, targetReps: 10, targetWeight: lb, reps: 10, weight: lb, done: true })] }],
      },
    ],
    completedAt: `${date}T20:00:00.000Z`,
  };
}
const accessoriesOf = (s: Session) => s.blocks.filter((b) => b.kind === "accessory").flatMap((b) => b.exercises.map((e) => e.exerciseId));

/** A new cycle set up on `today` (with `sessions` saved), then changed by `patch`. */
function withNext(today: string, sessions: Session[], patch: Parameters<typeof updatePlan>[2] = {}): Settings {
  const made = startNewCycle(base, sessions, today, "p2");
  if (!made) throw new Error("no new cycle");
  return updatePlan(made.settings, "p2", patch);
}

describe("one plan", () => {
  it("is every document stored before plans existed: no `earlierPlans`, no `planId`, read as before", () => {
    expect(base.program).not.toHaveProperty("earlierPlans");
    expect(base.program).not.toHaveProperty("planId");
    expect(planList(base)).toHaveLength(1);
    expect(withPlans(base, planList(base))).toEqual(base);
    const pos = cyclePosition(base.program, "2026-11-20")!;
    expect([pos.cycle, pos.weekIndex, pos.cycleStart, pos.cycleEnd, pos.plan.index, pos.weeksCount]).toEqual([2, 1, "2026-11-09", "2026-12-13", 0, 5]);
    expect(planTargets(base, "2026-01-01")).toEqual({ ...base.targets, ...base.schedule });
  });
});

describe("a new cycle", () => {
  const sessionInCycle2 = [done(base, "2026-11-10", 10)];

  it("starts the Monday after the cycle once something is saved in it, as a copy of everything the plan holds", () => {
    expect(newCycleStart(base, sessionInCycle2, "2026-12-08")).toBe("2026-12-14");
    const made = startNewCycle(base, sessionInCycle2, "2026-12-08", "p2")!;
    expect(made.plan).toEqual({
      id: "p2",
      start: "2026-12-14",
      name: base.program.name,
      weeks: base.program.weeks,
      days: base.program.days,
      targets: base.targets,
      schedule: base.schedule,
    });
    const s = made.settings;
    expect(settingsSchema.safeParse(s).success).toBe(true);
    // The latest plan is the top level (so a build that doesn't know plans reads it); the one before is kept.
    expect(s.program.cycleStartDate).toBe("2026-12-14");
    expect(s.program.planId).toBe("p2");
    expect(s.program.earlierPlans).toEqual([
      { id: "first", start: "2026-10-05", name: base.program.name, weeks: base.program.weeks, days: base.program.days, targets: base.targets, schedule: base.schedule },
    ]);
    expect(nextPlan(s, "2026-12-08")?.id).toBe("p2");
    expect(nextPlan(s, "2026-12-14")).toBeNull();
    expect(currentPlan(s, "2026-12-08").id).toBe("first");
  });

  it("starts on this cycle's Monday when nothing is saved in it yet (the choice made on its first day)", () => {
    expect(newCycleStart(base, [done(base, "2026-11-02", 10)], "2026-11-09")).toBe("2026-11-09");
    expect(newCycleStart(base, [], "2026-11-12")).toBe("2026-11-09");
    // A moved session counts for the day it was planned for.
    expect(newCycleStart(base, [{ ...done(base, "2026-11-08", 10), plannedFor: "2026-11-09" }], "2026-11-09")).toBe("2026-12-14");
    // The plan's own first cycle is never replaced: the plan itself is edited instead.
    expect(newCycleStart(base, [], "2026-10-07")).toBe("2026-11-09");
    // Before the program, and while a next cycle is set up: nothing to set up.
    expect(newCycleStart(base, [], "2026-10-01")).toBeNull();
    expect(newCycleStart(withNext("2026-12-08", sessionInCycle2), sessionInCycle2, "2026-12-08")).toBeNull();
  });

  it("cycle numbers continue across plans; a date reads under the plan in force on it", () => {
    const s = withNext("2026-12-08", sessionInCycle2, {
      weeks: base.program.weeks.slice(0, 3),
      days: { "1": { label: "Pull", primaryExerciseId: 2, progression: true }, "3": { label: "Legs", primaryExerciseId: 4, progression: true } },
    });
    const before = cyclePosition(s.program, "2026-12-13")!;
    expect([before.cycle, before.weekIndex, before.plan.id, before.cycleEnd]).toEqual([2, 4, "first", "2026-12-13"]);
    const after = cyclePosition(s.program, "2026-12-14")!;
    expect([after.cycle, after.weekIndex, after.plan.id, after.weeksCount, after.cycleEnd]).toEqual([3, 0, "p2", 3, "2027-01-03"]);
    expect(cyclePosition(s.program, "2027-01-04")!.cycle).toBe(4);
    expect(scheduledProgramDay(s.program, "2026-12-08")).toEqual(base.program.days["2"]); // Tue: Pull (deadlift)
    expect(scheduledProgramDay(s.program, "2026-12-15")).toBeNull(); // Tue is off in the new plan
    expect(programDayFor(s.program, "2026-12-14")?.label).toBe("Pull");
    // Before the program: the first plan's days.
    expect(programDayFor(s.program, "2026-10-01")).toEqual(base.program.days["4"]);
    expect(planTimeline(s.program).map((p) => [p.id, p.start, p.end, p.cyclesBefore])).toEqual([
      ["first", "2026-10-05", "2026-12-14", 0],
      ["p2", "2026-12-14", null, 2],
    ]);
  });

  it("the targets and schedule are the plan's: the days before its start keep theirs", () => {
    const metcon = [true, false, false, false, false, false, false];
    const s = withNext("2026-12-08", sessionInCycle2, { targets: { steps: 9000, zone2Minutes: 45 }, schedule: { metcon, zone2: metcon } });
    expect(s.targets).toEqual({ steps: 9000, zone2Minutes: 45 });
    expect(planTargets(s, "2026-12-13")).toEqual({ ...base.targets, ...base.schedule });
    expect(planTargets(s, "2026-12-14")).toEqual({ steps: 9000, zone2Minutes: 45, metcon, zone2: metcon });
    const day = { ...emptyDayLog("2026-12-11"), steps: 10_000 };
    const items = (settings: Settings, date: string) => checklist(date, { ...day, date }, undefined, settings).map((i) => [i.key, i.done]);
    // Friday before: 15,000 steps expected, metcon and Zone 2 expected as before.
    expect(items(s, "2026-12-11")).toEqual(items(base, "2026-12-11"));
    // A Friday under the new plan: 9,000 steps (done), the lift as before, no metcon, no Zone 2.
    expect(items(s, "2026-12-18")).toEqual([
      ["morning", false],
      ["fuel", false],
      ["steps", true],
      ["lift", false],
    ]);
  });

  it("cancelling it puts the document back exactly as it was; Undo of that puts the plan back", () => {
    const s = withNext("2026-12-08", sessionInCycle2, { name: "Next" });
    const plan = nextPlan(s, "2026-12-08")!;
    const cancelled = cancelPlan(s, "p2", "2026-12-08")!;
    expect(cancelled).toEqual(base);
    expect(restorePlan(cancelled, plan)).toEqual(s);
    // Only a scheduled next cycle can be cancelled; once it is in force it is history.
    expect(cancelPlan(s, "p2", "2026-12-14")).toBeNull();
    expect(cancelPlan(s, "first", "2026-12-08")).toBeNull();
    // Undo of setting it up removes it entirely, while it is still the latest.
    expect(removeNewPlan(s, "p2")).toEqual(base);
    expect(removeNewPlan(base, "p2")).toBeNull();
  });
});

describe("moving the start with more than one plan", () => {
  const sessions = [done(base, "2026-11-10", 10)];
  const s = withNext("2026-12-08", sessions);

  it("moves the plan in force now and every later plan, never an earlier plan's start", () => {
    // In the first plan, the next one scheduled: both move.
    const delayed = shiftCycleStart(s.program, 1, "2026-12-08");
    expect(planTimeline(delayed).map((p) => p.start)).toEqual(["2026-10-12", "2026-12-21"]);
    // In the second plan: only it moves.
    const later = shiftCycleStart(s.program, 1, "2026-12-20");
    expect(planTimeline(later).map((p) => p.start)).toEqual(["2026-10-05", "2026-12-21"]);
    // Delayed in its first week, this week goes back to the plan before (its cycle 3, week 1).
    const preview = previewCycleShift(s.program, 1, "2026-12-15");
    expect([preview.before?.plan.id, preview.position?.plan.id, preview.position?.cycle, preview.position?.weekIndex]).toEqual([
      "p2",
      "first",
      3,
      0,
    ]);
    expect([preview.from, preview.to]).toEqual(["2026-12-14", "2026-12-21"]);
  });

  it("refuses a move that would put a plan's start at or before the start of the plan before it", () => {
    expect(shiftRefusal(s.program, -10, "2026-12-20")).toBe("This cycle can't start before the plan before it, which began Mon Oct 5.");
    expect(shiftCycleStart(s.program, -10, "2026-12-20")).toBe(s.program);
    expect(shiftRefusal(s.program, -9, "2026-12-20")).toBeNull();
    const preview = previewCycleShift(s.program, -10, "2026-12-20");
    expect(preview.refused).toMatch(/can't start before/);
    expect(preview.program).toBe(s.program);
  });

  it("with one plan, moves as it always did", () => {
    expect(shiftCycleStart(base.program, 1).cycleStartDate).toBe("2026-10-12");
    expect(shiftCycleStart(base.program, -1, "2026-11-20").cycleStartDate).toBe("2026-09-28");
    expect(shiftRefusal(base.program, -1, "2026-11-20")).toBeNull();
  });
});

describe("the choice at the end of a cycle", () => {
  const sessions = [done(base, "2026-11-10", 10)];

  it("a quiet note in the cycle's last seven days, until Repeat is chosen", () => {
    expect(cycleEndCard(base, [], "2026-12-06")).toBeNull();
    expect(cycleEndCard(base, [], "2026-12-07")).toEqual({ cycle: 2, end: "2026-12-13", next: null });
    expect(cycleEndCard(base, [], "2026-12-13")).toEqual({ cycle: 2, end: "2026-12-13", next: null });
    expect(cycleEndCard(base, [repeatCycleKey(2)], "2026-12-10")).toBeNull();
    // Repeat for cycle 2 says nothing about cycle 3.
    expect(cycleEndCard(base, new Set([repeatCycleKey(2)]), "2027-01-14")?.cycle).toBe(3);
    // With the next cycle set up, the note says what comes next.
    const s = withNext("2026-12-08", sessions);
    expect(cycleEndCard(s, [repeatCycleKey(2)], "2026-12-08")).toEqual({ cycle: 2, end: "2026-12-13", next: nextPlan(s, "2026-12-08") });
    // Before the program, nothing.
    expect(cycleEndCard(base, [], "2026-10-01")).toBeNull();
  });

  it("Cycle N complete offers it while the new cycle has nothing saved and nothing was chosen", () => {
    expect(offersCycleChoice(base, sessions, [], "2026-12-14", 2)).toBe(true);
    expect(offersCycleChoice(base, sessions, [], "2026-12-16", 2)).toBe(true);
    expect(offersCycleChoice(base, sessions, [], "2026-12-14", 1)).toBe(false);
    expect(offersCycleChoice(base, sessions, [repeatCycleKey(2)], "2026-12-14", 2)).toBe(false);
    expect(offersCycleChoice(base, [...sessions, done(base, "2026-12-14", 10)], [], "2026-12-15", 2)).toBe(false);
    // A new plan already starts with the new cycle.
    const s = withNext("2026-12-08", sessions);
    expect(offersCycleChoice(s, sessions, [], "2026-12-14", 2)).toBe(false);
    // Set up from there, it starts on this cycle's Monday.
    expect(newCycleStart(base, sessions, "2026-12-16")).toBe("2026-12-14");
  });

  it("cycle completions keep their keys when a plan is added or cancelled", () => {
    const history = [done(base, "2026-10-06", 10), done(base, "2026-11-10", 10)];
    const data = (settings: Settings, sessions: Session[]): AppData => ({ settings, days: [], exercises, maxEntries, sessions });
    const keys = (d: AppData, today: string) => achievements(d, today).filter((a) => a.key.startsWith("cycle-")).map((a) => [a.key, a.date, a.detail]);
    const before = keys(data(base, history), "2026-12-20");
    expect(before).toEqual([
      ["cycle-2", "2026-12-13", "5 weeks banked."],
      ["cycle-1", "2026-11-08", "5 weeks banked."],
    ]);
    const s = withNext("2026-12-08", history, { weeks: base.program.weeks.slice(0, 3) });
    expect(keys(data(s, history), "2026-12-20")).toEqual(before);
    // The new plan's first cycle is cycle 3.
    const withCycle3 = [...history, done(s, "2026-12-15", 10)];
    expect(keys(data(s, withCycle3), "2027-01-05")[0]).toEqual(["cycle-3", "2027-01-03", "3 weeks banked."]);
    expect(keys(data(cancelPlan(s, "p2", "2026-12-08")!, history), "2026-12-20")).toEqual(before);
  });
});

describe("pre-fill follows the program day across plans", () => {
  // Cycle 2 under the first plan: Mon Push (bench, accessory 10), Tue Pull (deadlift, 11),
  // Wed Legs (squat, 12), Thu Push (press, 13), Fri Carries & pull (no main lift, 14).
  const history: Session[] = [];
  for (const [date, acc] of [
    ["2026-12-07", 10],
    ["2026-12-08", 11],
    ["2026-12-09", 12],
    ["2026-12-10", 13],
    ["2026-12-11", 14],
  ] as const)
    history.push(done(base, date, acc, 50, history));
  // The new plan: Pull moves to Monday, Push (bench) to Tuesday, a front squat day on Wednesday
  // named "Lower", Thursday a new "Arms" day on strict press... renamed, the carries day moves to
  // Saturday, and Friday a day without a main lift named "Conditioning".
  const next = withNext("2026-12-08", history, {
    days: {
      "1": { label: "Pull", primaryExerciseId: 2, progression: true },
      "2": { label: "Push", primaryExerciseId: 1, progression: true },
      "3": { label: "Lower", primaryExerciseId: 4, progression: true },
      "4": { label: "Shoulders", primaryExerciseId: 5, progression: true },
      "5": { label: "Conditioning", primaryExerciseId: null, progression: false },
      "6": { label: "Carries & pull", primaryExerciseId: null, progression: false },
    },
  });
  const ctx = { settings: next, exercises, maxEntries, sessions: history };
  const prefilled = (date: string) => accessoriesOf(buildSession(date, ctx));

  it("by main lift, then by name; a day without a main lift falls back to its weekday", () => {
    expect(prefilled("2026-12-14")).toEqual([11]); // Mon Pull ← last Tue (deadlift)
    expect(prefilled("2026-12-15")).toEqual([10]); // Tue Push ← last Mon (bench)
    expect(prefilled("2026-12-17")).toEqual([13]); // Thu: strict press, renamed ← last Thu (strict press)
    expect(prefilled("2026-12-19")).toEqual([14]); // Sat Carries & pull ← last Fri (by name)
    expect(prefilled("2026-12-18")).toEqual([14]); // Fri, no main lift, new name ← last Fri (weekday)
  });

  it("a day whose main lift and name are both new starts with its main lift only", () => {
    const s = buildSession("2026-12-16", ctx); // Wed Lower: front squat, never a main lift before
    expect(s.blocks.map((b) => b.kind)).toEqual(["primary"]);
    expect(templateSource("2026-12-16", ctx)).toBeNull();
  });

  it("within the new plan, the same weekday again", () => {
    const later = [...history, done(next, "2026-12-14", 12, 60, history)];
    expect(accessoriesOf(buildSession("2026-12-21", { ...ctx, sessions: later }))).toEqual([12]);
  });

  it("the days before the new plan pre-fill as they did", () => {
    for (const date of ["2026-12-08", "2026-12-09", "2026-12-12"]) {
      const sessions = history.filter((s) => s.date < date);
      const strip = (s: Session) => JSON.stringify(s, (k, v) => (k === "id" ? undefined : v));
      expect(strip(buildSession(date, { ...ctx, sessions }))).toBe(strip(buildSession(date, { settings: base, exercises, maxEntries, sessions })));
    }
  });
});

describe("pre-fill with one plan is the weekday rule, exactly (property check against the rule as it was)", () => {
  /** The template rule before plans: the latest earlier session on the same weekday (of its plan date), non-deload first. */
  const weekdayRule = (date: string, sessions: ReadonlyArray<Session>) => {
    const wd = weekdayOf(date);
    const prior = sessions
      .filter((s) => s.date < date && weekdayOf(planDateOf(s)) === wd && s.blocks.some((b) => b.kind === "accessory"))
      .sort((a, b) => (a.date < b.date ? 1 : -1));
    return prior.find((s) => !s.deload) ?? prior[0] ?? null;
  };
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);

  it("picks the same session for 2,000 random dates over random histories and programs", () => {
    let checked = 0;
    for (let run = 0; run < 20; run++) {
      const days: Settings["program"]["days"] = {};
      for (let wd = 0; wd < 7; wd++)
        if (rnd() < 0.6)
          days[String(wd)] = { label: ["Push", "Pull", "Legs", "Push"][Math.floor(rnd() * 4)]!, primaryExerciseId: rnd() < 0.8 ? 1 + Math.floor(rnd() * 5) : null, progression: true };
      const settings: Settings = { ...base, program: { ...base.program, days } };
      const sessions: Session[] = dateRange("2026-09-01", "2027-02-01")
        .filter(() => rnd() < 0.4)
        .map((date) => ({
          ...done(settings, date, 10 + Math.floor(rnd() * 5)),
          deload: rnd() < 0.2,
          plannedFor: rnd() < 0.1 ? addDays(date, 1 + Math.floor(rnd() * 3)) : null,
        }));
      for (let i = 0; i < 100; i++) {
        const date = addDays("2026-09-01", Math.floor(rnd() * 160));
        expect(templateSource(date, { settings, sessions })).toBe(weekdayRule(date, sessions));
        checked++;
      }
    }
    expect(checked).toBe(2000);
  });

  it("…and planAt reads the one plan for every date", () => {
    for (const date of ["2020-01-01", "2026-10-05", "2030-06-01"]) expect(planAt(base.program, date).index).toBe(0);
  });
});
