/**
 * Builds a day's training session from the program + history so the athlete never has to
 * plan at the gym: the main lift is calculated, accessories are carried over from the last
 * session of the same day type (deloaded when appropriate).
 */
import { formatShortDate, weekdayOf, type ISODate } from "./dates";
import { cyclePosition, currentMax, mainLiftSets, programDayFor, roundTo } from "./program";
import type { Block, BlockExercise, Exercise, MaxEntry, Session, SetEntry, Settings } from "./schemas";

export function newId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID().slice(0, 8);
  return Math.random().toString(36).slice(2, 10);
}

export function blankSet(partial: Partial<SetEntry> = {}): SetEntry {
  return {
    id: newId(),
    targetReps: null,
    targetWeight: null,
    reps: null,
    weight: null,
    done: false,
    amrap: false,
    appliedProgressionLb: null,
    ...partial,
  };
}

export interface BuildContext {
  settings: Settings;
  exercises: ReadonlyArray<Exercise>;
  maxEntries: ReadonlyArray<MaxEntry>;
  sessions: ReadonlyArray<Session>;
}

/** Most recent earlier session on the same weekday, preferring non-deload weeks. */
function templateSource(date: ISODate, sessions: ReadonlyArray<Session>): Session | null {
  const wd = weekdayOf(date);
  const prior = sessions
    .filter((s) => s.date < date && weekdayOf(s.date) === wd && s.blocks.some((b) => b.kind === "accessory"))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  return prior.find((s) => !s.deload) ?? prior[0] ?? null;
}

/** Finest plate step used when the program's rounding can't make a light accessory lighter. */
const FINE_STEP_LB = 2.5;

/**
 * `weightLb` scaled by `factor` and rounded to the program increment. A deloaded load must come
 * out lighter without vanishing, but at 5 lb rounding small loads round straight back (10 → 10)
 * or away to nothing (3 → 0). Those use a 2.5 lb increment instead (never coarser than the
 * program's), and failing that drop one such step, never below 0.
 */
function scaleLoad(weightLb: number, factor: number, roundToLb: number): number {
  const target = weightLb * factor;
  const rounded = roundTo(target, roundToLb);
  if (factor >= 1 || (rounded > 0 && rounded < weightLb)) return rounded;
  const step = Math.min(roundToLb, FINE_STEP_LB);
  const fine = roundTo(target, step);
  if (fine > 0 && fine < weightLb) return fine;
  return Math.max(0, weightLb - step);
}

function carryOverExercise(ex: BlockExercise, loadFactor: number, roundToLb: number): BlockExercise {
  return {
    exerciseId: ex.exerciseId,
    measure: ex.measure,
    sets: ex.sets.map((s) => {
      const weight = s.weight ?? s.targetWeight;
      const scaled = weight !== null && weight > 0 && loadFactor !== 1 ? scaleLoad(weight, loadFactor, roundToLb) : weight;
      return blankSet({ targetReps: s.reps ?? s.targetReps, targetWeight: scaled });
    }),
  };
}

const byDateDesc = (a: Session, b: Session) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);

/**
 * The most recent time `exerciseId` was actually done (not skipped) before `date`, preferring
 * sessions on the same weekday. Used to carry a skipped exercise forward from real numbers.
 */
function lastPerformance(
  exerciseId: number,
  date: ISODate,
  sessions: ReadonlyArray<Session>,
): { session: Session; exercise: BlockExercise } | null {
  const wd = weekdayOf(date);
  const prior = sessions.filter((s) => s.date < date).sort(byDateDesc);
  const find = (s: Session) =>
    s.blocks.flatMap((b) => (b.kind === "accessory" ? b.exercises : [])).find((e) => e.exerciseId === exerciseId && !e.skipped);
  for (const sameDay of [true, false])
    for (const s of prior) {
      if ((weekdayOf(s.date) === wd) !== sameDay) continue;
      const exercise = find(s);
      if (exercise) return { session: s, exercise };
    }
  return null;
}

/**
 * The main-lift block the program prescribes for `date` (fresh ids), the max it was computed
 * from, and the program context — the part of `buildSession` that depends only on settings,
 * exercises and maxes.
 */
function plannedPrimary(date: ISODate, ctx: Omit<BuildContext, "sessions">) {
  const { program } = ctx.settings;
  const day = programDayFor(program, date);
  const pos = cyclePosition(program, date);
  let block: Block | null = null;
  let primaryMaxLb: number | null = null;
  if (day?.primaryExerciseId != null && pos) {
    const ex = ctx.exercises.find((e) => e.id === day.primaryExerciseId);
    const max = currentMax(ctx.maxEntries, day.primaryExerciseId);
    if (ex && max) {
      primaryMaxLb = max.valueLb;
      const planned = mainLiftSets(program, max.valueLb, pos.week, { progressionDay: day.progression });
      block = {
        id: newId(),
        kind: "primary",
        exercises: [
          {
            exerciseId: ex.id,
            measure: "reps",
            sets: planned.map((p) => blankSet({ targetReps: p.reps, targetWeight: p.weightLb, amrap: p.amrap })),
          },
        ],
      };
    }
  }
  return { day, pos, block, primaryMaxLb };
}

export function buildSession(date: ISODate, ctx: BuildContext): Session {
  const { program } = ctx.settings;
  const { day, pos, block: primary, primaryMaxLb } = plannedPrimary(date, ctx);
  const blocks: Block[] = primary ? [primary] : [];

  const source = templateSource(date, ctx.sessions);
  if (source) {
    const factorFrom = (from: Session) => (pos?.week.deload && !from.deload ? program.deloadAccessoryLoad : 1);
    for (const b of source.blocks) {
      if (b.kind !== "accessory") continue;
      const exercises = b.exercises
        .filter((e) => ctx.exercises.some((x) => x.id === e.exerciseId && !x.archived))
        .map((e) => {
          // Skipped last time: still on the plan, prefilled from the last time it was really done.
          const done = e.skipped ? lastPerformance(e.exerciseId, date, ctx.sessions) : null;
          return done
            ? carryOverExercise(done.exercise, factorFrom(done.session), program.roundToLb)
            : carryOverExercise(e, factorFrom(source), program.roundToLb);
        });
      if (exercises.length) blocks.push({ id: newId(), kind: "accessory", exercises });
    }
  }

  return {
    date,
    label: day?.label ?? "Training",
    cycle: pos?.cycle ?? null,
    week: pos ? pos.weekIndex + 1 : null,
    deload: pos?.week.deload ?? false,
    primaryMaxLb,
    blocks,
    notes: "",
    completedAt: null,
  };
}

const sameNum = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) < 1e-6);

/**
 * Whether a saved session's main lift still matches what the program would plan for its date
 * now: same lift, deload flag, and — for each prescribed set — reps, AMRAP flag and target
 * weight. Ids are ignored, and so are back-off sets added after the prescribed ones. A session
 * with no main lift matches when none is planned either.
 */
export function planMatches(session: Session, ctx: BuildContext): boolean {
  const { block, pos } = plannedPrimary(session.date, ctx);
  const deload = pos?.week.deload ?? false;
  const saved = session.blocks.find((b) => b.kind === "primary")?.exercises[0];
  const fresh = block?.exercises[0];
  if (!saved || !fresh) return !saved && !fresh;
  if (saved.exerciseId !== fresh.exerciseId || session.deload !== deload) return false;
  if (saved.sets.length < fresh.sets.length) return false;
  return fresh.sets.every((p, i) => {
    const s = saved.sets[i]!;
    return sameNum(s.targetReps, p.targetReps) && s.amrap === p.amrap && sameNum(s.targetWeight, p.targetWeight);
  });
}

export interface AccessoryHint {
  /** Heaviest load logged last time. */
  lastWeight: number;
  suggestedWeight: number;
  /** Short explanation, e.g. "All reps at 50 lb on Nov 2 → +5 lb". */
  reason: string;
}

/**
 * Progression hint for an accessory: when every logged set of its most recent (non-skipped,
 * started) performance before `beforeDate` met its target reps with a load, suggest the
 * heaviest of those loads + `incrementLb`. Null otherwise, or when the increment is 0.
 */
export function accessoryHint(
  exerciseId: number,
  beforeDate: ISODate,
  sessions: ReadonlyArray<Session>,
  incrementLb: number,
): AccessoryHint | null {
  if (!(incrementLb > 0)) return null;
  const prior = sessions.filter((s) => s.date < beforeDate).sort(byDateDesc);
  for (const s of prior) {
    const logged = s.blocks
      .filter((b) => b.kind === "accessory")
      .flatMap((b) => b.exercises)
      .filter((e) => e.exerciseId === exerciseId && !e.skipped)
      .flatMap((e) => e.sets.filter((x) => x.done));
    if (!logged.length) continue;
    let lastWeight = 0;
    for (const x of logged) {
      const reps = x.reps ?? x.targetReps;
      const weight = x.weight ?? x.targetWeight;
      if (x.targetReps === null || reps === null || reps < x.targetReps || weight === null || weight <= 0) return null;
      lastWeight = Math.max(lastWeight, weight);
    }
    const suggestedWeight = Math.round((lastWeight + incrementLb) * 100) / 100;
    return {
      lastWeight,
      suggestedWeight,
      reason: `All reps at ${lastWeight} lb on ${formatShortDate(s.date)} → +${incrementLb} lb`,
    };
  }
  return null;
}

/** Total load moved (weight × reps) across completed sets of rep-measured, not-skipped exercises. */
export function sessionVolume(session: Session): number {
  let total = 0;
  for (const b of session.blocks)
    for (const e of b.exercises) {
      if (e.measure !== "reps" || e.skipped) continue;
      for (const s of e.sets) if (s.done) total += (s.weight ?? s.targetWeight ?? 0) * (s.reps ?? s.targetReps ?? 0);
    }
  return total;
}

export function isSessionStarted(session: Session): boolean {
  return session.blocks.some((b) => b.exercises.some((e) => e.sets.some((s) => s.done)));
}
