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
  /** Signed % bodyweight/week actually used (after capping and the approach taper). */
  pacePctPerWeek: number;
  /** The chosen pace exceeds the safety limit for this direction (never set while maintaining). */
  paceCapped: boolean;
  tdee: number;
  calories: number;
  macros: Macros;
}

/** Which way `weightLb` has to move to reach `targetLb` ("maintain" within the tolerance). */
function towardTarget(weightLb: number, targetLb: number): Direction {
  const diff = targetLb - weightLb;
  if (Math.abs(diff) < GOAL_TOLERANCE_LB) return "maintain";
  return diff < 0 ? "lose" : "gain";
}

/**
 * The phase to plan for at `trendWeight`. A goal set away from its target (`startLb`) is a cut
 * or a build for its whole life: once the trend reaches or passes the target it settles into
 * maintenance instead of flipping into the opposite phase. Without `startLb` (goals created
 * before it was recorded), or for a goal set at its target, the direction follows the trend.
 */
export function goalDirection(trendWeight: number, targetLb: number | null | undefined, startLb?: number | null): Direction {
  if (targetLb === null || targetLb === undefined) return "maintain";
  const toward = towardTarget(trendWeight, targetLb);
  const intended = startLb === null || startLb === undefined ? "maintain" : towardTarget(startLb, targetLb);
  return intended === "maintain" || toward === intended ? toward : "maintain";
}

/** Pace (absolute % bodyweight/week) after applying the safety limits. */
export function cappedPace(settings: Pick<Settings, "limits">, direction: Direction, pacePct: number) {
  const limit = direction === "lose" ? settings.limits.maxLossPctPerWeek : direction === "gain" ? settings.limits.maxGainPctPerWeek : 0;
  const chosen = Math.abs(pacePct);
  return { pace: Math.min(chosen, limit), capped: direction !== "maintain" && chosen > limit, limit };
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
  const direction = goalDirection(trendWeight, goal?.targetLb, goal?.startLb);
  const { pace, capped } = cappedPace(settings, direction, goal?.pacePctPerWeek ?? 0);
  const sign = direction === "lose" ? -1 : direction === "gain" ? 1 : 0;
  // Taper: never plan a week's change larger than what is left to go, so the target eases into
  // maintenance near the goal instead of jumping from full pace to zero.
  const remainingLb = goal ? Math.abs(goal.targetLb - trendWeight) : 0;
  const rateLbPerWeek = sign * Math.min((pace / 100) * trendWeight, remainingLb);
  const pacePctPerWeek = trendWeight > 0 ? (rateLbPerWeek / trendWeight) * 100 : 0;
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
  const direction = goalDirection(trendWeight, goal.targetLb, goal.startLb);
  const remainingLb = goal.targetLb - trendWeight;
  if (direction === "maintain") {
    return { direction, remainingLb, atPace: null, atLimit: null, observed: null, observedRateLbPerWeek: null, range: null };
  }
  const { pace, limit } = cappedPace(settings, direction, goal.pacePctPerWeek);
  const atPace = point(today, weeksAtPct(trendWeight, goal.targetLb, pace));
  const atLimit = point(today, weeksAtPct(trendWeight, goal.targetLb, limit));

  const observedRateLbPerWeek = weekAgoTrendWeight === null ? null : trendWeight - weekAgoTrendWeight;
  const rightWay =
    observedRateLbPerWeek !== null && Math.abs(observedRateLbPerWeek) > 0.05 && Math.sign(observedRateLbPerWeek) === Math.sign(remainingLb);
  const observed = rightWay ? point(today, Math.abs(remainingLb) / Math.abs(observedRateLbPerWeek!)) : null;

  const dates = [atPace, observed]
    .filter((p): p is ProjectionPoint => p !== null)
    .map((p) => p.date)
    .sort();
  const range: [ISODate, ISODate] | null = dates.length ? [dates[0]!, dates[dates.length - 1]!] : null;
  return { direction, remainingLb, atPace, atLimit, observed, observedRateLbPerWeek, range };
}

// ---------------------------------------------------------------------------
// Over-target colour scale (Today's calorie and macro bars, SPEC §3.1)
// ---------------------------------------------------------------------------

/**
 * How far over a target counts as "over", and how far over is as bad as it gets. Both are
 * fractions of the target: `tolerance` 0.05 = up to 5 % over still reads as on target; `full`
 * 0.25 = 25 % over is the end of the scale. A display tolerance (how the bars are tinted), not a
 * training rule, so it lives here as named constants rather than in Settings.
 */
export interface OverTargetScale {
  tolerance: number;
  full: number;
}

/** Calories, carbs and fat: on target within 5 %, fully over at 25 %. */
export const OVER_TARGET_SCALE: OverTargetScale = { tolerance: 0.05, full: 0.25 };

/**
 * Protein is a floor for an athlete more than a ceiling — going over costs nothing but the calories
 * (which the calorie bar already shows) — so its scale is wider: on target within 25 % over,
 * fully over at 75 % (e.g. 350 g on a 200 g target).
 */
export const PROTEIN_OVER_TARGET_SCALE: OverTargetScale = { tolerance: 0.25, full: 0.75 };

/**
 * How far `eaten` is over `target`, on a 0…1 scale: 0 at or under the target and within the
 * scale's tolerance, rising linearly to 1 at `full` over (and staying 1 beyond). 0 when there is
 * nothing to compare (no entry, or a target ≤ 0).
 */
export function overTargetSeverity(
  eaten: number | null | undefined,
  target: number | null | undefined,
  scale: OverTargetScale = OVER_TARGET_SCALE,
): number {
  if (eaten === null || eaten === undefined || target === null || target === undefined) return 0;
  if (!Number.isFinite(eaten) || !Number.isFinite(target) || target <= 0) return 0;
  // In grams/kcal rather than ratios, so "exactly 5 % over" isn't nudged past by rounding.
  const excess = eaten - target - target * scale.tolerance;
  if (excess <= 1e-9) return 0;
  const span = target * (scale.full - scale.tolerance);
  return span <= 0 ? 1 : Math.min(1, excess / span);
}
