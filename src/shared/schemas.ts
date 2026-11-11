/**
 * Data contracts shared by the API and the web app. Zod schemas validate input on the
 * server; the inferred types are used everywhere.
 */
import { z } from "zod";
import { isISODate } from "./dates";
import { ILL_FORMED_MESSAGE, isWellFormed } from "./text";

export const isoDate = z.string().refine(isISODate, "Expected a YYYY-MM-DD date");

/**
 * Any stored string. Postgres `text` and `jsonb` both reject U+0000, so it never gets that far —
 * nor does ill-formed text (a lone surrogate, see `isWellFormed`), which `jsonb` rejects too.
 * Nothing stored can hold either, so every document the server has ever returned still parses.
 */
export const safeString = () =>
  z
    .string()
    .regex(/^[^\u0000]*$/, "Must not contain NUL characters")
    .refine(isWellFormed, ILL_FORMED_MESSAGE);

const optNum = (min: number, max: number) => z.number().min(min).max(max).nullable();

// ---------------------------------------------------------------------------
// Daily log
// ---------------------------------------------------------------------------

export const dayLogFields = {
  weightLb: optNum(50, 1000),
  calories: optNum(0, 20000),
  proteinG: optNum(0, 2000),
  carbsG: optNum(0, 3000),
  fatG: optNum(0, 1000),
  micros: z.record(safeString().max(40), z.number().min(0).max(1_000_000)).nullable(),
  /**
   * Tracking only (no insight, checklist or score reads them): null = not recorded, true = had
   * it that day, false = recorded as none.
   */
  alcohol: z.boolean().nullable(),
  nicotine: z.boolean().nullable(),
  thc: z.boolean().nullable(),
  caffeine: z.boolean().nullable(),
  steps: z.number().int().min(0).max(200_000).nullable(),
  sleepScore: optNum(0, 100),
  hrvMs: optNum(0, 500),
  /** Resting heart rate, bpm (whole numbers in the editor). */
  restingHrBpm: optNum(20, 220),
  /** VO2 max estimate, mL/kg/min (one decimal in the editor). */
  vo2Max: optNum(10, 100),
  sleepMinutes: optNum(0, 24 * 60),
  energy: z.number().int().min(1).max(5).nullable(),
  soreness: z.number().int().min(1).max(5).nullable(),
  zone2Done: z.boolean(),
  zone2Minutes: optNum(0, 600),
  /**
   * The Zone 2 machine's calorie reading, whole kcal. A reading only: never part of intake, the
   * TDEE estimate, targets or anything else energy-related (nothing but the Zone 2 row reads it).
   */
  zone2Kcal: z.number().int().min(0).max(3000).nullable(),
  metconDone: z.boolean(),
  metconNotes: safeString().max(5000).nullable(),
  metconBenchmark: safeString().max(120).nullable(),
  metconScore: safeString().max(120).nullable(),
  journal: safeString().max(50_000).nullable(),
};

export const dayLogPatchSchema = z.object(dayLogFields).partial().strict();
export type DayLogPatch = z.infer<typeof dayLogPatchSchema>;

export const dayLogSchema = z.object({ date: isoDate, ...dayLogFields });
export type DayLog = z.infer<typeof dayLogSchema>;

// Lives in its own zod-free module so the web client can use it without bundling zod.
export { emptyDayLog } from "./empty";

// ---------------------------------------------------------------------------
// Exercises & maxes
// ---------------------------------------------------------------------------

export const exerciseCategory = z.enum(["primary", "accessory", "core", "carry", "conditioning"]);
export type ExerciseCategory = z.infer<typeof exerciseCategory>;

export const measure = z.enum(["reps", "seconds", "meters"]);
export type Measure = z.infer<typeof measure>;

export const exerciseSchema = z.object({
  id: z.number().int(),
  name: safeString().min(1).max(80),
  category: exerciseCategory,
  tracksMax: z.boolean(),
  measure,
  /**
   * Tracks a load (lb) with each set, whatever the measure: reps + load (rows), time + load
   * (weighted dead hang), distance + load (farmer's carry). Absent on exercises saved before it
   * existed (old backups, cached copies): those are weighted, as everything was. Read it through
   * `isWeighted()` (session.ts).
   */
  weighted: z.boolean().default(true),
  archived: z.boolean(),
});
export type Exercise = z.infer<typeof exerciseSchema>;

export const exerciseCreateSchema = z
  .object({
    name: safeString().trim().min(1).max(80),
    category: exerciseCategory.default("accessory"),
    tracksMax: z.boolean().default(false),
    measure: measure.default("reps"),
    /**
     * Absent = weighted (the server stores true), for every measure: clients from before the flag
     * existed showed a load on every exercise. Optional rather than defaulted so such a client's
     * queued create hashes the same as before (idempotent retries, see server/idempotency.ts).
     */
    weighted: z.boolean().optional(),
  })
  .strict();

export const exercisePatchSchema = z
  .object({
    name: safeString().trim().min(1).max(80),
    category: exerciseCategory,
    tracksMax: z.boolean(),
    measure,
    weighted: z.boolean(),
    archived: z.boolean(),
  })
  .partial()
  .strict();

/**
 * Where a max entry came from. `correction` restates the lift's current max (e.g. fixing an old
 * typo): it becomes the current value but is never celebrated as a PR or a strength-target hit.
 */
export const maxSource = z.enum(["initial", "manual", "amrap", "correction"]);
export type MaxSource = z.infer<typeof maxSource>;

export const maxEntrySchema = z.object({
  id: z.number().int(),
  exerciseId: z.number().int(),
  date: isoDate,
  valueLb: z.number(),
  source: maxSource,
  note: safeString().nullable(),
  createdAt: safeString(),
});
export type MaxEntry = z.infer<typeof maxEntrySchema>;

export const maxEntryCreateSchema = z
  .object({
    date: isoDate,
    valueLb: z.number().min(0).max(2000),
    source: maxSource.default("manual"),
    note: safeString().max(500).nullable().default(null),
    /**
     * When the entry was made on the device (an offline edit is sent later). The server clamps it
     * to a sane range; it orders entries for the correction window (gamify.ts).
     */
    createdAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Training program (all user-editable)
// ---------------------------------------------------------------------------

export const programWeekSchema = z.object({
  label: safeString().max(40),
  deload: z.boolean(),
  /** Reps for each set of the main lift, in order. */
  reps: z.array(z.number().int().min(1).max(50)).min(1).max(12),
  /**
   * When set, every set's load is based on this rep-max instead of the set's own reps
   * (deload: 4×10 at 90% of the 12-rep max).
   */
  basisReps: z.number().int().min(1).max(50).nullable(),
});
export type ProgramWeek = z.infer<typeof programWeekSchema>;

export const programDaySchema = z.object({
  label: safeString().max(40),
  /** The calculated main lift for the day, if any. */
  primaryExerciseId: z.number().int().nullable(),
  /** Whether the AMRAP progression rule applies to this day's main lift. */
  progression: z.boolean(),
});
export type ProgramDay = z.infer<typeof programDaySchema>;

export const programSchema = z.object({
  name: safeString().max(60),
  /** Monday the first cycle begins. */
  cycleStartDate: isoDate,
  weeks: z.array(programWeekSchema).min(1).max(16),
  /** Fraction of the N-rep max used as the working weight (0.9). */
  intensity: z.number().min(0.3).max(1.2),
  roundToLb: z.number().min(0.5).max(25),
  /** Rep count → fraction of 1RM. Missing rep counts are interpolated. */
  repMaxPct: z.record(z.string().regex(/^\d+$/), z.number().min(0.1).max(1)),
  amrapLastSet: z.boolean(),
  progression: z.object({
    enabled: z.boolean(),
    lbPerExtraRep: z.number().min(0).max(25),
  }),
  deloadAccessoryLoad: z.number().min(0.3).max(1),
  /** Keyed by weekday: "0" (Sun) … "6" (Sat). Days without an entry are not lifting days. */
  days: z.record(z.string().regex(/^[0-6]$/), programDaySchema),
});
export type Program = z.infer<typeof programSchema>;

// ---------------------------------------------------------------------------
// Settings (one document)
// ---------------------------------------------------------------------------

const weekdayFlags = z.array(z.boolean()).length(7);

export const settingsSchema = z.object({
  onboarded: z.boolean(),
  targets: z.object({
    steps: z.number().int().min(0).max(100_000),
    zone2Minutes: z.number().min(0).max(600),
  }),
  /** Which weekdays (index 0 = Sun) each pillar is expected. */
  schedule: z.object({
    metcon: weekdayFlags,
    zone2: weekdayFlags,
  }),
  nutrition: z.object({
    kcalPerLb: z.number().min(1000).max(6000),
    proteinGPerLb: z.number().min(0).max(3),
    fatGPerLb: z.number().min(0).max(2),
    /** Starting maintenance estimate used while the TDEE calibrates. */
    initialTdee: z.number().min(800).max(10000).nullable(),
  }),
  limits: z.object({
    maxLossPctPerWeek: z.number().min(0).max(3),
    maxGainPctPerWeek: z.number().min(0).max(3),
  }),
  weightGoal: z
    .object({
      targetLb: z.number().min(50).max(1000),
      /** Chosen pace in % of bodyweight per week (absolute). Capped by limits. */
      pacePctPerWeek: z.number().min(0).max(3),
      setOn: isoDate,
      /**
       * Bodyweight when the goal was set — fixes the goal's direction (cut vs build) so an
       * overshoot settles into maintenance instead of flipping into the opposite phase.
       * Optional for goals created before this field existed.
       */
      startLb: z.number().min(50).max(1000).nullable().optional(),
    })
    .nullable(),
  strengthTargets: z.array(
    z.object({
      id: safeString().max(40),
      exerciseId: z.number().int(),
      targetLb: z.number().min(1).max(2000),
      setOn: isoDate,
    }),
  ),
  program: programSchema,
  /**
   * Training preferences. Optional so settings stored before it existed still validate; read it
   * through `trainingPrefs()` (defaults.ts), never directly.
   */
  training: z
    .object({
      /** Rest timer target after a main-lift set, in seconds. */
      restSecondsMain: z.number().min(10).max(900),
      /** Rest timer target after an accessory set, in seconds. */
      restSecondsAccessory: z.number().min(10).max(900),
      /** Load added by a weighted accessory's progression hint ("hit every target last time → +5"). 0 turns hints off. */
      accessoryIncrementLb: z.number().min(0).max(50),
    })
    .optional(),
  /** Display preferences (read through `displayPrefs()`). Optional, like `training`. */
  display: z
    .object({
      /** "Outdoor" mode: brighter muted text, thicker chart lines. */
      highContrast: z.boolean(),
    })
    .optional(),
});
export type Settings = z.infer<typeof settingsSchema>;

// ---------------------------------------------------------------------------
// Training sessions (stored as a document per date)
// ---------------------------------------------------------------------------

export const setEntrySchema = z.object({
  id: safeString().max(40),
  targetReps: z.number().min(0).max(10_000).nullable(),
  targetWeight: z.number().min(0).max(2000).nullable(),
  /** Actual reps / seconds / meters performed. */
  reps: z.number().min(0).max(10_000).nullable(),
  weight: z.number().min(0).max(2000).nullable(),
  done: z.boolean(),
  amrap: z.boolean(),
  /** For AMRAP sets: the max increase already applied from this set. */
  appliedProgressionLb: z.number().nullable(),
});
export type SetEntry = z.infer<typeof setEntrySchema>;

/**
 * An exercise in a session. `measure` is snapshotted from the exercise: what the sets were counted in
 * when done, so changing the exercise's measure later leaves history as it was (pre-fill, hints and a
 * session in progress follow the exercise's current measure, see `effectiveSession`). Whether it
 * is weighted is not snapshotted — it is looked up on the exercise (`isWeighted`), so changing the
 * flag applies to the session in progress and to every later pre-fill.
 */
export const blockExerciseSchema = z.object({
  exerciseId: z.number().int(),
  measure,
  sets: z.array(setEntrySchema).max(30),
  /**
   * Skipped today only: excluded from volume and hints, but still carried into the next
   * same-weekday session (from its last non-skipped performance). Absent = not skipped.
   */
  skipped: z.boolean().optional(),
});
export type BlockExercise = z.infer<typeof blockExerciseSchema>;

export const blockSchema = z.object({
  id: safeString().max(40),
  kind: z.enum(["primary", "accessory"]),
  /** More than one exercise = superset. */
  exercises: z.array(blockExerciseSchema).min(1).max(6),
  /**
   * The main lift skipped today (e.g. an injury): its sets count toward nothing and the session can
   * still be finished. Not part of the plan signature. Absent = not skipped.
   */
  skipped: z.boolean().optional(),
});
export type Block = z.infer<typeof blockSchema>;

export const sessionSchema = z.object({
  date: isoDate,
  label: safeString().max(60),
  cycle: z.number().int().nullable(),
  week: z.number().int().nullable(),
  deload: z.boolean(),
  /** Max used to compute the main lift (snapshot at session creation). */
  primaryMaxLb: z.number().nullable(),
  blocks: z.array(blockSchema).max(30),
  notes: safeString().max(20_000),
  completedAt: safeString().nullable(),
  /**
   * What the program prescribed for the main lift when the session was built (`planSignature`),
   * null when nothing was. Absent on sessions saved before it existed.
   */
  planSig: safeString().max(2000).nullable().optional(),
  /**
   * The program day this session was planned for when it was moved to another date ("do this
   * session today", `buildSessionFrom`); null/absent = the session's own date.
   */
  plannedFor: isoDate.nullable().optional(),
});
export type Session = z.infer<typeof sessionSchema>;

// ---------------------------------------------------------------------------
// Bootstrap payload
// ---------------------------------------------------------------------------

/**
 * Server revisions of the whole-document resources (opaque strings). A save sends the revision
 * it was based on as `If-Match`; a stale one is answered 409 (see docs/SPEC.md §8).
 */
export interface Revs {
  settings: string;
  /** Per session date. A date without an entry has no saved session. */
  sessions: Record<string, string>;
}

export interface Bootstrap {
  settings: Settings;
  days: DayLog[];
  exercises: Exercise[];
  maxEntries: MaxEntry[];
  sessions: Session[];
  seenAchievements: string[];
  /** Always sent by the server; absent on copies cached before revisions existed. */
  revs?: Revs;
}

/** Body of a 409 answer to a version-checked save (`If-Match` / `If-None-Match: *`). */
export interface ConflictBody<T> {
  error: "conflict";
  /** The server's current document (null: there is none). */
  current: T | null;
  /** Its revision (null: there is none). */
  rev: string | null;
}
