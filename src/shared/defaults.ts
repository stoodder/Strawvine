/**
 * The athlete's current program and preferences, expressed as editable defaults.
 * Nothing here is special-cased anywhere else in the app.
 */
import { nextMonday, type ISODate } from "./dates";
import type { ExerciseCategory, Measure, Settings } from "./schemas";

export const SEED_EXERCISES: ReadonlyArray<{
  key: "bench" | "deadlift" | "backSquat" | "frontSquat" | "strictPress";
  name: string;
  category: ExerciseCategory;
  tracksMax: boolean;
  measure: Measure;
}> = [
  { key: "bench", name: "Bench press", category: "primary", tracksMax: true, measure: "reps" },
  { key: "deadlift", name: "Deadlift", category: "primary", tracksMax: true, measure: "reps" },
  { key: "backSquat", name: "Back squat", category: "primary", tracksMax: true, measure: "reps" },
  { key: "frontSquat", name: "Front squat", category: "primary", tracksMax: true, measure: "reps" },
  { key: "strictPress", name: "Strict press", category: "primary", tracksMax: true, measure: "reps" },
];

/** A few starting points for the carry / pull day so the library isn't empty. */
export const SEED_ACCESSORIES: ReadonlyArray<{ name: string; category: ExerciseCategory; measure: Measure }> = [
  { name: "Pull-up", category: "accessory", measure: "reps" },
  { name: "Sandbag clean", category: "carry", measure: "reps" },
  { name: "Sandbag carry", category: "carry", measure: "meters" },
  { name: "Farmer's carry", category: "carry", measure: "meters" },
];

export type SeedIds = Record<(typeof SEED_EXERCISES)[number]["key"], number>;

export const DEFAULT_REP_MAX_PCT: Record<string, number> = {
  "1": 1,
  "2": 0.95,
  "3": 0.93,
  "4": 0.9,
  "5": 0.87,
  "6": 0.85,
  "8": 0.8,
  "10": 0.75,
  "12": 0.7,
};

export type TrainingPrefs = NonNullable<Settings["training"]>;
export type DisplayPrefs = NonNullable<Settings["display"]>;

export const DEFAULT_TRAINING: Readonly<TrainingPrefs> = { restSecondsMain: 180, restSecondsAccessory: 90, accessoryIncrementLb: 5 };
export const DEFAULT_DISPLAY: Readonly<DisplayPrefs> = { highContrast: false };

/** Training preferences with defaults filled in (settings stored before they existed have none). */
export function trainingPrefs(settings: Settings | null | undefined): TrainingPrefs {
  return { ...DEFAULT_TRAINING, ...settings?.training };
}

/** Display preferences with defaults filled in. */
export function displayPrefs(settings: Settings | null | undefined): DisplayPrefs {
  return { ...DEFAULT_DISPLAY, ...settings?.display };
}

export function defaultSettings(ids: SeedIds, today: ISODate): Settings {
  return {
    onboarded: false,
    targets: { steps: 15000, zone2Minutes: 30 },
    schedule: {
      //        Sun    Mon   Tue   Wed   Thu   Fri   Sat
      metcon: [false, true, true, true, true, true, true],
      zone2: [false, true, true, true, true, true, false],
    },
    nutrition: { kcalPerLb: 3500, proteinGPerLb: 1, fatGPerLb: 0.35, initialTdee: null },
    limits: { maxLossPctPerWeek: 1, maxGainPctPerWeek: 0.5 },
    weightGoal: null,
    strengthTargets: [],
    program: {
      name: "Ascending powerbuilding",
      cycleStartDate: nextMonday(today),
      weeks: [
        { label: "Week 1", deload: false, reps: [6, 8, 10, 12], basisReps: null },
        { label: "Week 2", deload: false, reps: [5, 6, 8, 10], basisReps: null },
        { label: "Week 3", deload: false, reps: [4, 5, 6, 8], basisReps: null },
        { label: "Week 4", deload: false, reps: [3, 4, 5, 6], basisReps: null },
        { label: "Deload", deload: true, reps: [10, 10, 10, 10], basisReps: 12 },
      ],
      intensity: 0.9,
      roundToLb: 5,
      repMaxPct: { ...DEFAULT_REP_MAX_PCT },
      amrapLastSet: true,
      progression: { enabled: true, lbPerExtraRep: 1 },
      deloadAccessoryLoad: 0.8,
      days: {
        "1": { label: "Push", primaryExerciseId: ids.bench, progression: true },
        "2": { label: "Pull", primaryExerciseId: ids.deadlift, progression: true },
        "3": { label: "Legs", primaryExerciseId: ids.backSquat, progression: true },
        "4": { label: "Push", primaryExerciseId: ids.strictPress, progression: true },
        "5": { label: "Carries & pull", primaryExerciseId: null, progression: false },
      },
    },
    training: { ...DEFAULT_TRAINING },
    display: { ...DEFAULT_DISPLAY },
  };
}
