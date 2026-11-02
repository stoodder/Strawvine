/**
 * Daily steps and their trend: the same descending weighted 7-day average as bodyweight
 * (docs/SPEC.md §4.1, `weightedAverage`), applied to each day's step count.
 *
 * Recomputed from raw day logs; nothing here is stored.
 */
import { addDays, toDayNumber, type ISODate } from "./dates";
import { AVG_WEIGHTS, weightedAverage } from "./energy";
import type { DayLog } from "./schemas";

export interface StepsDay {
  date: ISODate;
  /** The day's logged count (null when not logged). */
  steps: number | null;
  /** Weighted 7-day average of the counts ending this day (null when none of them is logged). */
  avgSteps: number | null;
}

/**
 * Every date in [from, to] with its count and trend. Days without a count are skipped in each
 * window (their weight leaves the divisor), like unlogged days in the energy engine. `today` is
 * still in progress, so its partial count is shown but feeds no average: the trend ends the day
 * before (pass `null` to treat every day as complete).
 */
export function computeStepsSeries(
  days: ReadonlyArray<Pick<DayLog, "date" | "steps">>,
  from: ISODate,
  to: ISODate,
  today: ISODate | null,
): StepsDay[] {
  if (to < from) return [];
  const byDate = new Map<ISODate, number>();
  for (const d of days) if (d.steps !== null && d.steps !== undefined) byDate.set(d.date, d.steps);
  const complete = (date: ISODate) => (today !== null && date >= today ? null : (byDate.get(date) ?? null));

  const out: StepsDay[] = [];
  const n = toDayNumber(to) - toDayNumber(from) + 1;
  // The window ending the day before `from`, oldest first; shifted along one day at a time.
  const window: Array<number | null> = [];
  for (let k = AVG_WEIGHTS.length - 1; k >= 1; k--) window.push(complete(addDays(from, -k)));
  for (let i = 0; i < n; i++) {
    const date = addDays(from, i);
    window.push(complete(date));
    if (window.length > AVG_WEIGHTS.length) window.shift();
    const inProgress = today !== null && date >= today;
    out.push({
      date,
      steps: byDate.get(date) ?? null,
      // `weightedAverage` wants the most recent day first.
      avgSteps: inProgress ? null : weightedAverage([...window].reverse()),
    });
  }
  return out;
}
