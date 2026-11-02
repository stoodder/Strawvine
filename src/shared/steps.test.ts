import { describe, expect, it } from "vitest";
import { addDays } from "./dates";
import { weightedAverage } from "./energy";
import { computeStepsSeries } from "./steps";

const day = (date: string, steps: number | null) => ({ date, steps });

describe("computeStepsSeries", () => {
  const start = "2026-10-01";
  const counts = [10000, 12000, null, 8000, 15000, 11000, 9000, 14000, 13000];
  const days = counts.map((c, i) => day(addDays(start, i), c));

  it("lists every date in range with its count and the weighted 7-day trend (§4.1)", () => {
    const s = computeStepsSeries(days, start, addDays(start, 8), null);
    expect(s.map((d) => d.date)).toEqual(counts.map((_, i) => addDays(start, i)));
    expect(s.map((d) => d.steps)).toEqual(counts);
    // Day 0 has only itself; day 8's window is days 8…2 (day 2 missing → its weight leaves the divisor).
    expect(s[0]!.avgSteps).toBe(10000);
    expect(s[8]!.avgSteps).toBeCloseTo(weightedAverage([13000, 14000, 9000, 11000, 15000, 8000, null])!);
    expect(s[8]!.avgSteps).toBeCloseTo((13000 * 5 + 14000 * 5 + 9000 * 5 + 11000 * 4 + 15000 * 3 + 8000 * 2) / 24);
  });

  it("reads days before `from` so the first trend point has a full window", () => {
    const s = computeStepsSeries(days, addDays(start, 7), addDays(start, 8), null);
    expect(s).toHaveLength(2);
    expect(s[0]!.avgSteps).toBeCloseTo(weightedAverage([14000, 9000, 11000, 15000, 8000, null, 12000])!);
  });

  it("shows today's partial count but keeps it out of the trend, which ends yesterday", () => {
    const today = addDays(start, 8);
    const s = computeStepsSeries(days, start, today, today);
    expect(s[8]!.steps).toBe(13000);
    expect(s[8]!.avgSteps).toBeNull();
    expect(s[8]!.partial).toBe(true);
    expect(s.slice(0, 8).every((d) => !d.partial)).toBe(true);
    expect(s[7]!.avgSteps).toBeCloseTo(weightedAverage([14000, 9000, 11000, 15000, 8000, null, 12000])!);
  });

  it("marks nothing partial when today has no count yet, or without a today", () => {
    const today = addDays(start, 9);
    expect(computeStepsSeries(days, start, today, today).some((d) => d.partial)).toBe(false);
    expect(computeStepsSeries(days, start, addDays(start, 8), null).some((d) => d.partial)).toBe(false);
  });

  it("handles a one-day range (its trend still reads the days before it)", () => {
    const s = computeStepsSeries(days, addDays(start, 4), addDays(start, 4), null);
    expect(s).toEqual([
      { date: addDays(start, 4), steps: 15000, avgSteps: weightedAverage([15000, 8000, null, 12000, 10000])!, partial: false },
    ]);
    // A one-day range that is today: its partial count and no trend.
    expect(computeStepsSeries(days, addDays(start, 4), addDays(start, 4), addDays(start, 4))).toEqual([
      { date: addDays(start, 4), steps: 15000, avgSteps: null, partial: true },
    ]);
  });

  it("runs past today without trend or partial points for the future", () => {
    const today = addDays(start, 6);
    const s = computeStepsSeries(days, addDays(start, 5), addDays(start, 8), today);
    expect(s.map((d) => d.date)).toEqual([5, 6, 7, 8].map((i) => addDays(start, i)));
    expect(s[0]!.avgSteps).toBeCloseTo(weightedAverage([11000, 15000, 8000, null, 12000, 10000])!);
    // Today (day 6) is partial; days after it may hold counts (logged ahead, or clock skew) but
    // feed no trend and aren't "so far".
    expect(s.map((d) => d.avgSteps).slice(1)).toEqual([null, null, null]);
    expect(s.map((d) => d.partial)).toEqual([false, true, false, false]);
  });

  it("has no trend for a week without counts, and counts a logged 0", () => {
    const s = computeStepsSeries([day("2026-10-01", 0), day("2026-10-20", 9000)], "2026-10-01", "2026-10-20", null);
    expect(s[0]!.avgSteps).toBe(0);
    expect(s[6]!.avgSteps).toBe(0);
    expect(s[7]!.avgSteps).toBeNull();
    expect(s[19]!.avgSteps).toBe(9000);
  });

  it("is empty for an inverted range", () => {
    expect(computeStepsSeries(days, "2026-10-05", "2026-10-01", null)).toEqual([]);
  });
});
