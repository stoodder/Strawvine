/**
 * Main-lift maths: rep-max estimation, working weights, cycle position and AMRAP
 * progression. All rules come from the (editable) Program settings. See docs/SPEC.md §6.
 */
import { addDays, daysBetween, weekdayOf, type ISODate } from "./dates";
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

export function programDayFor(program: Program, date: ISODate): ProgramDay | null {
  return program.days[String(weekdayOf(date))] ?? null;
}

/** The program day a lift is expected on: a program weekday once the first cycle has started. */
export function scheduledProgramDay(program: Program, date: ISODate): ProgramDay | null {
  return cyclePosition(program, date) ? programDayFor(program, date) : null;
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
