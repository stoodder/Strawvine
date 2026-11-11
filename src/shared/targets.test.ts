import { describe, expect, it } from "vitest";
import { targetProgress } from "./targets";

describe("targetProgress", () => {
  it("measures the current max against the target", () => {
    expect(targetProgress(275, 225)).toEqual({ currentLb: 225, targetLb: 275, reached: false, fraction: 225 / 275, toGoLb: 50 });
  });

  it("is reached at or above the target, with nothing left to go and a full bar", () => {
    expect(targetProgress(275, 275)).toMatchObject({ reached: true, fraction: 1, toGoLb: 0 });
    expect(targetProgress(275, 290)).toMatchObject({ reached: true, fraction: 1, toGoLb: 0 });
  });

  it("a target of zero or less has no bar to fill: the fraction is 0, never NaN or a full bar", () => {
    // 0/0 would be NaN, 225/0 Infinity (a full bar) and 225/−5 negative: none is progress toward a target.
    for (const [target, max] of [
      [0, null],
      [0, 0],
      [0, 225],
      [-5, 225],
      [-5, null],
    ] as const) {
      const p = targetProgress(target, max);
      expect(p.fraction, `target ${target}, max ${max}`).toBe(0);
      expect(p.toGoLb).toBe(0);
      expect(p.targetLb).toBe(target);
    }
  });

  it("a negative max is no progress: an empty bar, and all of the target (and more) to go", () => {
    expect(targetProgress(275, -10)).toEqual({ currentLb: -10, targetLb: 275, reached: false, fraction: 0, toGoLb: 285 });
    expect(targetProgress(275, 0)).toEqual({ currentLb: 0, targetLb: 275, reached: false, fraction: 0, toGoLb: 275 });
  });

  it("the bar never overfills, however far past the target the max is", () => {
    expect(targetProgress(100, 1000).fraction).toBe(1);
    expect(targetProgress(100, 99.9).fraction).toBeCloseTo(0.999);
    expect(targetProgress(100, 99.9).reached).toBe(false);
  });

  it("starts empty without a max", () => {
    expect(targetProgress(275, null)).toEqual({ currentLb: 0, targetLb: 275, reached: false, fraction: 0, toGoLb: 275 });
    expect(targetProgress(275, undefined).fraction).toBe(0);
  });
});
