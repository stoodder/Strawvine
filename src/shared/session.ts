/**
 * Builds a day's training session from the program + history so the athlete never has to
 * plan at the gym: the main lift is calculated, accessories are carried over from the last
 * session of the same day type (deloaded when appropriate).
 */
import { weekdayOf, type ISODate } from "./dates";
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

export function buildSession(date: ISODate, ctx: BuildContext): Session {
  const { program } = ctx.settings;
  const day = programDayFor(program, date);
  const pos = cyclePosition(program, date);
  const blocks: Block[] = [];
  let primaryMaxLb: number | null = null;

  if (day?.primaryExerciseId != null && pos) {
    const ex = ctx.exercises.find((e) => e.id === day.primaryExerciseId);
    const max = currentMax(ctx.maxEntries, day.primaryExerciseId);
    if (ex && max) {
      primaryMaxLb = max.valueLb;
      const planned = mainLiftSets(program, max.valueLb, pos.week, { progressionDay: day.progression });
      blocks.push({
        id: newId(),
        kind: "primary",
        exercises: [
          {
            exerciseId: ex.id,
            measure: "reps",
            sets: planned.map((p) => blankSet({ targetReps: p.reps, targetWeight: p.weightLb, amrap: p.amrap })),
          },
        ],
      });
    }
  }

  const source = templateSource(date, ctx.sessions);
  if (source) {
    const loadFactor = pos?.week.deload && !source.deload ? program.deloadAccessoryLoad : 1;
    for (const b of source.blocks) {
      if (b.kind !== "accessory") continue;
      const exercises = b.exercises
        .filter((e) => ctx.exercises.some((x) => x.id === e.exerciseId && !x.archived))
        .map((e) => carryOverExercise(e, loadFactor, program.roundToLb));
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

/** Total load moved (weight × reps) across completed sets of rep-measured exercises. */
export function sessionVolume(session: Session): number {
  let total = 0;
  for (const b of session.blocks)
    for (const e of b.exercises) {
      if (e.measure !== "reps") continue;
      for (const s of e.sets) if (s.done) total += (s.weight ?? s.targetWeight ?? 0) * (s.reps ?? s.targetReps ?? 0);
    }
  return total;
}

export function isSessionStarted(session: Session): boolean {
  return session.blocks.some((b) => b.exercises.some((e) => e.sets.some((s) => s.done)));
}
