import { describe, expect, it } from "vitest";
import { defaultSettings, displayPrefs, trainingPrefs } from "./defaults";
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

describe("schema additions", () => {
  it("accepts an optional skipped flag and the correction source", () => {
    expect(blockExerciseSchema.parse({ exerciseId: 1, measure: "reps", sets: [] })).not.toHaveProperty("skipped");
    expect(blockExerciseSchema.parse({ exerciseId: 1, measure: "reps", sets: [], skipped: true }).skipped).toBe(true);
    expect(maxEntryCreateSchema.parse({ date: "2026-11-01", valueLb: 300, source: "correction" }).source).toBe("correction");
  });
});
