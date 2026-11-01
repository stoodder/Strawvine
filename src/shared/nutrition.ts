/**
 * Calorie & macro recommendations and goal-weight projections. See docs/SPEC.md §4.4.
 */
import { addDays, type ISODate } from "./dates";
import type { Settings } from "./schemas";

export type Direction = "lose" | "gain" | "maintain";

/** Within this many lb of the goal we recommend maintenance. */
export const GOAL_TOLERANCE_LB = 0.5;

export interface Macros {
  proteinG: number;
  carbsG: number;
  fatG: number;
}

export interface Recommendation {
  direction: Direction;
  /** Signed lb/week the target calories are built for. */
  rateLbPerWeek: number;
  /** Signed % bodyweight/week actually used (after capping). */
  pacePctPerWeek: number;
  paceCapped: boolean;
  tdee: number;
  calories: number;
  macros: Macros;
}

export function goalDirection(trendWeight: number, targetLb: number | null | undefined): Direction {
  if (targetLb === null || targetLb === undefined) return "maintain";
  const diff = targetLb - trendWeight;
  if (Math.abs(diff) < GOAL_TOLERANCE_LB) return "maintain";
  return diff < 0 ? "lose" : "gain";
}

/** Pace (absolute % bodyweight/week) after applying the safety limits. */
export function cappedPace(settings: Pick<Settings, "limits">, direction: Direction, pacePct: number) {
  const limit =
    direction === "lose" ? settings.limits.maxLossPctPerWeek : direction === "gain" ? settings.limits.maxGainPctPerWeek : 0;
  return { pace: Math.min(Math.abs(pacePct), limit), capped: Math.abs(pacePct) > limit, limit };
}

export function macrosFor(calories: number, bodyweightLb: number, nutrition: Settings["nutrition"]): Macros {
  const proteinG = Math.round(nutrition.proteinGPerLb * bodyweightLb);
  const fatG = Math.round(nutrition.fatGPerLb * bodyweightLb);
  const carbsG = Math.max(0, Math.round((calories - proteinG * 4 - fatG * 9) / 4));
  return { proteinG, carbsG, fatG };
}

export function recommend(
  settings: Pick<Settings, "limits" | "nutrition" | "weightGoal">,
  tdee: number,
  trendWeight: number,
): Recommendation {
  const goal = settings.weightGoal;
  const direction = goalDirection(trendWeight, goal?.targetLb);
  const { pace, capped } = cappedPace(settings, direction, goal?.pacePctPerWeek ?? 0);
  const sign = direction === "lose" ? -1 : direction === "gain" ? 1 : 0;
  const pacePctPerWeek = sign * pace;
  const rateLbPerWeek = (pacePctPerWeek / 100) * trendWeight;
  const calories = Math.round((tdee + (rateLbPerWeek * settings.nutrition.kcalPerLb) / 7) / 10) * 10;
  return {
    direction,
    rateLbPerWeek,
    pacePctPerWeek,
    paceCapped: capped,
    tdee,
    calories,
    macros: macrosFor(calories, trendWeight, settings.nutrition),
  };
}

export interface ProjectionPoint {
  weeks: number;
  date: ISODate;
}

export interface Projection {
  direction: Direction;
  remainingLb: number;
  /** At the chosen (capped) pace. */
  atPace: ProjectionPoint | null;
  /** At the fastest pace the limits allow. */
  atLimit: ProjectionPoint | null;
  /** At the rate the trend has actually moved over the last week (null if wrong way / flat / unknown). */
  observed: ProjectionPoint | null;
  observedRateLbPerWeek: number | null;
  /** Earliest → latest of the meaningful projections. */
  range: [ISODate, ISODate] | null;
}

/** Weeks to go from `from` to `to` changing by `pct`% of current bodyweight per week (compounding). */
export function weeksAtPct(from: number, to: number, pct: number): number | null {
  if (pct <= 0 || from <= 0 || to <= 0) return null;
  const r = pct / 100;
  const factor = to < from ? 1 - r : 1 + r;
  if (factor <= 0) return null;
  return Math.log(to / from) / Math.log(factor);
}

function point(today: ISODate, weeks: number | null): ProjectionPoint | null {
  if (weeks === null || !Number.isFinite(weeks) || weeks < 0 || weeks > 520) return null;
  return { weeks, date: addDays(today, Math.ceil(weeks * 7)) };
}

export function project(
  settings: Pick<Settings, "limits" | "weightGoal">,
  today: ISODate,
  trendWeight: number,
  weekAgoTrendWeight: number | null,
): Projection | null {
  const goal = settings.weightGoal;
  if (!goal) return null;
  const direction = goalDirection(trendWeight, goal.targetLb);
  const remainingLb = goal.targetLb - trendWeight;
  if (direction === "maintain") {
    return { direction, remainingLb, atPace: null, atLimit: null, observed: null, observedRateLbPerWeek: null, range: null };
  }
  const { pace, limit } = cappedPace(settings, direction, goal.pacePctPerWeek);
  const atPace = point(today, weeksAtPct(trendWeight, goal.targetLb, pace));
  const atLimit = point(today, weeksAtPct(trendWeight, goal.targetLb, limit));

  const observedRateLbPerWeek = weekAgoTrendWeight === null ? null : trendWeight - weekAgoTrendWeight;
  const rightWay =
    observedRateLbPerWeek !== null &&
    Math.abs(observedRateLbPerWeek) > 0.05 &&
    Math.sign(observedRateLbPerWeek) === Math.sign(remainingLb);
  const observed = rightWay ? point(today, Math.abs(remainingLb) / Math.abs(observedRateLbPerWeek!)) : null;

  const dates = [atPace, observed].filter((p): p is ProjectionPoint => p !== null).map((p) => p.date).sort();
  const range: [ISODate, ISODate] | null = dates.length ? [dates[0]!, dates[dates.length - 1]!] : null;
  return { direction, remainingLb, atPace, atLimit, observed, observedRateLbPerWeek, range };
}
