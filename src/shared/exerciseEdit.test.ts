import { describe, expect, it } from "vitest";
import { defaultSettings } from "./defaults";
import { exerciseDraft, exerciseEditPatch, exerciseLocks, exercisePatchRefusal, mainLiftOf, programDayList, serverLockDate } from "./exerciseEdit";
import { startNewCycle, updatePlan } from "./plans";
import type { Exercise } from "./schemas";

const ids = { bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 };
const settings = defaultSettings(ids, "2026-11-01");
const TODAY = "2026-11-20";
const ex = (o: Partial<Exercise> & Pick<Exercise, "id">): Exercise => ({
  name: "Cable row",
  category: "accessory",
  tracksMax: false,
  measure: "reps",
  weighted: true,
  archived: false,
  ...o,
});
const bench = ex({ id: 1, name: "Bench press", category: "primary", tracksMax: true });
const front = ex({ id: 4, name: "Front squat", category: "primary", tracksMax: true });
const row = ex({ id: 10 });

describe("exerciseLocks", () => {
  it("locks a program's main lift (category, measure, max, archiving), naming its days Monday first", () => {
    const withSunday = {
      ...settings,
      program: {
        ...settings.program,
        days: { ...settings.program.days, "0": { label: "Extra", primaryExerciseId: 1, progression: true } },
      },
    };
    expect(exerciseLocks(bench, withSunday, TODAY)).toEqual({ programDays: [1, 0], earlierPlanDays: [], latestIsNext: false, structure: true, keepsMax: true });
    expect(exerciseLocks(bench, settings, TODAY).programDays).toEqual([1]);
  });

  it("leaves a lift the program doesn't use free, unless a strength target needs its max", () => {
    expect(exerciseLocks(front, settings, TODAY)).toEqual({ programDays: [], earlierPlanDays: [], latestIsNext: false, structure: false, keepsMax: false });
    const targeted = { ...settings, strengthTargets: [{ id: "t", exerciseId: 4, targetLb: 405, setOn: "2026-11-01" }] };
    expect(exerciseLocks(front, targeted, TODAY)).toEqual({ programDays: [], earlierPlanDays: [], latestIsNext: false, structure: false, keepsMax: true });
    expect(exerciseLocks(row, settings, TODAY)).toEqual({ programDays: [], earlierPlanDays: [], latestIsNext: false, structure: false, keepsMax: false });
  });
});

describe("exerciseEditPatch", () => {
  it("sends only the fields that changed", () => {
    expect(exerciseEditPatch(row, exerciseDraft(row))).toEqual({});
    expect(exerciseEditPatch(row, { ...exerciseDraft(row), name: "  Seated row " })).toEqual({ name: "Seated row" });
    expect(exerciseEditPatch(row, { ...exerciseDraft(row), measure: "seconds", category: "core", weighted: false })).toEqual({
      measure: "seconds",
      category: "core",
      weighted: false,
    });
    expect(exerciseEditPatch(row, { ...exerciseDraft(row), archived: true })).toEqual({ archived: true });
  });

  it("keeps the old name when the new one is blank", () => {
    expect(exerciseEditPatch(row, { ...exerciseDraft(row), name: "   " })).toEqual({});
  });

  it("makes an exercise weighted when it becomes a main lift", () => {
    const pullUp = ex({ id: 11, name: "Pull-up", weighted: false });
    expect(exerciseEditPatch(pullUp, { ...exerciseDraft(pullUp), tracksMax: true })).toEqual({ tracksMax: true, weighted: true });
    expect(exerciseEditPatch(pullUp, { ...exerciseDraft(pullUp), category: "primary" })).toEqual({ category: "primary", weighted: true });
    // A main lift's draft can't say unweighted.
    expect(exerciseEditPatch(front, { ...exerciseDraft(front), weighted: false })).toEqual({});
    // No longer a main lift: the choice is back.
    expect(exerciseEditPatch(front, { ...exerciseDraft(front), category: "accessory", tracksMax: false, weighted: false })).toEqual({
      category: "accessory",
      tracksMax: false,
      weighted: false,
    });
  });

  it("never changes a locked field", () => {
    const locks = exerciseLocks(bench, settings, TODAY);
    const draft = {
      ...exerciseDraft(bench),
      name: "Bench",
      category: "accessory" as const,
      measure: "seconds" as const,
      tracksMax: false,
      archived: true,
    };
    expect(exerciseEditPatch(bench, draft, locks)).toEqual({ name: "Bench" });
    // Restoring an archived lift the program still uses is fine.
    const archived = { ...bench, archived: true };
    expect(exerciseEditPatch(archived, { ...exerciseDraft(archived), archived: false }, exerciseLocks(archived, settings, TODAY))).toEqual({
      archived: false,
    });
    // A strength target keeps the max on, but nothing else is locked.
    const targeted = { ...settings, strengthTargets: [{ id: "t", exerciseId: 4, targetLb: 405, setOn: "2026-11-01" }] };
    expect(
      exerciseEditPatch(front, { ...exerciseDraft(front), tracksMax: false, measure: "seconds" }, exerciseLocks(front, targeted, TODAY)),
    ).toEqual({
      measure: "seconds",
    });
  });
});

describe("exercisePatchRefusal (the server's locks)", () => {
  const targeted = { ...settings, strengthTargets: [{ id: "t", exerciseId: 4, targetLb: 405, setOn: "2026-11-01" }] };

  it("refuses what would take a program day's main lift away", () => {
    for (const patch of [{ archived: true }, { tracksMax: false }, { category: "accessory" as const }, { measure: "seconds" as const }])
      expect(exercisePatchRefusal(bench, patch, settings, TODAY)).toMatch(/^Bench press is Mon's main lift: .*can't be archived/);
    // A rename, the load flag or fields set to what they already are pass.
    expect(exercisePatchRefusal(bench, { name: "Bench", category: "primary", measure: "reps", tracksMax: true }, settings, TODAY)).toBeNull();
    expect(exercisePatchRefusal(bench, { archived: false, weighted: true }, settings, TODAY)).toBeNull();
  });

  it("refuses dropping the max of a lift with a strength target; anything goes for a free one", () => {
    expect(exercisePatchRefusal(front, { tracksMax: false }, targeted, TODAY)).toBe(
      "Front squat has a strength target, so it keeps tracking its max.",
    );
    expect(exercisePatchRefusal(front, { archived: true, measure: "seconds" }, targeted, TODAY)).toBeNull();
    expect(exercisePatchRefusal(front, { tracksMax: false, archived: true }, settings, TODAY)).toBeNull();
    expect(exercisePatchRefusal(row, { measure: "meters", archived: true }, settings, TODAY)).toBeNull();
  });

  it("names days the way the edit sheet does", () => {
    expect(programDayList([1])).toBe("Mon");
    expect(programDayList([1, 4])).toBe("Mon & Thu");
    expect(programDayList([1, 3, 5])).toBe("Mon, Wed & Fri");
  });
});

describe("locks with plans over time (SPEC §6.4)", () => {
  // The next cycle (from Mon Dec 7) swaps the back squat (Wed) for the front squat, and moves bench to Tuesday.
  const made = startNewCycle({ ...settings, onboarded: true }, [], "2026-11-09", "p2")!.settings;
  const next = updatePlan(made, "p2", {
    days: {
      ...settings.program.days,
      "1": { label: "Pull", primaryExerciseId: 2, progression: true },
      "2": { label: "Push", primaryExerciseId: 1, progression: true },
      "3": { label: "Legs", primaryExerciseId: 4, progression: true },
    },
  });
  const squat = ex({ id: 3, name: "Back squat", category: "primary", tracksMax: true });

  it("a lift the next cycle picks is locked as a program day's is", () => {
    expect(made.program.cycleStartDate).toBe("2026-12-07");
    expect(exerciseLocks(front, next, TODAY)).toEqual({ programDays: [3], earlierPlanDays: [], latestIsNext: true, structure: true, keepsMax: true });
    expect(exercisePatchRefusal(front, { archived: true }, next, TODAY)).toBe(
      "Front squat is Wed's main lift next cycle: the program calculates it, so it keeps its category, measure and max tracking and can't be archived. Change the next cycle's weekly layout on Program first.",
    );
  });

  it("so is one this cycle still uses, while the next cycle is scheduled — and the sentence says which layout to change", () => {
    expect(exerciseLocks(squat, next, TODAY)).toEqual({ programDays: [], earlierPlanDays: [3], latestIsNext: true, structure: true, keepsMax: true });
    expect(exercisePatchRefusal(squat, { archived: true }, next, TODAY)).toBe(
      "Back squat is Wed's main lift this cycle: the program calculates it, so it keeps its category, measure and max tracking and can't be archived. Change this cycle's weekly layout on Program first.",
    );
    expect(mainLiftOf(exerciseLocks(squat, next, TODAY))).toBe("Wed's main lift this cycle");
    expect(mainLiftOf(exerciseLocks(bench, next, TODAY))).toBe("Tue's main lift next cycle and Mon's this cycle");
    expect(exercisePatchRefusal(bench, { archived: true }, next, TODAY)).toMatch(/Change the weekly layout of both cycles on Program first\.$/);
    // The same days in both plans: said once.
    expect(mainLiftOf(exerciseLocks(ex({ id: 5, name: "Strict press", category: "primary", tracksMax: true }), next, TODAY))).toBe("Thu's main lift");
  });

  it("once the latest plan has started, the plan before is history: its lifts are free again", () => {
    // The day before the next cycle starts, still locked; from its Monday on, not.
    expect(exerciseLocks(squat, next, "2026-12-06").structure).toBe(true);
    expect(exerciseLocks(squat, next, "2026-12-07")).toEqual({ programDays: [], earlierPlanDays: [], latestIsNext: false, structure: false, keepsMax: false });
    expect(exercisePatchRefusal(squat, { archived: true }, next, "2027-06-01")).toBeNull();
    // The latest plan's own lifts stay locked.
    expect(exercisePatchRefusal(front, { archived: true }, next, "2027-06-01")).toMatch(/^Front squat is Wed's main lift: /);
  });

  it("the server checks on its own date plus a day: it never refuses what the sheet allows", () => {
    expect(serverLockDate("2026-12-06")).toBe("2026-12-07");
    // Server still on Sun Dec 6 (UTC), the phone already on Mon Dec 7: the sheet lets the squat go, and so does the server.
    expect(exerciseLocks(squat, next, "2026-12-07").structure).toBe(false);
    expect(exercisePatchRefusal(squat, { archived: true }, next, serverLockDate("2026-12-06"))).toBeNull();
    // Two days before, both lock it.
    expect(exercisePatchRefusal(squat, { archived: true }, next, serverLockDate("2026-12-05"))).not.toBeNull();
  });
});
