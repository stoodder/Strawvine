import { describe, expect, it } from "vitest";
import { addDays } from "./dates";
import { computeEnergySeries, effectiveTdee, weightedAverage } from "./energy";

const day = (date: string, weightLb: number | null, calories: number | null) => ({ date, weightLb, calories });

describe("weightedAverage", () => {
  it("applies 5,5,5,4,3,2,1 / 25", () => {
    // (10*5 + 20*5 + 30*5 + 40*4 + 50*3 + 60*2 + 70*1) / 25
    expect(weightedAverage([10, 20, 30, 40, 50, 60, 70])).toBeCloseTo((50 + 100 + 150 + 160 + 150 + 120 + 70) / 25);
  });

  it("skips a missing slot and removes its weight from the divisor", () => {
    // T2 missing -> divisor 20
    const v = weightedAverage([10, 20, null, 40, 50, 60, 70]);
    expect(v).toBeCloseTo((50 + 100 + 160 + 150 + 120 + 70) / 20);
  });

  it("returns null when nothing is logged", () => {
    expect(weightedAverage([null, null, null, null, null, null, null])).toBeNull();
  });

  it("works with partial windows", () => {
    expect(weightedAverage([200])).toBe(200);
  });
});

describe("computeEnergySeries", () => {
  const start = "2026-11-02";

  it("only counts days with both weight and calories", () => {
    const days = [day(start, 200, 3000), day(addDays(start, 1), 199, null), day(addDays(start, 2), null, 2800)];
    const s = computeEnergySeries(days, start, addDays(start, 2));
    expect(s.map((d) => d.logged)).toEqual([true, false, false]);
    expect(s[1]!.avgWeight).toBe(200); // unlogged day doesn't contribute
    expect(s[2]!.avgCalories).toBe(3000);
    expect(s[2]!.loggedCount).toBe(1);
  });

  it("derives TDEE from the change between today's and yesterday's weight average", () => {
    const days = [day(start, 200, 3000), day(addDays(start, 1), 199, 3000)];
    const s = computeEnergySeries(days, start, addDays(start, 1));
    expect(s[0]!.tdee).toBeNull(); // no previous average yet
    // avgW day2 = (199*5 + 200*5)/10 = 199.5 ; Δ = -0.5 lb ; TDEE = 3000 + 0.5*3500
    expect(s[1]!.avgWeight).toBeCloseTo(199.5);
    expect(s[1]!.tdee).toBeCloseTo(3000 + 0.5 * 3500);
    expect(s[1]!.avgTdee).toBeCloseTo(4750);
  });

  it("is stable at maintenance: constant weight → TDEE equals intake", () => {
    const days = Array.from({ length: 20 }, (_, i) => day(addDays(start, i), 200, 2900));
    const s = computeEnergySeries(days, start, addDays(start, 19));
    expect(s.at(-1)!.tdee).toBeCloseTo(2900);
    expect(s.at(-1)!.avgTdee).toBeCloseTo(2900);
  });

  it("recovers a true TDEE from a steady 1 lb/week loss", () => {
    // Eating 3000, losing 1 lb/week (=500 kcal/day deficit) → TDEE 3500.
    const days = Array.from({ length: 30 }, (_, i) => day(addDays(start, i), 220 - i / 7, 3000));
    const s = computeEnergySeries(days, start, addDays(start, 29));
    expect(s.at(-1)!.avgTdee).toBeCloseTo(3500, 0);
  });

  it("skips a day's TDEE when the day is not logged, and smooths over the gap", () => {
    const days = Array.from({ length: 14 }, (_, i) => day(addDays(start, i), 200, 3000)).filter((_, i) => i !== 10);
    const s = computeEnergySeries(days, start, addDays(start, 13));
    expect(s[10]!.tdee).toBeNull();
    expect(s[10]!.avgTdee).toBeCloseTo(3000);
    expect(s[13]!.avgTdee).toBeCloseTo(3000);
  });

  it("recomputes from raw data — editing a past day ripples forward", () => {
    const base = Array.from({ length: 10 }, (_, i) => day(addDays(start, i), 200, 3000));
    const edited = base.map((d, i) => (i === 5 ? { ...d, calories: 4000 } : d));
    const a = computeEnergySeries(base, start, addDays(start, 9));
    const b = computeEnergySeries(edited, start, addDays(start, 9));
    expect(b[4]!.avgCalories).toBe(a[4]!.avgCalories);
    expect(b[5]!.avgCalories!).toBeGreaterThan(a[5]!.avgCalories!);
    expect(b[9]!.avgTdee!).toBeGreaterThan(a[9]!.avgTdee!);
  });

  it("reads history before the requested range", () => {
    const days = Array.from({ length: 40 }, (_, i) => day(addDays(start, i), 200, 3000));
    const s = computeEnergySeries(days, addDays(start, 30), addDays(start, 39));
    expect(s).toHaveLength(10);
    expect(s[0]!.avgTdee).toBeCloseTo(3000);
    expect(s[0]!.loggedCount).toBe(31);
  });
});

describe("effectiveTdee", () => {
  it("uses the prior until measurement exists", () => {
    const e = effectiveTdee({ avgTdee: null, avgWeight: 200, loggedCount: 1 }, null)!;
    expect(e.value).toBe(3000);
    expect(e.provisional).toBe(true);
    expect(e.confidence).toBe(0);
  });

  it("blends toward the measured value during calibration", () => {
    const e = effectiveTdee({ avgTdee: 4000, avgWeight: 200, loggedCount: 7 }, 3000)!;
    expect(e.value).toBeCloseTo(3500);
    expect(e.provisional).toBe(true);
  });

  it("is purely measured once calibrated", () => {
    const e = effectiveTdee({ avgTdee: 4000, avgWeight: 200, loggedCount: 20 }, 3000)!;
    expect(e.value).toBe(4000);
    expect(e.provisional).toBe(false);
  });
});
