/**
 * Builds a day's training session from the program + history so the athlete never has to
 * plan at the gym: the main lift is calculated, accessories are carried over from the last
 * session of the same day type (deloaded when appropriate).
 */
import { addDays, formatShortDate, weekdayOf, type ISODate } from "./dates";
import { cyclePosition, currentMax, mainLiftSets, programDayFor, roundTo, scheduledProgramDay } from "./program";
import type { Block, BlockExercise, Exercise, Measure, MaxEntry, Session, SetEntry, Settings } from "./schemas";

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

/**
 * A main lift (tracks a max, or a barbell lift): its sets always carry a load, so whether it is
 * weighted isn't a choice (§6.5).
 */
export const isMainLift = (e: Partial<Pick<Exercise, "tracksMax" | "category">>): boolean =>
  e.tracksMax === true || e.category === "primary";

/**
 * Whether an exercise tracks a load with its sets. A main lift (`isMainLift`) always does, whatever
 * its stored flag says (the rule is applied when read, so a flag saved off elsewhere can't take a
 * main lift's load away). An unknown exercise, or one saved before the flag existed, counts as
 * weighted: a load was shown on everything then.
 */
export const isWeighted = (
  ex: (Pick<Exercise, "weighted"> & Partial<Pick<Exercise, "tracksMax" | "category">>) | null | undefined,
): boolean => !ex || isMainLift(ex) || ex.weighted !== false;

/** Target for a set of an exercise done for the first time: 10 reps, 30 seconds or 40 meters. */
export function defaultTarget(measure: Measure): number {
  return measure === "seconds" ? 30 : measure === "meters" ? 40 : 10;
}

/**
 * The load an open (not yet logged) set is pending at: its target — none for an unweighted
 * exercise. A target load left over from when the exercise was weighted (a session pre-filled
 * then) is ignored, not deleted: making the exercise weighted again brings it back.
 */
export function effectiveTargetWeight(set: Pick<SetEntry, "targetWeight">, weighted: boolean): number | null {
  return weighted ? set.targetWeight : null;
}

/**
 * The load a set shows: once logged, what it was logged with (null: none); before that, its
 * pending target (`effectiveTargetWeight`).
 */
export function shownLoad(set: Pick<SetEntry, "done" | "weight" | "targetWeight">, weighted: boolean): number | null {
  return set.done ? set.weight : effectiveTargetWeight(set, weighted);
}

/**
 * The load a set is logged with when logged at its targets (one tap, "log remaining"): the load
 * entered, else its target — none for an unweighted exercise, whatever load the set still holds.
 */
export function loggedWeightFor(set: Pick<SetEntry, "weight" | "targetWeight">, weighted: boolean): number | null {
  return weighted ? (set.weight ?? set.targetWeight) : null;
}

/** `set` logged at its targets: reps done = the target unless entered, load per `loggedWeightFor`. */
export function logAtTargets(set: SetEntry, weighted: boolean): SetEntry {
  return { ...set, done: true, reps: set.reps ?? set.targetReps, weight: loggedWeightFor(set, weighted) };
}

/**
 * Whether a tap can't log this set as it is: an open set of a weighted exercise with no load yet
 * (neither entered nor targeted). Logging it would record a weighted set without a load, so the
 * set editor opens instead.
 */
export function needsLoadBeforeLogging(set: Pick<SetEntry, "done" | "weight" | "targetWeight">, weighted: boolean): boolean {
  return weighted && !set.done && !((set.weight ?? 0) > 0) && !((set.targetWeight ?? 0) > 0);
}

/**
 * The set added after `last` (the "+" next to an exercise's sets): `last`'s reps — done, else
 * its target — as the target, and its load for a weighted exercise. An unweighted exercise's new
 * set has no load, even next to an old set that has one.
 */
export function nextSetAfter(last: SetEntry | undefined, weighted: boolean): SetEntry {
  return blankSet({
    targetReps: last?.reps ?? last?.targetReps ?? null,
    targetWeight: weighted ? (last?.weight ?? last?.targetWeight ?? null) : null,
  });
}

export interface BuildContext {
  settings: Settings;
  exercises: ReadonlyArray<Exercise>;
  maxEntries: ReadonlyArray<MaxEntry>;
  sessions: ReadonlyArray<Session>;
}

/**
 * The date whose program day a session follows: `plannedFor` when it was moved ("do this session
 * today"), else its own date. A Monday plan done on a Sunday is a Monday session for pre-fill.
 */
export const planDateOf = (s: Pick<Session, "date" | "plannedFor">): ISODate => s.plannedFor ?? s.date;

/** Most recent earlier session of the same day type (weekday of its plan), preferring non-deload weeks. */
function templateSource(date: ISODate, sessions: ReadonlyArray<Session>): Session | null {
  const wd = weekdayOf(date);
  const prior = sessions
    .filter((s) => s.date < date && weekdayOf(planDateOf(s)) === wd && s.blocks.some((b) => b.kind === "accessory"))
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

/**
 * The next session's prescription for an exercise, in the exercise's *current* measure and load
 * (`current`). Reps carry over as *targets* — a missed rep must not become next week's target —
 * except for sets the athlete added without one, which carry what was done. Loads carry what was
 * actually lifted, scaled by `loadFactor`, whatever the measure (a weighted hang or carry deloads
 * too); an unweighted exercise carries no load. When the exercise's measure has changed since `ex`
 * was done (reps then, timed now), only the set count and loads carry: every target starts at the
 * new measure's `defaultTarget`.
 */
function carryOverExercise(
  ex: BlockExercise,
  loadFactor: number,
  roundToLb: number,
  current: Pick<Exercise, "measure" | "weighted">,
): BlockExercise {
  const weighted = isWeighted(current);
  const sameMeasure = ex.measure === current.measure;
  return {
    exerciseId: ex.exerciseId,
    measure: current.measure,
    sets: ex.sets.map((s) => {
      const weight = weighted ? (s.weight ?? s.targetWeight) : null;
      const scaled = weight !== null && weight > 0 && loadFactor !== 1 ? scaleLoad(weight, loadFactor, roundToLb) : weight;
      const targetReps = sameMeasure ? (s.targetReps ?? s.reps) : defaultTarget(current.measure);
      return blankSet({ targetReps, targetWeight: scaled });
    }),
  };
}

const byDateDesc = (a: Session, b: Session) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);

/**
 * The most recent time `exerciseId` was actually done (not skipped) in an accessory block of a
 * session before `date`. Normal weeks win over deload weeks (a deload's lighter loads must not
 * become the new normal), then the same weekday as `planDate` over others. Used to carry a skipped
 * exercise forward from real numbers, and to pre-fill one added by hand.
 */
function lastPerformance(
  exerciseId: number,
  date: ISODate,
  sessions: ReadonlyArray<Session>,
  planDate: ISODate = date,
): { session: Session; exercise: BlockExercise } | null {
  const wd = weekdayOf(planDate);
  const prior = sessions.filter((s) => s.date < date).sort(byDateDesc);
  const find = (s: Session) =>
    s.blocks.flatMap((b) => (b.kind === "accessory" ? b.exercises : [])).find((e) => e.exerciseId === exerciseId && !e.skipped);
  for (const deload of [false, true])
    for (const sameDay of [true, false])
      for (const s of prior) {
        if (s.deload !== deload || (weekdayOf(planDateOf(s)) === wd) !== sameDay) continue;
        const exercise = find(s);
        if (exercise) return { session: s, exercise };
      }
  return null;
}

/**
 * How much a load carried from a session is scaled for the week it's carried into: down into a
 * deload (`deloadAccessoryLoad`), and back up from a deload into a normal week, so deload loads
 * never carry into a normal week.
 */
function loadFactor(program: Settings["program"], toDeload: boolean, fromDeload: boolean): number {
  const factor = (deload: boolean) => (deload ? program.deloadAccessoryLoad : 1);
  return factor(toDeload) / factor(fromDeload);
}

/**
 * Sets for an exercise added by hand to the session `into`: carried over from the last time it was
 * done before that session, exactly as the session's own pre-fill would carry it (`buildSession`:
 * accessory blocks only, never a skipped performance, a normal week before a deload one, targets
 * rather than missed reps, loads scaled between deload and normal weeks, none for an unweighted
 * exercise, targets reset when it was last done in another measure). Never done: three sets at the
 * measure's default target.
 */
export function setsForAddedExercise(
  exercise: Pick<Exercise, "id" | "measure" | "weighted">,
  into: Pick<Session, "date" | "plannedFor" | "deload">,
  ctx: Pick<BuildContext, "settings" | "sessions">,
): SetEntry[] {
  const { program } = ctx.settings;
  const done = lastPerformance(exercise.id, into.date, ctx.sessions, planDateOf(into));
  const factor = done ? loadFactor(program, into.deload, done.session.deload) : 1;
  const carried = done ? carryOverExercise(done.exercise, factor, program.roundToLb, exercise).sets : [];
  return carried.length ? carried : Array.from({ length: 3 }, () => blankSet({ targetReps: defaultTarget(exercise.measure) }));
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
    // Loads are scaled from the week they come from to this one: down into a deload, and back up
    // when only a deload performance exists, so deload loads never carry into a normal week.
    const factorFrom = (from: Session) => loadFactor(program, pos?.week.deload ?? false, from.deload);
    for (const b of source.blocks) {
      if (b.kind !== "accessory") continue;
      const exercises = b.exercises.flatMap((e) => {
        const ex = ctx.exercises.find((x) => x.id === e.exerciseId && !x.archived);
        if (!ex) return [];
        // Skipped last time: still on the plan, prefilled from the last time it was really done.
        const done = e.skipped ? lastPerformance(e.exerciseId, date, ctx.sessions) : null;
        return [
          done
            ? carryOverExercise(done.exercise, factorFrom(done.session), program.roundToLb, ex)
            : carryOverExercise(e, factorFrom(source), program.roundToLb, ex),
        ];
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
    planSig: signatureOf(primary, pos),
  };
}

/**
 * "Do this session today": the plan for `sourceDate` — its main lift for that program day and
 * week, and the accessories carried into it — saved under `targetDate`. Keeps the source day's
 * label, cycle, week and plan signature, and records `plannedFor: sourceDate` so pre-fill, the
 * plan-changed check and recalculation keep following the source day.
 */
export function buildSessionFrom(sourceDate: ISODate, targetDate: ISODate, ctx: BuildContext): Session {
  const planned = buildSession(sourceDate, ctx);
  return { ...planned, date: targetDate, plannedFor: sourceDate === targetDate ? null : sourceDate };
}

/**
 * The session that did `date`'s plan on another day ("do this session today": a session with
 * `plannedFor === date` saved under another date), or null. A completed one wins over one only
 * saved, then the latest. `buildSession(date)` still builds that day's plan; callers decide what
 * to show (Train shows the day as done early, the checklist credits its lift).
 */
export function sessionDoneEarly(date: ISODate, sessions: ReadonlyArray<Session>): Session | null {
  return movedSessionsByPlan(sessions).get(date) ?? null;
}

const movedMemo = new WeakMap<object, Map<ISODate, Session>>();

/** `sessionDoneEarly` for every plan date at once (memoized per sessions array). */
export function movedSessionsByPlan(sessions: ReadonlyArray<Session>): ReadonlyMap<ISODate, Session> {
  let index = movedMemo.get(sessions);
  if (!index) {
    index = new Map();
    for (const s of sessions) {
      if (!s.plannedFor || s.plannedFor === s.date) continue;
      const held = index.get(s.plannedFor);
      // Completed wins over only saved, then the later date.
      if (!held || (!!s.completedAt !== !!held.completedAt ? !!s.completedAt : s.date > held.date)) index.set(s.plannedFor, s);
    }
    movedMemo.set(sessions, index);
  }
  return index;
}

export interface NextSession {
  date: ISODate;
  /** The program day's label ("Push"). */
  label: string;
  /** The day's main lift, or null when it has none (or it's unknown). */
  liftName: string | null;
  /** The program week's label ("Week 3", "Deload"). */
  weekLabel: string;
}

/** How far ahead `nextSession` looks. */
export const NEXT_SESSION_HORIZON_DAYS = 14;

/**
 * The next program day after `today` (within NEXT_SESSION_HORIZON_DAYS), or null. A day whose
 * plan was already done early ("do this session today", a session with `plannedFor` that day
 * dated before it) is passed over.
 */
export function nextSession(
  today: ISODate,
  data: Pick<BuildContext, "settings" | "exercises"> & { sessions?: ReadonlyArray<Session> },
): NextSession | null {
  const { program } = data.settings;
  const pulledForward = new Set(
    (data.sessions ?? []).filter((s) => s.plannedFor && s.date < s.plannedFor && s.plannedFor > today).map((s) => s.plannedFor!),
  );
  for (let i = 1; i <= NEXT_SESSION_HORIZON_DAYS; i++) {
    const date = addDays(today, i);
    const day = scheduledProgramDay(program, date);
    const pos = day ? cyclePosition(program, date) : null;
    if (!day || !pos || pulledForward.has(date)) continue;
    const lift = day.primaryExerciseId != null ? data.exercises.find((e) => e.id === day.primaryExerciseId) : undefined;
    return { date, label: day.label, liftName: lift?.name ?? null, weekLabel: pos.week.label };
  }
  return null;
}

type PlannedPrimary = ReturnType<typeof plannedPrimary>;

function signatureOf(block: Block | null, pos: PlannedPrimary["pos"]): string | null {
  const ex = block?.exercises[0];
  if (!ex || !pos) return null;
  return JSON.stringify({
    exerciseId: ex.exerciseId,
    week: pos.weekIndex,
    deload: pos.week.deload,
    sets: ex.sets.map((s) => [s.targetReps, s.targetWeight, s.amrap]),
  });
}

/**
 * A stable string of what the program prescribes for `date`'s main lift — lift, week, deload
 * flag and each set's reps, target weight and AMRAP flag — or null when no main lift is planned.
 * `buildSession` stores it as `planSig`, so a later program or max change can be told apart from
 * the athlete editing their own targets.
 */
export function planSignature(date: ISODate, ctx: Omit<BuildContext, "sessions">): string | null {
  const { block, pos } = plannedPrimary(date, ctx);
  return signatureOf(block, pos);
}

/**
 * Whether the program now prescribes something different for a saved session's main lift than
 * when the session was built. Sessions saved before `planSig` existed fall back to comparing the
 * saved sets with a fresh plan (`planMatches`).
 */
export function planChanged(session: Session, ctx: Omit<BuildContext, "sessions">): boolean {
  if (session.planSig !== undefined) return planSignature(planDateOf(session), ctx) !== session.planSig;
  return !planMatches(session, ctx);
}

export interface SetCounts {
  done: number;
  total: number;
}

/** Logged and total sets of one block (the main lift, an exercise, a superset), leaving out what was skipped today. */
export function blockCounts(block: Block): SetCounts {
  let done = 0;
  let total = 0;
  if (!block.skipped)
    for (const e of block.exercises) {
      if (e.skipped) continue;
      total += e.sets.length;
      for (const s of e.sets) if (s.done) done++;
    }
  return { done, total };
}

/** Logged and total sets of a session, leaving out exercises (and a main lift) skipped today. */
export function sessionCounts(session: Session): SetCounts {
  let done = 0;
  let total = 0;
  for (const b of session.blocks) {
    const c = blockCounts(b);
    done += c.done;
    total += c.total;
  }
  return { done, total };
}

/**
 * Every counted set is logged — and at least one is (what was skipped counts for nothing, so
 * something must be logged). The one rule for "done": the session's counts offer Finish from the
 * dock by it, a block's counts (`blockComplete`) fold that block to its summary on Train.
 */
export const allLogged = ({ done, total }: SetCounts): boolean => done > 0 && done >= total;

/**
 * Whether a block is complete: every set of it is logged (`allLogged` of `blockCounts`). A
 * superset is one block, so it is complete as a whole — a member skipped today doesn't hold it
 * open, as it doesn't hold Finish back. A block skipped entirely (or without sets) isn't complete.
 */
export const blockComplete = (block: Block): boolean => allLogged(blockCounts(block));

const sameNum = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) < 1e-6);

/**
 * Whether a saved session's main lift still matches what the program would plan for its date
 * now: same lift, deload flag, and — for each prescribed set — reps, AMRAP flag and target
 * weight. Ids are ignored, and so are back-off sets added after the prescribed ones. A session
 * with no main lift matches when none is planned either.
 */
export function planMatches(session: Session, ctx: Omit<BuildContext, "sessions">): boolean {
  const { block, pos } = plannedPrimary(planDateOf(session), ctx);
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
  /**
   * "increase": every logged set met its target → suggest a heavier load. "hold": a set fell
   * short of its target → stay at the same load.
   */
  kind: "increase" | "hold";
  /** What the targets counted (from the performance the hint is based on). */
  measure: Measure;
  /** Heaviest load logged last time. */
  lastWeight: number;
  /** `lastWeight + incrementLb` for "increase", `lastWeight` for "hold". */
  suggestedWeight: number;
  /** Short explanation, e.g. "All reps at 50 lb on Nov 2 → +5 lb" / "Missed reps at 50 lb on Nov 2 — hold". */
  reason: string;
}

/** "all reps" / "full duration" / "full distance": every set met its target, in the measure's words. */
export function targetsMetPhrase(measure: Measure): string {
  return measure === "seconds" ? "full duration" : measure === "meters" ? "full distance" : "all reps";
}

/** "Missed reps" / "Short on duration" / "Short on distance": a set fell short of its target. */
function targetMissedPhrase(measure: Measure): string {
  return measure === "seconds" ? "Short on duration" : measure === "meters" ? "Short on distance" : "Missed reps";
}

/**
 * Progression hint for a weighted accessory, from its most recent (non-skipped, started,
 * non-deload) performance with a load before `beforeDate`. When every logged set met that
 * session's target — reps, seconds or meters — with a load: "increase" to the heaviest of those
 * loads + `incrementLb`. When a set fell short: "hold" at that load. Deload weeks are ignored:
 * their light loads say nothing about progress; so are performances logged without any load (while
 * the exercise was unweighted), and — given the exercise's current `measure` — performances done in
 * another measure (12 reps from before the exercise became a timed hold say nothing about a hold).
 * Null for an unweighted exercise (`weighted: false`), when a logged set of the performance has no
 * target or no load, when nothing was logged with a load, or when the increment is 0 (hints off). A
 * logged set's load is what it was logged with, never its target.
 */
export function accessoryHint(
  exerciseId: number,
  beforeDate: ISODate,
  sessions: ReadonlyArray<Session>,
  incrementLb: number,
  { weighted, measure: current }: { weighted: boolean; measure?: Measure },
): AccessoryHint | null {
  if (!(incrementLb > 0) || !weighted) return null;
  const prior = sessions.filter((s) => s.date < beforeDate && !s.deload).sort(byDateDesc);
  for (const s of prior) {
    const performed = s.blocks
      .filter((b) => b.kind === "accessory")
      .flatMap((b) => b.exercises)
      .filter((e) => e.exerciseId === exerciseId && !e.skipped && (current === undefined || e.measure === current));
    const logged = performed.flatMap((e) => e.sets.filter((x) => x.done));
    // Nothing logged, or nothing logged with a load (done while unweighted): look further back.
    if (!logged.some((x) => (x.weight ?? 0) > 0)) continue;
    const measure = performed.find((e) => e.sets.some((x) => x.done))!.measure;
    let lastWeight = 0;
    let missed = false;
    for (const x of logged) {
      const reps = x.reps ?? x.targetReps;
      const weight = x.weight;
      if (x.targetReps === null || reps === null || weight === null || weight <= 0) return null;
      if (reps < x.targetReps) missed = true;
      lastWeight = Math.max(lastWeight, weight);
    }
    const on = formatShortDate(s.date);
    if (missed)
      return {
        kind: "hold",
        measure,
        lastWeight,
        suggestedWeight: lastWeight,
        reason: `${targetMissedPhrase(measure)} at ${lastWeight} lb on ${on} — hold`,
      };
    const suggestedWeight = Math.round((lastWeight + incrementLb) * 100) / 100;
    const met = targetsMetPhrase(measure);
    return {
      kind: "increase",
      measure,
      lastWeight,
      suggestedWeight,
      reason: `${met[0]!.toUpperCase()}${met.slice(1)} at ${lastWeight} lb on ${on} → +${incrementLb} lb`,
    };
  }
  return null;
}

/**
 * Total load moved (weight × reps) across completed sets of rep-measured, not-skipped exercises
 * (and main lift). Time and distance never count, loaded or not (seconds × lb isn't volume); a set
 * logged without a load (an unweighted exercise) adds 0 — its load is what it was logged with,
 * never a target it still holds.
 */
export function sessionVolume(session: Session): number {
  let total = 0;
  for (const b of session.blocks)
    if (!b.skipped)
      for (const e of b.exercises) {
        if (e.measure !== "reps" || e.skipped) continue;
        for (const s of e.sets) if (s.done) total += (s.weight ?? 0) * (s.reps ?? s.targetReps ?? 0);
      }
  return total;
}

export function isSessionStarted(session: Session): boolean {
  return session.blocks.some((b) => b.exercises.some((e) => e.sets.some((s) => s.done)));
}

/**
 * An accessory exercise of a session as it is shown and logged now (§6.5). The block keeps the
 * measure it was saved in, but while nothing of it is logged it follows the exercise's current
 * `measure` (looked up, like `weighted`): it is presented in that measure with every set's target
 * at the measure's `defaultTarget` (set count, ids and loads kept; reps entered in the old measure
 * dropped). Nothing is rewritten — the saved block keeps its own measure and targets, so changing
 * the measure back brings them back. Once a set is logged the block keeps the measure it was done
 * in. The same object when nothing differs (an unknown exercise, the same measure, a set logged).
 */
export function effectiveBlockExercise(ex: BlockExercise, exercise: Pick<Exercise, "measure"> | null | undefined): BlockExercise {
  if (!exercise || ex.measure === exercise.measure || ex.sets.some((x) => x.done)) return ex;
  const targetReps = defaultTarget(exercise.measure);
  return { ...ex, measure: exercise.measure, sets: ex.sets.map((x) => ({ ...x, targetReps, reps: null })) };
}

/** The measure an accessory exercise of a session is shown and logged in (`effectiveBlockExercise`). */
export function effectiveMeasure(ex: BlockExercise, exercise: Pick<Exercise, "measure"> | null | undefined): Measure {
  return effectiveBlockExercise(ex, exercise).measure;
}

const viewMemo = new WeakMap<Session, { exercises: ReadonlyArray<Pick<Exercise, "id" | "measure">>; view: Session }>();

/**
 * `session` as it is shown and logged: every accessory exercise through `effectiveBlockExercise`.
 * A completed session is history and shows as saved; the main lift is always counted in reps.
 * Blocks and exercises that don't change are the same objects (the whole session when nothing
 * does), so an edit made on the view can be told apart (`savedAfterEdit`). Memoized per session
 * and exercise list.
 */
export function effectiveSession(session: Session, exercises: ReadonlyArray<Pick<Exercise, "id" | "measure">>): Session {
  if (session.completedAt) return session;
  const memo = viewMemo.get(session);
  if (memo && memo.exercises === exercises) return memo.view;
  let changed = false;
  const blocks = session.blocks.map((b) => {
    if (b.kind !== "accessory") return b;
    const xs = b.exercises.map((e) =>
      effectiveBlockExercise(
        e,
        exercises.find((x) => x.id === e.exerciseId),
      ),
    );
    if (xs.every((e, i) => e === b.exercises[i])) return b;
    changed = true;
    return { ...b, exercises: xs };
  });
  const view = changed ? { ...session, blocks } : session;
  viewMemo.set(session, { exercises, view });
  return view;
}

/**
 * The session to save after an edit made on `view` (`effectiveSession(stored, …)`). An exercise the
 * edit touched (a set logged, edited, added or removed, the exercise skipped) is saved as shown: the
 * effective measure and targets are written into the block in that same save. Every exercise it
 * didn't touch (still the view's own object, wherever the edit moved it) is saved as it was stored,
 * so it keeps following the exercise's measure.
 */
export function savedAfterEdit(edited: Session, view: Session, stored: Session): Session {
  if (view === stored) return edited;
  const blockBack = new Map<Block, Block>();
  const exBack = new Map<BlockExercise, BlockExercise>();
  for (const b of view.blocks) {
    const was = stored.blocks.find((x) => x.id === b.id);
    if (!was || was === b) continue;
    blockBack.set(b, was);
    b.exercises.forEach((e, i) => {
      const s = was.exercises[i];
      if (s && s !== e) exBack.set(e, s);
    });
  }
  let changed = false;
  const blocks = edited.blocks.map((b) => {
    const was = blockBack.get(b);
    if (was) {
      changed = true;
      return was;
    }
    const xs = b.exercises.map((e) => exBack.get(e) ?? e);
    if (xs.every((e, i) => e === b.exercises[i])) return b;
    changed = true;
    return { ...b, exercises: xs };
  });
  return changed ? { ...edited, blocks } : edited;
}
