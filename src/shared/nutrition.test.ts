import { describe, expect, it } from "vitest";
import { defaultSettings } from "./defaults";
import { macrosFor, project, recommend, weeksAtPct } from "./nutrition";

const base = defaultSettings({ bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 }, "2026-11-01");
const withGoal = (targetLb: number, pacePctPerWeek: number) => ({
  ...base,
  weightGoal: { targetLb, pacePctPerWeek, setOn: "2026-11-01" },
});

describe("recommend", () => {
  it("maintains without a goal", () => {
    const r = recommend(base, 3200, 200);
    expect(r.direction).toBe("maintain");
    expect(r.calories).toBe(3200);
  });

  it("builds a deficit from the pace (1%/week at 200 lb = 2 lb/week = 1000 kcal/day)", () => {
    const r = recommend(withGoal(185, 1), 3200, 200);
    expect(r.direction).toBe("lose");
    expect(r.rateLbPerWeek).toBeCloseTo(-2);
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
});
