/**
 * Main-lift maths: rep-max estimation, working weights, cycle position and AMRAP
 * progression, and the plans over time every date is read under. All rules come from the (editable)
 * Program settings. See docs/SPEC.md §6.
 */
import { addDays, daysBetween, formatShortDate, isISODate, startOfWeek, weekdayName, weekdayOf, type ISODate } from "./dates";
import type { MaxEntry, Program, ProgramDay, ProgramWeek, Settings } from "./schemas";

export function roundTo(value: number, increment: number): number {
  if (increment <= 0) return value;
  return Math.round(value / increment) * increment;
}

/**
 * Fraction of the 1RM that can be lifted for `reps` reps, from the program's table.
 * Gaps are linearly interpolated; beyond the table the last slope is extended (floored at 30%).
 */
export function repMaxPct(table: Record<string, number>, reps: number): number {
  const points = Object.entries(table)
    .map(([k, v]) => [Number(k), v] as const)
    .sort((a, b) => a[0] - b[0]);
  if (points.length === 0) return 1;
  const exact = points.find(([r]) => r === reps);
  if (exact) return exact[1];
  if (reps <= points[0]![0]) return points[0]![1];
  for (let i = 1; i < points.length; i++) {
    const [r1, p1] = points[i - 1]!;
    const [r2, p2] = points[i]!;
    if (reps < r2) return p1 + ((p2 - p1) * (reps - r1)) / (r2 - r1);
  }
  const last = points[points.length - 1]!;
  const prev = points[points.length - 2];
  const slope = prev ? (last[1] - prev[1]) / (last[0] - prev[0]) : 0;
  return Math.max(0.3, last[1] + slope * (reps - last[0]));
}

export interface PlannedSet {
  reps: number;
  /** Rep-max the load is based on. */
  basisReps: number;
  repMaxLb: number;
  weightLb: number;
  amrap: boolean;
}

/** Working sets for the main lift in a given program week. */
export function mainLiftSets(program: Program, maxLb: number, week: ProgramWeek, opts: { progressionDay: boolean }): PlannedSet[] {
  return week.reps.map((reps, i) => {
    const basisReps = week.basisReps ?? reps;
    const repMaxLb = maxLb * repMaxPct(program.repMaxPct, basisReps);
    return {
      reps,
      basisReps,
      repMaxLb,
      weightLb: roundTo(repMaxLb * program.intensity, program.roundToLb),
      amrap: program.amrapLastSet && opts.progressionDay && !week.deload && i === week.reps.length - 1,
    };
  });
}


// ---------------------------------------------------------------------------
// Plans over time (SPEC §6.4)
// ---------------------------------------------------------------------------

/** The id of a document's only plan when it has never had another (no `program.planId`). */
export const FIRST_PLAN_ID = "first";

/**
 * A plan on the program's timeline: the weekly lifting plan in force from `start` until `end`.
 * Cycles repeat within a plan; cycle numbers continue from the plans before it.
 */
export interface PlanSpan {
  /** Position on the timeline (plans in order of their starts): 0 is the first plan, the last one is the latest. */
  index: number;
  id: string;
  /** Monday the plan's first cycle begins. */
  start: ISODate;
  /**
   * The first day the plan is no longer in force (null: the latest plan, which runs on): the next
   * plan's start — or, when the next plan was moved later than it was set up to start, the day this
   * plan was set up to end (its stored `end`): the days in between are a pause.
   */
  end: ISODate | null;
  /** The next plan's start (null: the latest plan). From `end` until then nothing is in force. */
  nextStart: ISODate | null;
  name: string;
  weeks: ProgramWeek[];
  days: Record<string, ProgramDay>;
  /** Cycles the plans before this one ran (its first cycle is number `cyclesBefore + 1`). */
  cyclesBefore: number;
  /** Never in force: the next plan starts on the same day (only a merge or an older build could do that). */
  empty: boolean;
}

/** Plans in order of their starts; plans that start on the same day keep their stored order (stable). */
export function byStart<T extends { start: ISODate }>(plans: ReadonlyArray<T>): T[] {
  return [...plans].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

const timelineMemo = new WeakMap<Program, { key: readonly unknown[]; spans: PlanSpan[] }>();

/**
 * The program's plans in time order (`program.earlierPlans` and the top level, the latest, sorted
 * by start — a document stored out of order reads as if it were in order), each with where it ends
 * and the cycles before it. Read every date through this (`planAt`, `cyclePosition`,
 * `scheduledProgramDay`, `planTargets`): a date always reads under the plan that was in force on it.
 *
 * A plan ends where the next one starts, but never later than its stored `end` (the Monday it was
 * set up to end on): moving the next plan's start later leaves a pause in between, with no cycle
 * position — like the days before the first plan's week 1 — instead of lengthening this plan into
 * a cycle nobody trained. Plans that start on the same day: the later stored one is in force, the
 * other is `empty` (never in force, its cycles count 0).
 */
export function planTimeline(program: Program): PlanSpan[] {
  const key = [program.cycleStartDate, program.weeks, program.days, program.name, program.planId, program.earlierPlans];
  const memo = timelineMemo.get(program);
  if (memo && memo.key.every((k, i) => k === key[i])) return memo.spans;
  const earlier = program.earlierPlans ?? [];
  const raw = byStart([
    ...earlier.map((p) => ({ id: p.id, start: p.start, setEnd: p.end ?? null, name: p.name, weeks: p.weeks, days: p.days })),
    { id: program.planId ?? FIRST_PLAN_ID, start: program.cycleStartDate, setEnd: null, name: program.name, weeks: program.weeks, days: program.days },
  ]);
  const spans: PlanSpan[] = [];
  let cycles = 0;
  for (let i = 0; i < raw.length; i++) {
    const { setEnd, ...p } = raw[i]!;
    const nextStart = raw[i + 1]?.start ?? null;
    const empty = nextStart !== null && nextStart <= p.start;
    const end = nextStart !== null && setEnd !== null && setEnd > p.start && setEnd < nextStart ? setEnd : nextStart;
    spans.push({ index: i, ...p, end, nextStart, cyclesBefore: cycles, empty });
    if (!empty && end !== null && p.weeks.length > 0) cycles += Math.ceil(daysBetween(p.start, end) / (p.weeks.length * 7));
  }
  timelineMemo.set(program, { key, spans });
  return spans;
}

/** The latest plan (the document's top level). */
export function latestPlan(program: Program): PlanSpan {
  const spans = planTimeline(program);
  return spans[spans.length - 1]!;
}

/** The plan in force on `date`; null before the first plan starts. */
export function planInForce(program: Program, date: ISODate): PlanSpan | null {
  const spans = planTimeline(program);
  for (let i = spans.length - 1; i >= 0; i--) {
    const s = spans[i]!;
    if (!s.empty && s.start <= date && (s.end === null || date < s.end)) return s;
  }
  return null;
}

/** The plan that comes first in time (what a date before the program reads). */
function firstPlan(program: Program): PlanSpan {
  let first: PlanSpan | null = null;
  for (const s of planTimeline(program)) if (!s.empty && (!first || s.start < first.start)) first = s;
  return first ?? latestPlan(program);
}

/**
 * The plan a date reads: the one in force on it, or — on a day no plan is in force — the next one to
 * start: before the program starts, the first one (its days, targets and schedule are what a day
 * before the first cycle is measured by, as with one plan); in a pause before a later plan (its
 * start moved later than the plan before was set up to end), that plan.
 */
export function planAt(program: Program, date: ISODate): PlanSpan {
  return planInForce(program, date) ?? upcomingPlan(program, date) ?? latestPlan(program);
}

/** The first plan that starts after `date` (and is ever in force). */
function upcomingPlan(program: Program, date: ISODate): PlanSpan | null {
  for (const s of planTimeline(program)) if (!s.empty && s.start > date) return s;
  return null;
}

/** Whether the program has more than one plan. */
const hasPlans = (program: Program) => !!program.earlierPlans?.length;

/** The steps and Zone 2 targets and the metcon / Zone 2 weekdays of one plan. */
export interface PlanTargets {
  steps: number;
  zone2Minutes: number;
  metcon: boolean[];
  zone2: boolean[];
}

const targetsMemo = new WeakMap<object, PlanTargets[]>();

/**
 * The daily targets and weekly schedule `date` is measured by: those of the plan in force on it
 * (before the program: the first plan's). The latest plan's are the settings' own `targets` and
 * `schedule`; an earlier plan carries its own copy.
 */
export function planTargets(settings: Pick<Settings, "program" | "targets" | "schedule">, date: ISODate): PlanTargets {
  if (!hasPlans(settings.program))
    return { steps: settings.targets.steps, zone2Minutes: settings.targets.zone2Minutes, metcon: settings.schedule.metcon, zone2: settings.schedule.zone2 };
  return planTargetsOf(settings, planAt(settings.program, date).index);
}

/** `planTargets` of the plan at `index` on the timeline. */
export function planTargetsOf(settings: Pick<Settings, "program" | "targets" | "schedule">, index: number): PlanTargets {
  let list = targetsMemo.get(settings);
  if (!list) {
    // In the timeline's order (`planTimeline`: by start, stable).
    list = byStart([
      ...(settings.program.earlierPlans ?? []).map((p) => ({ start: p.start, ...p.targets, ...p.schedule })),
      { start: settings.program.cycleStartDate, ...settings.targets, ...settings.schedule },
    ]).map(({ start: _s, ...t }) => t);
    targetsMemo.set(settings, list);
  }
  return list[index] ?? list[list.length - 1]!;
}

export interface CyclePosition {
  /** 1-based cycle number (continuing across plans). */
  cycle: number;
  /** 0-based index into the plan's weeks. */
  weekIndex: number;
  week: ProgramWeek;
  /** First and last day of this program week. */
  weekStart: ISODate;
  weekEnd: ISODate;
  /** First day of the current cycle. */
  cycleStart: ISODate;
  /** Last day of the current cycle (the day before the next plan starts, when that cuts it short). */
  cycleEnd: ISODate;
  /** The plan in force. */
  plan: PlanSpan;
  /** The plan's cycle length in weeks (`plan.weeks.length`): "Week 2 of 5". */
  weeksCount: number;
}

export function cyclePosition(program: Program, date: ISODate): CyclePosition | null {
  const plan = planInForce(program, date);
  if (!plan) return null;
  const n = plan.weeks.length;
  if (n === 0) return null;
  const offset = daysBetween(plan.start, date);
  const absoluteWeek = Math.floor(offset / 7);
  const weekIndex = absoluteWeek % n;
  const inPlan = Math.floor(absoluteWeek / n);
  const weekStart = addDays(plan.start, absoluteWeek * 7);
  const cycleStart = addDays(plan.start, inPlan * n * 7);
  const last = plan.end === null ? null : addDays(plan.end, -1);
  const clip = (d: ISODate) => (last !== null && last < d ? last : d);
  return {
    cycle: plan.cyclesBefore + inPlan + 1,
    weekIndex,
    week: plan.weeks[weekIndex]!,
    weekStart,
    weekEnd: clip(addDays(weekStart, 6)),
    cycleStart,
    cycleEnd: clip(addDays(cycleStart, n * 7 - 1)),
    plan,
    weeksCount: n,
  };
}

/**
 * Where a day sits in the program, in words: "Week 2 of 5", "Deload week", and from the second
 * cycle on "Cycle 2 · Week 2 of 5". `weeksCount` is the cycle's length (`pos.weeksCount`).
 * `short` drops the cycle length and the word after Deload ("Week 2", "Deload") for tight spots.
 */
export function cycleLabel(
  pos: Pick<CyclePosition, "cycle" | "weekIndex" | "week">,
  weeksCount: number,
  opts: { short?: boolean } = {},
): string {
  const n = pos.weekIndex + 1;
  const week = pos.week.deload
    ? opts.short
      ? "Deload"
      : "Deload week"
    : opts.short || weeksCount < n
      ? `Week ${n}`
      : `Week ${n} of ${weeksCount}`;
  return pos.cycle > 1 ? `Cycle ${pos.cycle} · ${week}` : week;
}

/** The program day of `date`'s weekday in the plan the date reads (`planAt`), started or not. */
export function programDayFor(program: Program, date: ISODate): ProgramDay | null {
  const days = hasPlans(program) ? planAt(program, date).days : program.days;
  return days[String(weekdayOf(date))] ?? null;
}

/**
 * The program day a lift is expected on: a program weekday of the plan in force, once the first
 * cycle has started. (Equivalent to `cyclePosition(program, date) ? programDayFor(program, date) :
 * null`, without building the position — it runs for every day on every derive.)
 */
export function scheduledProgramDay(program: Program, date: ISODate): ProgramDay | null {
  if (!hasPlans(program)) {
    if (program.weeks.length === 0 || daysBetween(program.cycleStartDate, date) < 0) return null;
    return program.days[String(weekdayOf(date))] ?? null;
  }
  const plan = planInForce(program, date);
  if (!plan || plan.weeks.length === 0) return null;
  return plan.days[String(weekdayOf(date))] ?? null;
}

/** Program weeks run Monday–Sunday: a cycle start snaps to the Monday on or before the date. */
export function snapCycleStart(date: ISODate): ISODate {
  return startOfWeek(date);
}

/**
 * The plan a move of the start moves, seen from `today`: the plan `today` reads (`planAt`: the one
 * in force; before the program the first; in a pause the one that starts after it); without
 * `today`, the first. It moves together with every plan after it; the plans before it stay.
 */
export function movingPlan(program: Program, today?: ISODate): PlanSpan {
  return today !== undefined ? planAt(program, today) : firstPlan(program);
}

/**
 * A program whose plan `from` (by timeline index) and every later plan start `days` days later
 * (their stored ends with them). The plan before keeps where it ends: its `end` is written down
 * when it wasn't yet, so a later start leaves a pause after it rather than more of it, and a move
 * back closes the pause again.
 */
function movePlansFrom(program: Program, from: number, days: number): Program {
  const move = (d: ISODate) => snapCycleStart(addDays(snapCycleStart(d), days));
  const spans = planTimeline(program);
  const moving = new Set(spans.filter((s) => s.index >= from).map((s) => s.id));
  let before: PlanSpan | null = null;
  for (const s of spans) if (s.index < from && !s.empty) before = s;
  const earlier = program.earlierPlans?.map((p) => {
    if (moving.has(p.id)) return { ...p, start: move(p.start), ...(p.end ? { end: move(p.end) } : {}) };
    if (before && p.id === before.id && !p.end && before.end) return { ...p, end: before.end };
    return p;
  });
  const topMoves = moving.has(program.planId ?? FIRST_PLAN_ID);
  return {
    ...program,
    ...(topMoves ? { cycleStartDate: move(program.cycleStartDate) } : {}),
    ...(earlier ? { earlierPlans: earlier } : {}),
  };
}

/**
 * Why the start can't move `weeks` whole weeks (seen from `today`), or null when it can: it would
 * leave the calendar, or put the moving plan's start on or before the start of the plan before it
 * (which doesn't move).
 */
export function shiftRefusal(program: Program, weeks: number, today?: ISODate): string | null {
  return moveStartTo(program, movingPlan(program, today), Math.trunc(weeks) * 7).refused;
}

function moveStartTo(program: Program, plan: PlanSpan, days: number): { program: Program; refused: string | null } {
  const to = snapCycleStart(addDays(snapCycleStart(plan.start), days));
  if (!isISODate(to)) return { program, refused: "The program can't move any further." };
  const spans = planTimeline(program);
  let before: PlanSpan | null = null;
  for (const s of spans) if (s.index < plan.index && !s.empty && (!before || s.start > before.start)) before = s;
  if (before && to <= before.start)
    return {
      program,
      refused: `This cycle can't start before the plan before it, which began ${weekdayName(before.start, true)} ${formatShortDate(before.start)}.`,
    };
  return { program: movePlansFrom(program, plan.index, daysBetween(snapCycleStart(plan.start), to)), refused: null };
}

/**
 * The program moved by whole weeks: the plan in force on `today` (before the program: the first
 * plan; without `today`: the first plan) starts `weeks` later (negative: earlier), on a Monday, and
 * every later plan moves with it — an earlier plan's start never moves. Every week of every cycle
 * from that plan on moves with it: a week later, the current week becomes the one before it (or
 * the wait before week 1, or a week of the plan before). Unchanged when the move is refused
 * (`shiftRefusal`).
 */
export function shiftCycleStart(program: Program, weeks: number, today?: ISODate): Program {
  return moveStartTo(program, movingPlan(program, today), Math.trunc(weeks) * 7).program;
}

/**
 * The plan in force on `today` (see `movingPlan`) starting on the Monday of `to`'s week, every
 * later plan moving by as much; or why it can't.
 */
export function moveCycleStart(program: Program, to: ISODate, today?: ISODate): { program: Program; refused: string | null } {
  return movePlanStart(program, movingPlan(program, today).id, to);
}

/**
 * The plan `id` starting on the Monday of `to`'s week, every later plan moving by as much (an
 * Undo of a move: the plan is found by id, wherever it is by then); or why it can't. Unchanged
 * (refused) when there is no such plan.
 */
export function movePlanStart(program: Program, id: string, to: ISODate): { program: Program; refused: string | null } {
  const plan = planTimeline(program).find((s) => s.id === id);
  if (!plan) return { program, refused: "That cycle isn't there any more." };
  return moveStartTo(program, plan, daysBetween(snapCycleStart(plan.start), snapCycleStart(to)));
}

export interface CycleShiftPreview {
  /** The program after the shift (the same object when it is refused). */
  program: Program;
  /** Why the shift can't be made, or null. */
  refused: string | null;
  /** The moving plan's start before and after the shift (`movingPlan`). */
  from: ISODate;
  to: ISODate;
  /** Where `date` sits before the shift; null before the first cycle. */
  before: CyclePosition | null;
  /** Where `date` sits afterwards; null when the first cycle would only start after it. */
  position: CyclePosition | null;
  /** The first lifting day on or after `date` under the shifted program (null without lifting days). */
  next: { date: ISODate; day: ProgramDay; position: CyclePosition } | null;
  /**
   * The calendar week after `date`'s, under the shifted program: its Monday, where that sits
   * (null when the first cycle starts later still) and its first lifting day (null without one).
   */
  nextWeek: { start: ISODate; position: CyclePosition | null; first: { date: ISODate; day: ProgramDay } | null };
}

/** The first lifting day of the program in the `days` days from `from` on. */
function firstLiftingDay(program: Program, from: ISODate, days: number): { date: ISODate; day: ProgramDay } | null {
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    const day = scheduledProgramDay(program, date);
    if (day) return { date, day };
  }
  return null;
}

/** What `shiftCycleStart(program, weeks, date)` would mean on `date` (today), before doing it. */
export function previewCycleShift(program: Program, weeks: number, date: ISODate): CycleShiftPreview {
  const plan = movingPlan(program, date);
  const { program: shifted, refused } = moveStartTo(program, plan, Math.trunc(weeks) * 7);
  // On a day nothing is in force (before the program, a pause) look from the next plan's start on.
  const from = planInForce(shifted, date) ? date : planAt(shifted, date).start;
  const first = firstLiftingDay(shifted, from, 7);
  const position = first && cyclePosition(shifted, first.date);
  const start = addDays(startOfWeek(date), 7);
  return {
    program: shifted,
    refused,
    from: plan.start,
    to: planTimeline(shifted).find((s) => s.id === plan.id)?.start ?? plan.start,
    before: cyclePosition(program, date),
    position: cyclePosition(shifted, date),
    next: first && position ? { ...first, position } : null,
    nextWeek: { start, position: cyclePosition(shifted, start), first: firstLiftingDay(shifted, start, 7) },
  };
}

/** Max increase earned on an AMRAP set (0 when the target wasn't beaten). */
export function progressionGain(program: Program, targetReps: number, actualReps: number): number {
  if (!program.progression.enabled) return 0;
  return Math.max(0, actualReps - targetReps) * program.progression.lbPerExtraRep;
}

/** The latest recorded max for an exercise, optionally as of a date. */
export function currentMax(entries: ReadonlyArray<MaxEntry>, exerciseId: number, asOf?: ISODate): MaxEntry | null {
  let best: MaxEntry | null = null;
  for (const e of entries) {
    if (e.exerciseId !== exerciseId) continue;
    if (asOf && e.date > asOf) continue;
    if (!best || e.date > best.date || (e.date === best.date && e.createdAt > best.createdAt)) best = e;
  }
  return best;
}

/** Plates per side for a target weight. */
export function platesPerSide(
  totalLb: number,
  barLb = 45,
  plates: number[] = [45, 35, 25, 10, 5, 2.5],
): { plates: number[]; remainder: number } {
  let side = (totalLb - barLb) / 2;
  const out: number[] = [];
  if (side <= 0) return { plates: out, remainder: 0 };
  for (const p of plates) {
    while (side >= p - 1e-9) {
      out.push(p);
      side -= p;
    }
  }
  return { plates: out, remainder: Math.round(side * 100) / 100 };
}
