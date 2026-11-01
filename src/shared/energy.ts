/**
 * The energy engine: descending-weighted 7-day averages of calories and bodyweight, a daily
 * TDEE derived from them, and a smoothed TDEE. See docs/SPEC.md §4.
 *
 * Everything is recomputed from raw day logs — nothing derived is ever stored.
 */
import { addDays, type ISODate } from "./dates";
import type { DayLog } from "./schemas";

/** Weights for T0 (today) … T6 (six days ago). They sum to 25. */
export const AVG_WEIGHTS = [5, 5, 5, 4, 3, 2, 1] as const;

export const DEFAULT_KCAL_PER_LB = 3500;

/** Logged days needed before the smoothed TDEE is considered fully calibrated. */
export const CALIBRATION_DAYS = 14;

/**
 * Weighted average of a 7-slot window where index 0 is the most recent day. Missing slots
 * (`null`) are skipped and their weight is removed from the divisor.
 */
export function weightedAverage(window: ReadonlyArray<number | null | undefined>): number | null {
  let sum = 0;
  let divisor = 0;
  for (let i = 0; i < AVG_WEIGHTS.length; i++) {
    const v = window[i];
    if (v === null || v === undefined || Number.isNaN(v)) continue;
    sum += v * AVG_WEIGHTS[i]!;
    divisor += AVG_WEIGHTS[i]!;
  }
  return divisor === 0 ? null : sum / divisor;
}

/** A day counts toward the engine only when it has both a weight and a calorie entry. */
export function isLogged(day: Pick<DayLog, "weightLb" | "calories"> | undefined): boolean {
  return !!day && day.weightLb !== null && day.calories !== null;
}

export interface EnergyDay {
  date: ISODate;
  logged: boolean;
  weightLb: number | null;
  calories: number | null;
  avgWeight: number | null;
  avgCalories: number | null;
  /** Daily TDEE estimate (null unless this day is logged and both weight averages exist). */
  tdee: number | null;
  /** Weighted average of the last 7 daily TDEE values. */
  avgTdee: number | null;
  /** Total logged days on or before this date (drives calibration). */
  loggedCount: number;
}

/**
 * Compute the engine for every date in [from, to]. Earlier history is read automatically so
 * the first days of the range have full windows.
 */
export function computeEnergySeries(
  days: ReadonlyArray<Pick<DayLog, "date" | "weightLb" | "calories">>,
  from: ISODate,
  to: ISODate,
  kcalPerLb: number = DEFAULT_KCAL_PER_LB,
): EnergyDay[] {
  const byDate = new Map<ISODate, Pick<DayLog, "date" | "weightLb" | "calories">>();
  for (const d of days) byDate.set(d.date, d);

  // Start far enough back that the first TDEE window in range is complete. Averages read
  // their own 7-day windows directly from `byDate`, so only the TDEE history needs warming.
  const start = addDays(from, -7);
  let loggedBefore = [...byDate.values()].filter((d) => isLogged(d) && d.date < start).length;

  const logged = (date: ISODate) => {
    const d = byDate.get(date);
    return isLogged(d) ? d! : undefined;
  };
  const avgOf = (date: ISODate, key: "weightLb" | "calories") =>
    weightedAverage(AVG_WEIGHTS.map((_, i) => logged(addDays(date, -i))?.[key] ?? null));

  const tdeeByDate = new Map<ISODate, number | null>();
  const out: EnergyDay[] = [];

  for (let date = start; date <= to; date = addDays(date, 1)) {
    const today = logged(date);
    if (today) loggedBefore++;
    const avgWeight = avgOf(date, "weightLb");
    const avgCalories = avgOf(date, "calories");
    const prevAvgWeight = avgOf(addDays(date, -1), "weightLb");

    const tdee =
      today && avgWeight !== null && prevAvgWeight !== null && avgCalories !== null
        ? avgCalories - (avgWeight - prevAvgWeight) * kcalPerLb
        : null;
    tdeeByDate.set(date, tdee);

    const avgTdee = weightedAverage(AVG_WEIGHTS.map((_, i) => tdeeByDate.get(addDays(date, -i)) ?? null));

    if (date >= from) {
      const raw = byDate.get(date);
      out.push({
        date,
        logged: !!today,
        weightLb: raw?.weightLb ?? null,
        calories: raw?.calories ?? null,
        avgWeight,
        avgCalories,
        tdee,
        avgTdee,
        loggedCount: loggedBefore,
      });
    }
  }
  return out;
}

export interface EffectiveTdee {
  /** The maintenance value recommendations are built on. */
  value: number;
  /** Measured smoothed TDEE (may be null early on). */
  measured: number | null;
  /** Starting estimate blended in during calibration. */
  prior: number;
  /** 0…1 — share of the value coming from measurement. */
  confidence: number;
  provisional: boolean;
}

/**
 * During calibration the measured TDEE is noisy (one day's water swing moves it by
 * thousands of kcal), so it is blended with a starting estimate in proportion to how many
 * days have been logged. After CALIBRATION_DAYS it is purely measured.
 */
export function effectiveTdee(
  day: Pick<EnergyDay, "avgTdee" | "avgWeight" | "loggedCount">,
  initialEstimate: number | null,
): EffectiveTdee | null {
  const prior = initialEstimate ?? (day.avgWeight !== null ? Math.round(day.avgWeight * 15) : null);
  if (prior === null && day.avgTdee === null) return null;
  const confidence = day.avgTdee === null ? 0 : Math.min(1, day.loggedCount / CALIBRATION_DAYS);
  const measured = day.avgTdee;
  const value =
    measured === null ? prior! : prior === null ? measured : confidence * measured + (1 - confidence) * prior;
  return { value, measured, prior: prior ?? measured!, confidence, provisional: confidence < 1 };
}
