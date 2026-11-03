import { describe, expect, it } from "vitest";
import { dayLogPatchSchema, dayLogSchema, emptyDayLog } from "./schemas";

const ok = (patch: unknown) => dayLogPatchSchema.safeParse(patch).success;

describe("day log: resting HR and VO2 max", () => {
  it("accepts resting HR in 20–220 bpm and VO2 max in 10–100 mL/kg/min, or null", () => {
    for (const restingHrBpm of [20, 48, 48.5, 220, null]) expect(ok({ restingHrBpm })).toBe(true);
    for (const restingHrBpm of [19.9, 221, -1, "48"]) expect(ok({ restingHrBpm })).toBe(false);
    for (const vo2Max of [10, 52.3, 100, null]) expect(ok({ vo2Max })).toBe(true);
    for (const vo2Max of [9.9, 100.1, Number.NaN, "52"]) expect(ok({ vo2Max })).toBe(false);
  });
});

describe("day log: Also today flags", () => {
  it("are true, false or null (not recorded)", () => {
    for (const k of ["alcohol", "nicotine", "thc", "caffeine"]) {
      for (const v of [true, false, null]) expect(ok({ [k]: v })).toBe(true);
      for (const v of [1, "yes", 0]) expect(ok({ [k]: v })).toBe(false);
    }
  });
});

describe("day log patch", () => {
  it("is partial: a patch from a build before these fields still validates, and unknown keys are refused", () => {
    expect(ok({ weightLb: 200, hrvMs: 55 })).toBe(true);
    expect(ok({})).toBe(true);
    expect(ok({ restingHr: 48 })).toBe(false);
  });

  it("starts every new field as null on a blank day", () => {
    const day = emptyDayLog("2026-11-03");
    expect(day).toMatchObject({ restingHrBpm: null, vo2Max: null, alcohol: null, nicotine: null, thc: null, caffeine: null });
    expect(dayLogSchema.safeParse(day).success).toBe(true);
  });
});
