import { describe, expect, it } from "vitest";
import { emptyDayLog } from "./empty";
import { nextSubstanceState, substanceSummary } from "./substances";

describe("nextSubstanceState", () => {
  it("cycles not recorded → none → had → not recorded", () => {
    expect(nextSubstanceState(null)).toBe(false);
    expect(nextSubstanceState(false)).toBe(true);
    expect(nextSubstanceState(true)).toBe(null);
  });

  it("treats a missing flag (a day cached by an older build) as not recorded", () => {
    expect(nextSubstanceState(undefined)).toBe(false);
  });
});

describe("substanceSummary", () => {
  const day = emptyDayLog("2026-11-03");

  it("is empty when nothing is recorded", () => {
    expect(substanceSummary(day)).toBe("");
  });

  it("lists what was had, then what was recorded as none, in display order", () => {
    expect(substanceSummary({ ...day, caffeine: true })).toBe("Had caffeine");
    expect(substanceSummary({ ...day, caffeine: true, alcohol: true })).toBe("Had alcohol and caffeine");
    expect(substanceSummary({ ...day, alcohol: false })).toBe("No alcohol");
    expect(substanceSummary({ ...day, thc: false, alcohol: false })).toBe("No alcohol or THC");
    expect(substanceSummary({ ...day, caffeine: true, alcohol: false, thc: false })).toBe("Had caffeine · No alcohol or THC");
    expect(substanceSummary({ ...day, alcohol: false, nicotine: false, thc: false, caffeine: false })).toBe(
      "No alcohol, nicotine, THC or caffeine",
    );
    expect(substanceSummary({ ...day, alcohol: true, nicotine: true, thc: true, caffeine: false })).toBe(
      "Had alcohol, nicotine and THC · No caffeine",
    );
  });

  it("ignores flags missing from a day cached by an older build", () => {
    const { alcohol: _a, nicotine: _n, ...rest } = { ...day, caffeine: false };
    expect(substanceSummary(rest as typeof day)).toBe("No caffeine");
  });
});
