import { describe, expect, it } from "vitest";
import { DEFAULT_MIN_CALORIES, defaultSettings, displayPrefs, minCalories, trainingPrefs } from "./defaults";
import { blockExerciseSchema, maxEntryCreateSchema, settingsSchema } from "./schemas";

const ids = { bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 };

describe("training & display preferences", () => {
  it("fills in defaults for settings stored before the fields existed", () => {
    const { training: _t, display: _d, ...legacy } = defaultSettings(ids, "2026-11-01");
    expect(settingsSchema.parse(legacy)).not.toHaveProperty("training");
    expect(trainingPrefs(legacy)).toEqual({ restSecondsMain: 180, restSecondsAccessory: 90, accessoryIncrementLb: 5 });
    expect(displayPrefs(legacy)).toEqual({ highContrast: false });
  });

  it("ships the defaults in new settings and reads stored values", () => {
    const s = defaultSettings(ids, "2026-11-01");
    expect(settingsSchema.parse(s)).toEqual(s);
    expect(trainingPrefs(s)).toEqual({ restSecondsMain: 180, restSecondsAccessory: 90, accessoryIncrementLb: 5 });
    const custom = {
      ...s,
      training: { restSecondsMain: 240, restSecondsAccessory: 60, accessoryIncrementLb: 2.5 },
      display: { highContrast: true },
    };
    expect(trainingPrefs(custom).restSecondsMain).toBe(240);
    expect(displayPrefs(custom).highContrast).toBe(true);
  });

  it("validates the ranges", () => {
    const s = defaultSettings(ids, "2026-11-01");
    const training = (patch: object) => settingsSchema.safeParse({ ...s, training: { ...s.training, ...patch } }).success;
    expect(training({ restSecondsMain: 9 })).toBe(false);
    expect(training({ restSecondsAccessory: 901 })).toBe(false);
    expect(training({ accessoryIncrementLb: 51 })).toBe(false);
    expect(training({ accessoryIncrementLb: 0 })).toBe(true);
    expect(settingsSchema.safeParse({ ...s, display: {} }).success).toBe(false);
  });
});

describe("minimum calorie target (limits.minCalories)", () => {
  const s = defaultSettings(ids, "2026-11-01");
  const withMin = (minCalories: unknown) => ({ ...s, limits: { ...s.limits, minCalories } });

  it("is optional: settings stored before it existed still parse, and read as the default", () => {
    const { minCalories: _m, ...limits } = s.limits;
    const legacy = { ...s, limits };
    const parsed = settingsSchema.parse(legacy);
    expect(parsed).toEqual(legacy);
    expect(parsed.limits).not.toHaveProperty("minCalories");
    expect(DEFAULT_MIN_CALORIES).toBe(1500);
    expect(minCalories(parsed)).toBe(1500);
    expect(minCalories(null)).toBe(1500);
    expect(minCalories(undefined)).toBe(1500);
  });

  it("ships in new settings and reads the stored value", () => {
    expect(s.limits.minCalories).toBe(1500);
    expect(minCalories(settingsSchema.parse(withMin(1800)))).toBe(1800);
  });

  it("is a number of kcal from 800 to 5,000", () => {
    const ok = (v: unknown) => settingsSchema.safeParse(withMin(v)).success;
    for (const v of [800, 1500, 1650.5, 5000]) expect(ok(v)).toBe(true);
    for (const v of [799, 5001, 0, -1500, Number.NaN, "1500", null]) expect(ok(v)).toBe(false);
  });

  it("a save by a build that doesn't know the field falls back to the default, losing nothing else", () => {
    // What such a build's schema does to the document: the unknown key is dropped, the rest kept.
    const before = settingsSchema.parse(withMin(1800));
    const olderSchema = settingsSchema.extend({ limits: settingsSchema.shape.limits.omit({ minCalories: true }) });
    const stripped = olderSchema.parse(before);
    expect(stripped.limits).toEqual({ maxLossPctPerWeek: 1, maxGainPctPerWeek: 0.5 });
    const after = settingsSchema.parse(stripped);
    expect(minCalories(after)).toBe(1500);
    expect({ ...after, limits: before.limits }).toEqual(before);
  });
});

describe("schema additions", () => {
  it("accepts an optional skipped flag and the correction source", () => {
    expect(blockExerciseSchema.parse({ exerciseId: 1, measure: "reps", sets: [] })).not.toHaveProperty("skipped");
    expect(blockExerciseSchema.parse({ exerciseId: 1, measure: "reps", sets: [], skipped: true }).skipped).toBe(true);
    expect(maxEntryCreateSchema.parse({ date: "2026-11-01", valueLb: 300, source: "correction" }).source).toBe("correction");
  });
});
