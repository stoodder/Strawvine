import { describe, expect, it } from "vitest";
import { defaultSettings } from "./defaults";
import { cycleLabel, cyclePosition, currentMax, mainLiftSets, platesPerSide, progressionGain, repMaxPct } from "./program";
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

describe("cycleLabel", () => {
  const n = program.weeks.length;
  const at = (date: string, opts?: { short?: boolean }) => cycleLabel(cyclePosition(program, date)!, n, opts);

  it("names the week within the cycle, without the cycle number in the first cycle", () => {
    expect(n).toBe(5);
    expect(at("2026-11-02")).toBe("Week 1 of 5");
    expect(at("2026-11-10")).toBe("Week 2 of 5");
  });
  it("calls the deload week by name", () => {
    expect(at("2026-11-30")).toBe("Deload week");
    expect(at("2026-11-30", { short: true })).toBe("Deload");
  });
  it("leads with the cycle from the second cycle on", () => {
    expect(at("2026-12-07")).toBe("Cycle 2 · Week 1 of 5");
    expect(at("2027-01-04")).toBe("Cycle 2 · Deload week");
    expect(at("2026-12-07", { short: true })).toBe("Cycle 2 · Week 1");
  });
  it("short drops the cycle length", () => {
    expect(at("2026-11-10", { short: true })).toBe("Week 2");
  });
  it("follows the program's own length, and never claims more weeks than it was told", () => {
    const three = { ...program, weeks: program.weeks.slice(0, 3) };
    expect(cycleLabel(cyclePosition(three, "2026-11-16")!, three.weeks.length)).toBe("Week 3 of 3");
    expect(cycleLabel(cyclePosition(three, "2026-11-23")!, three.weeks.length)).toBe("Cycle 2 · Week 1 of 3");
    expect(cycleLabel({ cycle: 1, weekIndex: 3, week: program.weeks[3]! }, 2)).toBe("Week 4");
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
