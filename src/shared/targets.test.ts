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

  it("starts empty without a max", () => {
    expect(targetProgress(275, null)).toEqual({ currentLb: 0, targetLb: 275, reached: false, fraction: 0, toGoLb: 275 });
    expect(targetProgress(275, undefined).fraction).toBe(0);
  });
});
