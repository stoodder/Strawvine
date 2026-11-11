/**
 * Calorie & macro recommendations and goal-weight projections. See docs/SPEC.md §4.4.
 */
import { addDays, type ISODate } from "./dates";
import { minCalories } from "./defaults";
import type { Settings } from "./schemas";

export type Direction = "lose" | "gain" | "maintain";

/** Within this many lb of the goal we recommend maintenance. */
export const GOAL_TOLERANCE_LB = 0.5;

/**
 * A cut held at the minimum calorie target with less than this left of its rate (lb/week) is a
 * hold: the rate would print as 0.0, so it *is* 0 — exactly — and every screen reads the same plan
 * (`isOnHold`). A display precision (one decimal of lb/week), not a training rule.
 */
export const HOLD_BELOW_LB_PER_WEEK = 0.05;

export interface Macros {
  proteinG: number;
  carbsG: number;
  fatG: number;
}

export interface Recommendation {
  direction: Direction;
  /**
   * Signed lb/week the target calories are built for. While the minimum holds a cut's target up
   * (`floored`) that is what the minimum leaves of the chosen pace: slower than it, and exactly 0
   * (a hold, `isOnHold`) once what is left would print as 0.0 — under `HOLD_BELOW_LB_PER_WEEK`,
   * which covers a minimum at or above the TDEE.
   */
  rateLbPerWeek: number;
  /** Signed % bodyweight/week actually used (after capping, the approach taper and the minimum). */
  pacePctPerWeek: number;
  /** The chosen pace exceeds the safety limit for this direction (never set while maintaining). */
  paceCapped: boolean;
  tdee: number;
  /** The day's target: what the plan asks for, never below `minCalories`. */
  calories: number;
  /** The minimum is holding the target up: the plan alone asked for less than `minCalories`. */
  floored: boolean;
  /** The minimum calorie target in force, kcal/day (Settings → `limits.minCalories`, see `minCalories()`). */
  minCalories: number;
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
  const paceRate = sign * Math.min((pace / 100) * trendWeight, remainingLb);
  const { kcalPerLb } = settings.nutrition;
  const planned = Math.round((tdee + (paceRate * kcalPerLb) / 7) / 10) * 10;
  // The backstop: being nourished comes before the pace, and before a TDEE estimate that a wild
  // scale reading has dragged down. Whatever the direction, the target never goes under the minimum.
  const floor = minCalories(settings);
  const floored = planned < floor;
  const calories = floored ? floor : planned;
  // A cut held at the minimum is a smaller deficit than the pace asked for: the rate is the one
  // these calories are built for (never a gain, never more than the pace), so nothing downstream
  // measures the week against a pace the target isn't asking for. A floored maintenance or build
  // keeps its rate: the minimum is above the TDEE estimate there, and the app doesn't plan a faster
  // gain on that.
  const rateLbPerWeek = floored && direction === "lose" ? heldCutRate(paceRate, ((calories - tdee) * 7) / kcalPerLb) : paceRate;
  const pacePctPerWeek = trendWeight > 0 ? (rateLbPerWeek / trendWeight) * 100 : 0;
  return {
    direction,
    rateLbPerWeek,
    pacePctPerWeek,
    paceCapped: capped,
    tdee,
    calories,
    floored,
    minCalories: floor,
    macros: macrosFor(calories, trendWeight, settings.nutrition),
  };
}

/**
 * The rate of a cut held at the minimum: what the held calories imply (`impliedRate`), no faster
 * than the pace asked for and never a gain — and 0 when that would print as 0.0, so "on hold" is
 * decided here, once, for every screen.
 */
function heldCutRate(paceRate: number, impliedRate: number): number {
  const rate = Math.min(0, Math.max(paceRate, impliedRate));
  return Math.abs(rate) < HOLD_BELOW_LB_PER_WEEK ? 0 : rate;
}

/**
 * The minimum calorie target leaves a cut no deficit to speak of: the plan is to hold for now
 * (Today's "Cut · on hold"; the check-in judges the week as maintaining). Its rate is exactly 0.
 */
export function isOnHold(rec: Pick<Recommendation, "floored" | "direction" | "rateLbPerWeek">): boolean {
  return rec.floored && rec.direction === "lose" && rec.rateLbPerWeek === 0;
}

export interface ProjectionPoint {
  weeks: number;
  date: ISODate;
}

export interface Projection {
  direction: Direction;
  remainingLb: number;
  /**
   * At the chosen (capped) pace. Null while the minimum calorie target holds the target up: the
   * calories aren't the pace's then, and a date at whatever the minimum leaves of it would read as
   * a forecast (years out, near a hold) rather than a plan.
   */
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
  /** The current recommendation: while it is `floored` there is no date "at pace" (the observed one stays). */
  plan?: Pick<Recommendation, "floored"> | null,
): Projection | null {
  const goal = settings.weightGoal;
  if (!goal) return null;
  const direction = goalDirection(trendWeight, goal.targetLb, goal.startLb);
  const remainingLb = goal.targetLb - trendWeight;
  if (direction === "maintain") {
    return { direction, remainingLb, atPace: null, atLimit: null, observed: null, observedRateLbPerWeek: null, range: null };
  }
  const { pace, limit } = cappedPace(settings, direction, goal.pacePctPerWeek);
  const atPace = plan?.floored ? null : point(today, weeksAtPct(trendWeight, goal.targetLb, pace));
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
 * The smallest overage worth showing, in the bar's own unit (1 g, 1 kcal): the "+N over" note
 * shows the overage rounded to a whole unit, so on a tiny target (4 g of fat, 4.3 g eaten) a
 * fraction of a gram past the tolerance would read "+0g over" on a tinted bar. Below this the bar
 * stays on target.
 */
export const MIN_OVERAGE = 1;

/**
 * How far `eaten` is over `target`, on a 0…1 scale: 0 at or under the target and within the
 * scale's tolerance, rising linearly to 1 at `full` over (and staying 1 beyond). 0 when there is
 * nothing to compare (no entry, or a target ≤ 0), and while the overage rounds to less than
 * `MIN_OVERAGE`.
 */
export function overTargetSeverity(
  eaten: number | null | undefined,
  target: number | null | undefined,
  scale: OverTargetScale = OVER_TARGET_SCALE,
): number {
  if (eaten === null || eaten === undefined || target === null || target === undefined) return 0;
  if (!Number.isFinite(eaten) || !Number.isFinite(target) || target <= 0) return 0;
  if (Math.round(eaten - target) < MIN_OVERAGE) return 0;
  // In grams/kcal rather than ratios, so "exactly 5 % over" isn't nudged past by rounding.
  const excess = eaten - target - target * scale.tolerance;
  if (excess <= 1e-9) return 0;
  const span = target * (scale.full - scale.tolerance);
  return span <= 0 ? 1 : Math.min(1, excess / span);
}

/**
 * The over-target reading of a bar: its severity (`overTargetSeverity`) and the overage to print
 * ("+N over", rounded to a whole unit). `over` is 0 exactly when `severity` is, so a note never
 * shows without a tint, or a tint without a note.
 */
export function overTarget(
  eaten: number | null | undefined,
  target: number | null | undefined,
  scale: OverTargetScale = OVER_TARGET_SCALE,
): { severity: number; over: number } {
  const severity = overTargetSeverity(eaten, target, scale);
  return { severity, over: severity > 0 ? Math.round(eaten! - target!) : 0 };
}

/**
 * What's left of a day's calorie target while the day is still being eaten (Today's Fuel, SPEC
 * §3.1): `left` is the whole kcal still to eat (the full target before anything is logged, never
 * below 0); `over` and `severity` are `overTarget`'s reading, so the day only reads as over past
 * the tolerance — within it, it is simply at 0 left. All zeros without a target.
 */
export function remainingKcal(
  eaten: number | null | undefined,
  target: number | null | undefined,
  scale: OverTargetScale = OVER_TARGET_SCALE,
): { left: number; over: number; severity: number } {
  if (target === null || target === undefined || !Number.isFinite(target) || target <= 0) return { left: 0, over: 0, severity: 0 };
  const had = eaten !== null && eaten !== undefined && Number.isFinite(eaten) ? eaten : 0;
  return { left: Math.max(0, Math.round(target - had)), ...overTarget(eaten, target, scale) };
}
