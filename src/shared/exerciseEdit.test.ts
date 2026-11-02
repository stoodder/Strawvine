import { describe, expect, it } from "vitest";
import { defaultSettings } from "./defaults";
import { exerciseDraft, exerciseEditPatch, exerciseLocks, exercisePatchRefusal, programDayList } from "./exerciseEdit";
import type { Exercise } from "./schemas";

const ids = { bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 };
const settings = defaultSettings(ids, "2026-11-01");
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
    expect(exerciseLocks(bench, withSunday)).toEqual({ programDays: [1, 0], structure: true, keepsMax: true });
    expect(exerciseLocks(bench, settings).programDays).toEqual([1]);
  });

  it("leaves a lift the program doesn't use free, unless a strength target needs its max", () => {
    expect(exerciseLocks(front, settings)).toEqual({ programDays: [], structure: false, keepsMax: false });
    const targeted = { ...settings, strengthTargets: [{ id: "t", exerciseId: 4, targetLb: 405, setOn: "2026-11-01" }] };
    expect(exerciseLocks(front, targeted)).toEqual({ programDays: [], structure: false, keepsMax: true });
    expect(exerciseLocks(row, settings)).toEqual({ programDays: [], structure: false, keepsMax: false });
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
    const locks = exerciseLocks(bench, settings);
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
    expect(exerciseEditPatch(archived, { ...exerciseDraft(archived), archived: false }, exerciseLocks(archived, settings))).toEqual({
      archived: false,
    });
    // A strength target keeps the max on, but nothing else is locked.
    const targeted = { ...settings, strengthTargets: [{ id: "t", exerciseId: 4, targetLb: 405, setOn: "2026-11-01" }] };
    expect(
      exerciseEditPatch(front, { ...exerciseDraft(front), tracksMax: false, measure: "seconds" }, exerciseLocks(front, targeted)),
    ).toEqual({
      measure: "seconds",
    });
  });
});

describe("exercisePatchRefusal (the server's locks)", () => {
  const targeted = { ...settings, strengthTargets: [{ id: "t", exerciseId: 4, targetLb: 405, setOn: "2026-11-01" }] };

  it("refuses what would take a program day's main lift away", () => {
    for (const patch of [{ archived: true }, { tracksMax: false }, { category: "accessory" as const }, { measure: "seconds" as const }])
      expect(exercisePatchRefusal(bench, patch, settings)).toMatch(/^Bench press is Mon's main lift: .*can't be archived/);
    // A rename, the load flag or fields set to what they already are pass.
    expect(exercisePatchRefusal(bench, { name: "Bench", category: "primary", measure: "reps", tracksMax: true }, settings)).toBeNull();
    expect(exercisePatchRefusal(bench, { archived: false, weighted: true }, settings)).toBeNull();
  });

  it("refuses dropping the max of a lift with a strength target; anything goes for a free one", () => {
    expect(exercisePatchRefusal(front, { tracksMax: false }, targeted)).toBe(
      "Front squat has a strength target, so it keeps tracking its max.",
    );
    expect(exercisePatchRefusal(front, { archived: true, measure: "seconds" }, targeted)).toBeNull();
    expect(exercisePatchRefusal(front, { tracksMax: false, archived: true }, settings)).toBeNull();
    expect(exercisePatchRefusal(row, { measure: "meters", archived: true }, settings)).toBeNull();
  });

  it("names days the way the edit sheet does", () => {
    expect(programDayList([1])).toBe("Mon");
    expect(programDayList([1, 4])).toBe("Mon & Thu");
    expect(programDayList([1, 3, 5])).toBe("Mon, Wed & Fri");
  });
});
