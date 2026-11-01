import { describe, expect, it } from "vitest";
import { filledCount, parseNutrition } from "./parseNutrition";

const all = (calories: number, proteinG: number, carbsG: number, fatG: number) => ({ calories, proteinG, carbsG, fatG });

describe("parseNutrition", () => {
  it.each([
    ["2140 212 150 70"],
    ["2140, 212, 150, 70"],
    ["2140,212,150,70"],
    ["2140/212/150/70"],
    ["2140\t212\t150\t70"],
    ["2,140 212 150 70"],
    ["2140, P212 C150 F70"],
    ["2140 P 212 C 150 F 70"],
    ["P212 C150 F70 2140"],
    ["2140kcal 212p 150c 70f"],
    ["kcal 2140 protein 212g carbs 150g fat 70g"],
    ["Calories 2140 Protein 212g Carbs 150g Fat 70g"],
    ["2140 kcal · 212 g protein · 150 g carbs · 70 g fat"],
    ["212g protein, 150g carbs, 70g fat, 2140 calories"],
    ["Protein: 212g Carbs: 150g Fat: 70g Calories: 2140"],
    ["2140 protein 212 carbs 150 fat 70"],
    ["P: 212 / C: 150 / F: 70 — 2140 kcal"],
  ])("reads %j", (text) => {
    expect(parseNutrition(text)).toEqual(all(2140, 212, 150, 70));
  });

  it("reads a multi-line export, ignoring other nutrients, percentages and dates", () => {
    const text = `Daily summary — Nov 1, 2026
Calories    2,140
Carbs       150 g (28%)
Fat         70 g (29%)
Saturated Fat 22 g
Protein     212 g (40%)
Fiber       31 g
Sugar       40 g
Sodium      2,300 mg`;
    expect(parseNutrition(text)).toEqual(all(2140, 212, 150, 70));
  });

  it("reads a Cronometer-style export (value, then unit)", () => {
    const text = "Energy 2140.4 kcal\nProtein 212.3 g\nNet Carbs 131 g\nCarbs 150.2 g\nFat 69.6 g\nTrans Fat 0.2 g";
    expect(parseNutrition(text)).toEqual(all(2140, 212, 150, 70));
  });

  it("falls back to net carbs when no total is given", () => {
    expect(parseNutrition("Calories 2140\nProtein 212\nNet carbs 131\nFat 70")).toEqual(all(2140, 212, 131, 70));
  });

  it("does not let an aside become a calorie count", () => {
    expect(parseNutrition("Protein 212g Fat 70g (630 kcal) Carbs 150g Calories 2140")).toEqual(all(2140, 212, 150, 70));
  });

  it("fills only what it can read", () => {
    expect(parseNutrition("2140")).toEqual({ calories: 2140, proteinG: null, carbsG: null, fatG: null });
    expect(parseNutrition("protein 212")).toEqual({ calories: null, proteinG: 212, carbsG: null, fatG: null });
    expect(parseNutrition("P212 F70")).toEqual({ calories: null, proteinG: 212, carbsG: null, fatG: 70 });
    expect(parseNutrition("2140 212")).toEqual({ calories: 2140, proteinG: 212, carbsG: null, fatG: null });
  });

  it("does not guess when loose numbers outnumber the gaps", () => {
    // Two unlabelled numbers, one missing field: neither is trusted.
    expect(parseNutrition("Protein 212 Carbs 150 Fat 70 meals 3 snacks 2")).toEqual({
      calories: null,
      proteinG: 212,
      carbsG: 150,
      fatG: 70,
    });
    expect(parseNutrition("Protein 212 Carbs 150 Fat 70 lunch 4 dinner 7")).toEqual({
      calories: null,
      proteinG: 212,
      carbsG: 150,
      fatG: 70,
    });
  });

  it("rounds and drops values outside the day-log bounds", () => {
    expect(parseNutrition("2140.6 212.4 150.5 69.5")).toEqual(all(2141, 212, 151, 70));
    expect(parseNutrition("99999 212 150 70")).toEqual({ calories: null, proteinG: 212, carbsG: 150, fatG: 70 });
  });

  it("ignores prose and single letters that aren't attached to a number", () => {
    expect(parseNutrition("felt good today, a c f day")).toBeNull();
    expect(parseNutrition("")).toBeNull();
    expect(parseNutrition("   ")).toBeNull();
  });

  it("counts filled fields", () => {
    expect(filledCount(null)).toBe(0);
    expect(filledCount(parseNutrition("P212 F70"))).toBe(2);
    expect(filledCount(parseNutrition("2140 212 150 70"))).toBe(4);
  });
});
