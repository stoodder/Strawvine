import { describe, expect, it } from "vitest";
import { defaultSettings } from "./defaults";
import {
  goalDirection,
  macrosFor,
  OVER_TARGET_SCALE,
  overTarget,
  overTargetSeverity,
  project,
  PROTEIN_OVER_TARGET_SCALE,
  recommend,
  remainingKcal,
  weeksAtPct,
} from "./nutrition";

const base = defaultSettings({ bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 }, "2026-11-01");
const withGoal = (targetLb: number, pacePctPerWeek: number, startLb?: number) => ({
  ...base,
  weightGoal: { targetLb, pacePctPerWeek, setOn: "2026-11-01", startLb },
});

describe("goalDirection", () => {
  it("follows the trend for goals without a start weight", () => {
    expect(goalDirection(200, 190)).toBe("lose");
    expect(goalDirection(189, 190)).toBe("gain");
    expect(goalDirection(190.3, 190)).toBe("maintain");
    expect(goalDirection(200, null)).toBe("maintain");
  });

  it("keeps a cut a cut: reaching or passing the target settles into maintenance", () => {
    expect(goalDirection(195, 190, 200)).toBe("lose");
    expect(goalDirection(205, 190, 200)).toBe("lose"); // drifted away from the goal: still cutting
    expect(goalDirection(190.4, 190, 200)).toBe("maintain");
    expect(goalDirection(189, 190, 200)).toBe("maintain");
    expect(goalDirection(180, 190, 200)).toBe("maintain");
  });

  it("keeps a build a build", () => {
    expect(goalDirection(185, 190, 180)).toBe("gain");
    expect(goalDirection(191, 190, 180)).toBe("maintain");
  });

  it("holds a goal set at its target from either side", () => {
    expect(goalDirection(193, 190, 190.2)).toBe("lose");
    expect(goalDirection(187, 190, 190)).toBe("gain");
  });
});

describe("recommend", () => {
  it("maintains without a goal", () => {
    const r = recommend(base, 3200, 200);
    expect(r.direction).toBe("maintain");
    expect(r.calories).toBe(3200);
    expect(r.paceCapped).toBe(false);
  });

  it("builds a deficit from the pace (1%/week at 200 lb = 2 lb/week = 1000 kcal/day)", () => {
    const r = recommend(withGoal(185, 1), 3200, 200);
    expect(r.direction).toBe("lose");
    expect(r.rateLbPerWeek).toBeCloseTo(-2);
    expect(r.pacePctPerWeek).toBeCloseTo(-1);
    expect(r.calories).toBe(2200);
  });

  it("caps loss at 1%/week and gain at 0.5%/week", () => {
    const lose = recommend(withGoal(170, 2), 3200, 200);
    expect(lose.paceCapped).toBe(true);
    expect(lose.rateLbPerWeek).toBeCloseTo(-2);
    const gain = recommend(withGoal(220, 1), 3200, 200);
    expect(gain.paceCapped).toBe(true);
    expect(gain.rateLbPerWeek).toBeCloseTo(1);
    expect(gain.calories).toBe(3700);
  });

  it("maintains within half a pound of the goal", () => {
    expect(recommend(withGoal(200.3, 1), 3000, 200).direction).toBe("maintain");
  });

  it("tapers near the goal: never plans more in a week than is left to go", () => {
    const r = recommend(withGoal(199, 1, 210), 3200, 200); // 1 lb to go at a 2 lb/week pace
    expect(r.direction).toBe("lose");
    expect(r.rateLbPerWeek).toBeCloseTo(-1);
    expect(r.pacePctPerWeek).toBeCloseTo(-0.5);
    expect(r.calories).toBe(2700);
    expect(r.paceCapped).toBe(false);
    expect(recommend(withGoal(199, 1, 210), 3200, 199.4).calories).toBe(3200); // within tolerance
  });

  it("eases in: the deficit shrinks steadily on the approach", () => {
    const deficits = [204, 202, 201, 200.6, 200.2].map((w) => 3200 - recommend(withGoal(200, 1, 210), 3200, w).calories);
    expect(deficits).toEqual([...deficits].sort((a, b) => b - a));
    expect(deficits.at(-1)).toBe(0);
    expect(deficits.at(-2)).toBe(300);
  });

  it("settles a cut into maintenance after an overshoot instead of flipping into a build", () => {
    const cut = withGoal(200, 1, 210);
    expect(recommend(cut, 3200, 200.6).calories).toBe(2900);
    // A 1.2 lb wobble across the goal used to swing ~1,500 kcal (full cut → capped build).
    for (const w of [199.4, 195]) {
      const r = recommend(cut, 3200, w);
      expect(r).toMatchObject({ direction: "maintain", rateLbPerWeek: 0, calories: 3200, paceCapped: false });
    }
  });

  it("supports a gain goal with a start weight", () => {
    const build = withGoal(210, 0.5, 200);
    expect(recommend(build, 3200, 200)).toMatchObject({ direction: "gain", calories: 3700, paceCapped: false });
    expect(recommend(build, 3200, 209.5).rateLbPerWeek).toBeCloseTo(0.5); // tapered
    expect(recommend(build, 3200, 198).rateLbPerWeek).toBeCloseTo(0.99); // lost weight: keep building
    expect(recommend(build, 3200, 212)).toMatchObject({ direction: "maintain", calories: 3200 }); // never a cut
  });

  it("keeps the legacy trend-following direction for goals without a start weight, tapered", () => {
    const r = recommend(withGoal(200, 1), 3200, 199.4);
    expect(r.direction).toBe("gain");
    expect(r.rateLbPerWeek).toBeCloseTo(0.6);
    expect(r.calories).toBe(3500);
  });

  it("flags paceCapped only when the chosen pace exceeds the limit", () => {
    expect(recommend(withGoal(190, 0.8, 200), 3200, 190.8).paceCapped).toBe(false); // tapered, but within the limit
    expect(recommend(withGoal(190, 2, 200), 3200, 200).paceCapped).toBe(true);
    expect(recommend(withGoal(190, 2, 200), 3200, 190.8)).toMatchObject({ paceCapped: true, rateLbPerWeek: expect.closeTo(-0.8) });
    expect(recommend(withGoal(190, 2, 200), 3200, 189).paceCapped).toBe(false); // maintaining
  });
});

describe("macrosFor", () => {
  it("sets protein and fat per lb and fills carbs", () => {
    const m = macrosFor(3000, 200, base.nutrition);
    expect(m.proteinG).toBe(200);
    expect(m.fatG).toBe(70);
    expect(m.carbsG).toBe(Math.round((3000 - 800 - 630) / 4));
  });
  it("never returns negative carbs", () => {
    expect(macrosFor(1000, 250, base.nutrition).carbsG).toBe(0);
  });
});

describe("project", () => {
  it("compounds pace on current bodyweight", () => {
    expect(weeksAtPct(200, 190, 1)).toBeCloseTo(Math.log(0.95) / Math.log(0.99));
  });

  it("returns a date range between pace and observed rate", () => {
    const p = project(withGoal(190, 1), "2026-11-01", 200, 201)!; // observed -1 lb/week
    expect(p.direction).toBe("lose");
    expect(p.observed!.weeks).toBeCloseTo(10);
    expect(p.atPace!.weeks).toBeCloseTo(5.1, 1);
    expect(p.range![0]).toBe(p.atPace!.date);
    expect(p.range![1]).toBe(p.observed!.date);
  });

  it("ignores an observed trend going the wrong way", () => {
    const p = project(withGoal(190, 1), "2026-11-01", 200, 199)!;
    expect(p.observed).toBeNull();
    expect(p.range).toEqual([p.atPace!.date, p.atPace!.date]);
  });

  it("follows the goal's direction: nothing to project once a cut has passed its target", () => {
    const p = project(withGoal(190, 1, 200), "2026-11-01", 189, 190)!;
    expect(p).toMatchObject({ direction: "maintain", atPace: null, atLimit: null, observed: null, range: null });
    expect(project(withGoal(190, 1), "2026-11-01", 189, 188)!.direction).toBe("gain"); // legacy goal
  });

  it("projects a gain goal at the gain pace", () => {
    const p = project(withGoal(210, 0.5, 200), "2026-11-01", 200, 199.5)!; // observed +0.5 lb/week
    expect(p.direction).toBe("gain");
    expect(p.atPace!.weeks).toBeCloseTo(weeksAtPct(200, 210, 0.5)!);
    expect(p.observed!.weeks).toBeCloseTo(20);
    expect(p.range).toEqual([p.atPace!.date, p.observed!.date]);
  });
});

describe("overTargetSeverity", () => {
  it("is 0 at or under the target and within the 5% tolerance", () => {
    expect(overTargetSeverity(0, 200)).toBe(0);
    expect(overTargetSeverity(150, 200)).toBe(0);
    expect(overTargetSeverity(200, 200)).toBe(0);
    expect(overTargetSeverity(210, 200)).toBe(0); // exactly 5% over
  });

  it("rises linearly from the tolerance to 1 at 25% over, and stays there", () => {
    expect(overTargetSeverity(212, 200)).toBeCloseTo(0.05); // 6%: just past the tolerance
    expect(overTargetSeverity(230, 200)).toBeCloseTo(0.5); // 15%: halfway
    expect(overTargetSeverity(250, 200)).toBe(1); // 25%
    expect(overTargetSeverity(400, 200)).toBe(1);
    expect(overTargetSeverity(2900, 2500)).toBeCloseTo(0.55); // calories: 16% over
  });

  it("is lenient with protein: on target up to 25% over, fully over at 75%", () => {
    expect(overTargetSeverity(250, 200, PROTEIN_OVER_TARGET_SCALE)).toBe(0);
    expect(overTargetSeverity(300, 200, PROTEIN_OVER_TARGET_SCALE)).toBeCloseTo(0.5);
    expect(overTargetSeverity(350, 200, PROTEIN_OVER_TARGET_SCALE)).toBe(1);
  });

  it("is 0 when there is nothing to compare", () => {
    expect(overTargetSeverity(null, 200)).toBe(0);
    expect(overTargetSeverity(120, 0)).toBe(0); // a zero carb target has no bar
    expect(overTargetSeverity(120, null)).toBe(0);
    expect(overTargetSeverity(Number.NaN, 200)).toBe(0);
  });

  it("needs an overage of at least one whole unit (no '+0g over' on a tiny target)", () => {
    expect(overTargetSeverity(4.3, 4)).toBe(0); // 7.5 % over, but +0.3 g
    expect(overTarget(4.3, 4)).toEqual({ severity: 0, over: 0 });
    // +0.5 g rounds to +1 g: 12.5 % over → (0.5 − 0.2) / 0.8.
    expect(overTarget(4.5, 4)).toEqual({ severity: expect.closeTo(0.375), over: 1 });
  });

  it("pairs the severity with the rounded overage", () => {
    expect(overTarget(230, 200)).toEqual({ severity: expect.closeTo(0.5), over: 30 });
    expect(overTarget(210, 200)).toEqual({ severity: 0, over: 0 }); // within the tolerance: no note
    expect(overTarget(2612.6, 2400).over).toBe(213);
    expect(overTarget(null, 200)).toEqual({ severity: 0, over: 0 });
  });

  it("treats a degenerate scale as a step", () => {
    expect(overTargetSeverity(211, 200, { tolerance: 0.05, full: 0.05 })).toBe(1);
    expect(OVER_TARGET_SCALE.full).toBeGreaterThan(OVER_TARGET_SCALE.tolerance);
  });
});

describe("remainingKcal (Today's Fuel)", () => {
  it("is the whole target before anything is logged", () => {
    expect(remainingKcal(null, 2390)).toEqual({ left: 2390, over: 0, severity: 0 });
    expect(remainingKcal(undefined, 2390)).toEqual({ left: 2390, over: 0, severity: 0 });
    expect(remainingKcal(0, 2390)).toEqual({ left: 2390, over: 0, severity: 0 });
  });

  it("counts down as the day is eaten, in whole kcal", () => {
    expect(remainingKcal(1480, 2390)).toEqual({ left: 910, over: 0, severity: 0 });
    expect(remainingKcal(1480.4, 2390)).toEqual({ left: 910, over: 0, severity: 0 });
    expect(remainingKcal(2390, 2390)).toEqual({ left: 0, over: 0, severity: 0 });
  });

  it("never goes below zero, and within the tolerance the day is at 0 left, not over", () => {
    // 2,450 on 2,390 is 2.5 % over: on target by the Fuel scale.
    expect(remainingKcal(2450, 2390)).toEqual({ left: 0, over: 0, severity: 0 });
  });

  it("past the tolerance it reads as over, with overTarget's severity and overage", () => {
    const r = remainingKcal(2700, 2390);
    expect(r).toEqual({ left: 0, ...overTarget(2700, 2390) });
    expect(r.over).toBe(310);
    expect(r.severity).toBeGreaterThan(0);
    expect(remainingKcal(4000, 2390).severity).toBe(1);
    // A wider scale keeps the same day on target.
    expect(remainingKcal(2700, 2390, PROTEIN_OVER_TARGET_SCALE)).toEqual({ left: 0, over: 0, severity: 0 });
  });

  it("has nothing to say without a target", () => {
    for (const target of [null, undefined, 0, -100, Number.NaN])
      expect(remainingKcal(1200, target)).toEqual({ left: 0, over: 0, severity: 0 });
  });

  it("calories that aren't a number count as nothing eaten: the whole target is left, never NaN", () => {
    for (const eaten of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const r = remainingKcal(eaten, 2390);
      expect(r).toEqual({ left: 2390, over: 0, severity: 0 });
      expect(Number.isNaN(r.left)).toBe(false);
    }
  });
});
