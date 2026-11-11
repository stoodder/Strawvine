import { describe, expect, it } from "vitest";
import { defaultSettings } from "./defaults";
import {
  cyclePosition,
  currentMax,
  mainLiftSets,
  platesPerSide,
  previewCycleShift,
  progressionGain,
  repMaxPct,
  shiftCycleStart,
  snapCycleStart,
} from "./program";
import type { MaxEntry } from "./schemas";

const ids = { bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 };
const settings = defaultSettings(ids, "2026-11-01");
const program = settings.program;

describe("repMaxPct", () => {
  it("reads the table", () => {
    expect(repMaxPct(program.repMaxPct, 3)).toBe(0.93);
    expect(repMaxPct(program.repMaxPct, 12)).toBe(0.7);
  });
  it("interpolates gaps", () => {
    expect(repMaxPct(program.repMaxPct, 7)).toBeCloseTo(0.825);
    expect(repMaxPct(program.repMaxPct, 11)).toBeCloseTo(0.725);
  });
  it("extrapolates past the table with a floor", () => {
    expect(repMaxPct(program.repMaxPct, 15)).toBeCloseTo(0.625);
    expect(repMaxPct(program.repMaxPct, 100)).toBe(0.3);
  });
});

describe("mainLiftSets", () => {
  const weights = (weekIndex: number, max = 555) =>
    mainLiftSets(program, max, program.weeks[weekIndex]!, { progressionDay: true }).map((s) => s.weightLb);

  it("matches the verified 555 lb example for every week", () => {
    expect(weights(0)).toEqual([425, 400, 375, 350]);
    expect(weights(1)).toEqual([435, 425, 400, 375]);
    expect(weights(2)).toEqual([450, 435, 425, 400]);
    expect(weights(3)).toEqual([465, 450, 435, 425]);
    expect(weights(4)).toEqual([350, 350, 350, 350]); // deload: 4×10 @ 90% of 12RM
  });

  it("makes only the last set of a normal week AMRAP", () => {
    const sets = mainLiftSets(program, 555, program.weeks[3]!, { progressionDay: true });
    expect(sets.map((s) => s.amrap)).toEqual([false, false, false, true]);
    expect(sets.map((s) => s.reps)).toEqual([3, 4, 5, 6]);
  });

  it("has no AMRAP on deload weeks or non-progression days", () => {
    expect(mainLiftSets(program, 555, program.weeks[4]!, { progressionDay: true }).some((s) => s.amrap)).toBe(false);
    expect(mainLiftSets(program, 555, program.weeks[0]!, { progressionDay: false }).some((s) => s.amrap)).toBe(false);
  });
});

describe("progressionGain", () => {
  it("adds 1 lb per rep over target", () => {
    expect(progressionGain(program, 6, 9)).toBe(3);
    expect(progressionGain(program, 6, 6)).toBe(0);
    expect(progressionGain(program, 6, 4)).toBe(0);
  });
  it("respects the toggle", () => {
    expect(progressionGain({ ...program, progression: { enabled: false, lbPerExtraRep: 1 } }, 6, 9)).toBe(0);
  });
});

describe("cyclePosition", () => {
  it("starts on the configured Monday", () => {
    expect(program.cycleStartDate).toBe("2026-11-02");
    expect(cyclePosition(program, "2026-11-01")).toBeNull();
    const p = cyclePosition(program, "2026-11-02")!;
    expect([p.cycle, p.weekIndex, p.weekStart, p.weekEnd]).toEqual([1, 0, "2026-11-02", "2026-11-08"]);
  });
  it("rolls through the deload into the next cycle", () => {
    expect(cyclePosition(program, "2026-11-30")!.week.deload).toBe(true);
    const p = cyclePosition(program, "2026-12-07")!;
    expect([p.cycle, p.weekIndex]).toEqual([2, 0]);
    expect(cyclePosition(program, "2026-11-10")!.cycleEnd).toBe("2026-12-06");
  });
});

describe("shiftCycleStart", () => {
  it("moves the cycle start by whole weeks, later or earlier", () => {
    expect(shiftCycleStart(program, 1).cycleStartDate).toBe("2026-11-09");
    expect(shiftCycleStart(program, -1).cycleStartDate).toBe("2026-10-26");
    expect(shiftCycleStart(program, 3).cycleStartDate).toBe("2026-11-23");
    expect(shiftCycleStart(program, 0)).toEqual(program);
    // Across a year boundary.
    expect(shiftCycleStart({ ...program, cycleStartDate: "2026-12-28" }, 1).cycleStartDate).toBe("2027-01-04");
  });
  it("changes nothing else, and leaves the program it was given alone", () => {
    const before = structuredClone(program);
    const { cycleStartDate, ...rest } = shiftCycleStart(program, 1);
    const { cycleStartDate: was, ...restBefore } = program;
    expect(rest).toEqual(restBefore);
    expect(cycleStartDate).not.toBe(was);
    expect(program).toEqual(before);
  });
  it("lands on a Monday even when the stored start isn't one (the snap-to-Monday rule)", () => {
    // 2026-11-05 is a Thursday: its week's Monday is Nov 2.
    expect(snapCycleStart("2026-11-05")).toBe("2026-11-02");
    expect(snapCycleStart("2026-11-08")).toBe("2026-11-02"); // Sunday belongs to the week before
    expect(snapCycleStart("2026-11-02")).toBe("2026-11-02");
    const midweek = { ...program, cycleStartDate: "2026-11-05" };
    expect(shiftCycleStart(midweek, 1).cycleStartDate).toBe("2026-11-09");
    expect(shiftCycleStart(midweek, -1).cycleStartDate).toBe("2026-10-26");
    expect(shiftCycleStart(midweek, 0).cycleStartDate).toBe("2026-11-02");
  });
  it("a week later and a week earlier undo each other", () => {
    expect(shiftCycleStart(shiftCycleStart(program, 1), -1)).toEqual(program);
    expect(shiftCycleStart(shiftCycleStart(program, -2), 2)).toEqual(program);
  });
  it("only moves by whole weeks, and stays on the calendar", () => {
    expect(shiftCycleStart(program, 1.9).cycleStartDate).toBe("2026-11-09");
    const last = { ...program, cycleStartDate: "2999-12-30" };
    expect(shiftCycleStart(last, 1)).toBe(last);
  });
  it("a week later, this week becomes the week before it; in week 1, the plan hasn't started", () => {
    const at = (p: typeof program, date: string) => {
      const pos = cyclePosition(p, date);
      return pos && [pos.cycle, pos.weekIndex, pos.weekStart];
    };
    // Wednesday of week 2 (cycle 1).
    expect(at(program, "2026-11-11")).toEqual([1, 1, "2026-11-09"]);
    expect(at(shiftCycleStart(program, 1), "2026-11-11")).toEqual([1, 0, "2026-11-09"]);
    expect(at(shiftCycleStart(program, -1), "2026-11-11")).toEqual([1, 2, "2026-11-09"]);
    // Week 1: a week later it hasn't begun; next Monday is week 1.
    expect(at(shiftCycleStart(program, 1), "2026-11-04")).toBeNull();
    expect(at(shiftCycleStart(program, 1), "2026-11-09")).toEqual([1, 0, "2026-11-09"]);
    // First week of cycle 2: a week later it is cycle 1's deload again.
    expect(at(program, "2026-12-07")).toEqual([2, 0, "2026-12-07"]);
    const back = cyclePosition(shiftCycleStart(program, 1), "2026-12-07")!;
    expect([back.cycle, back.weekIndex, back.week.deload]).toEqual([1, 4, true]);
    // Last week of a cycle: a week earlier it is the next cycle's week 1.
    expect(at(shiftCycleStart(program, -1), "2026-11-30")).toEqual([2, 0, "2026-11-30"]);
  });
});

describe("previewCycleShift", () => {
  it("in week 1, a week later: nothing this week, next Monday is week 1's first lifting day", () => {
    const p = previewCycleShift(program, 1, "2026-11-04");
    expect(p.program).toEqual(shiftCycleStart(program, 1));
    expect(p.position).toBeNull();
    expect([p.next!.date, p.next!.day.label, p.next!.position.weekIndex, p.next!.position.cycle]).toEqual(["2026-11-09", "Push", 0, 1]);
  });
  it("mid-cycle: says which week this one becomes, and the next lifting day", () => {
    // Saturday of week 2 (no lifting at the weekend): the next lifting day is Monday.
    const later = previewCycleShift(program, 1, "2026-11-14");
    expect([later.position!.weekIndex, later.position!.week.label]).toEqual([0, "Week 1"]);
    expect([later.next!.date, later.next!.position.weekIndex]).toEqual(["2026-11-16", 1]);
    const earlier = previewCycleShift(program, -1, "2026-11-11");
    expect(earlier.position!.weekIndex).toBe(2);
    // A lifting day itself is "the next one".
    expect([earlier.next!.date, earlier.next!.day.label]).toEqual(["2026-11-11", "Legs"]);
  });
  it("before the start, a week earlier can make this week week 1", () => {
    const p = previewCycleShift(program, -1, "2026-10-28");
    expect([p.position!.cycle, p.position!.weekIndex]).toEqual([1, 0]);
    expect(previewCycleShift(program, -1, "2026-10-20").position).toBeNull();
    expect(previewCycleShift(program, -1, "2026-10-20").next!.date).toBe("2026-10-26");
  });
  it("starts from the first lifting weekday, and copes with a program without any", () => {
    const tueOnly = { ...program, days: { "2": program.days["2"]! } };
    expect(previewCycleShift(tueOnly, 1, "2026-11-04").next!.date).toBe("2026-11-10");
    expect(previewCycleShift({ ...program, days: {} }, 1, "2026-11-04").next).toBeNull();
  });
});

describe("currentMax", () => {
  const e = (id: number, date: string, valueLb: number, createdAt: string): MaxEntry => ({
    id,
    exerciseId: 1,
    date,
    valueLb,
    source: "manual",
    note: null,
    createdAt,
  });
  it("takes the latest by date then creation time", () => {
    const entries = [e(1, "2026-11-01", 300, "a"), e(2, "2026-11-05", 303, "b"), e(3, "2026-11-05", 305, "c")];
    expect(currentMax(entries, 1)!.valueLb).toBe(305);
    expect(currentMax(entries, 1, "2026-11-03")!.valueLb).toBe(300);
    expect(currentMax(entries, 2)).toBeNull();
  });
});

describe("platesPerSide", () => {
  it("loads a 45 lb bar", () => {
    expect(platesPerSide(425).plates).toEqual([45, 45, 45, 45, 10]);
    expect(platesPerSide(135).plates).toEqual([45]);
    expect(platesPerSide(45).plates).toEqual([]);
  });
});
