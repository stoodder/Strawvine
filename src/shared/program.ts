/**
 * Main-lift maths: rep-max estimation, working weights, cycle position and AMRAP
 * progression. All rules come from the (editable) Program settings. See docs/SPEC.md §6.
 */
import { addDays, daysBetween, isISODate, startOfWeek, weekdayOf, type ISODate } from "./dates";
import type { MaxEntry, Program, ProgramDay, ProgramWeek } from "./schemas";

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

export interface CyclePosition {
  /** 1-based cycle number. */
  cycle: number;
  /** 0-based index into program.weeks. */
  weekIndex: number;
  week: ProgramWeek;
  /** First and last day of this program week. */
  weekStart: ISODate;
  weekEnd: ISODate;
  /** Last day of the current cycle. */
  cycleEnd: ISODate;
}

export function cyclePosition(program: Program, date: ISODate): CyclePosition | null {
  const offset = daysBetween(program.cycleStartDate, date);
  if (offset < 0 || program.weeks.length === 0) return null;
  const absoluteWeek = Math.floor(offset / 7);
  const weekIndex = absoluteWeek % program.weeks.length;
  const cycle = Math.floor(absoluteWeek / program.weeks.length) + 1;
  const weekStart = addDays(program.cycleStartDate, absoluteWeek * 7);
  const cycleStart = addDays(program.cycleStartDate, (cycle - 1) * program.weeks.length * 7);
  return {
    cycle,
    weekIndex,
    week: program.weeks[weekIndex]!,
    weekStart,
    weekEnd: addDays(weekStart, 6),
    cycleEnd: addDays(cycleStart, program.weeks.length * 7 - 1),
  };
}

/**
 * Where a day sits in the program, in words: "Week 2 of 5", "Deload week", and from the second
 * cycle on "Cycle 2 · Week 2 of 5". `weeksCount` is the cycle's length (`program.weeks.length`).
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

export function programDayFor(program: Program, date: ISODate): ProgramDay | null {
  return program.days[String(weekdayOf(date))] ?? null;
}

/**
 * The program day a lift is expected on: a program weekday once the first cycle has started.
 * (Equivalent to `cyclePosition(program, date) ? programDayFor(program, date) : null`, without
 * building the position — it runs for every day on every derive.)
 */
export function scheduledProgramDay(program: Program, date: ISODate): ProgramDay | null {
  if (program.weeks.length === 0 || daysBetween(program.cycleStartDate, date) < 0) return null;
  return programDayFor(program, date);
}

/** Program weeks run Monday–Sunday: a cycle start snaps to the Monday on or before the date. */
export function snapCycleStart(date: ISODate): ISODate {
  return startOfWeek(date);
}

/**
 * The program moved by whole weeks: the first cycle starts `weeks` later (negative: earlier), on
 * a Monday. Every week of every cycle moves with it — a week later, the current week becomes the
 * one before it (or the wait before week 1). Unchanged when the move would leave the calendar.
 */
export function shiftCycleStart(program: Program, weeks: number): Program {
  const cycleStartDate = snapCycleStart(addDays(snapCycleStart(program.cycleStartDate), Math.trunc(weeks) * 7));
  return isISODate(cycleStartDate) ? { ...program, cycleStartDate } : program;
}

export interface CycleShiftPreview {
  /** The program after the shift. */
  program: Program;
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

/** What `shiftCycleStart(program, weeks)` would mean on `date` (today), before doing it. */
export function previewCycleShift(program: Program, weeks: number, date: ISODate): CycleShiftPreview {
  const shifted = shiftCycleStart(program, weeks);
  // Before the (shifted) start nothing is scheduled: look from the start on.
  const from = daysBetween(shifted.cycleStartDate, date) < 0 ? shifted.cycleStartDate : date;
  const first = firstLiftingDay(shifted, from, 7);
  const position = first && cyclePosition(shifted, first.date);
  const start = addDays(startOfWeek(date), 7);
  return {
    program: shifted,
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
