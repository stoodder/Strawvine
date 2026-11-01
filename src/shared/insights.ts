/**
 * The derived "model" the UI renders: today's targets, the weekly check-in, projections and
 * rule-based insights.
 */
import { addDays, dateRange, weekdayOf, type ISODate } from "./dates";
import { computeEnergySeries, effectiveTdee, type EffectiveTdee, type EnergyDay } from "./energy";
import { type AppData } from "./gamify";
import { project, recommend, type Projection, type Recommendation } from "./nutrition";
import { scheduledProgramDay } from "./program";
import type { DayLog } from "./schemas";

export interface DayTargets {
  /** The engine state the targets were built from (the previous day — today is still in progress). */
  basis: EnergyDay | null;
  tdee: EffectiveTdee | null;
  recommendation: Recommendation | null;
}

/**
 * Targets for `date` are built from the engine as of the day before, so they don't drift
 * while the day's food is still being logged.
 */
export function targetsFor(date: ISODate, series: ReadonlyArray<EnergyDay>, data: AppData): DayTargets {
  const basis = series.find((d) => d.date === addDays(date, -1)) ?? null;
  if (!basis || basis.avgWeight === null) {
    // No history yet: fall back to an explicit estimate + today's weight if we have one.
    const todayWeight = data.days.find((d) => d.date === date)?.weightLb ?? null;
    const est = data.settings.nutrition.initialTdee;
    if (todayWeight === null) return { basis, tdee: null, recommendation: null };
    const tdee = effectiveTdee({ avgTdee: null, avgWeight: todayWeight, loggedCount: 0 }, est);
    return { basis, tdee, recommendation: tdee ? recommend(data.settings, tdee.value, todayWeight) : null };
  }
  const tdee = effectiveTdee(basis, data.settings.nutrition.initialTdee);
  return { basis, tdee, recommendation: tdee ? recommend(data.settings, tdee.value, basis.avgWeight) : null };
}

export interface WeeklyCheckin {
  from: ISODate;
  to: ISODate;
  tdee: EffectiveTdee | null;
  trendWeight: number | null;
  weightChangeLb: number | null;
  targetRateLbPerWeek: number | null;
  daysLogged: number;
  avgCalories: number | null;
  avgProtein: number | null;
  calorieAdherence: number | null;
  avgSteps: number | null;
  zone2: { done: number; planned: number };
  metcon: { done: number; planned: number };
  lifts: { done: number; planned: number };
  avgSleepMinutes: number | null;
  avgHrv: number | null;
  next: Recommendation | null;
  projection: Projection | null;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export interface Model {
  today: ISODate;
  series: EnergyDay[];
  todayEnergy: EnergyDay | null;
  targets: DayTargets;
  checkin: WeeklyCheckin;
  insights: Insight[];
}

export function buildModel(data: AppData, today: ISODate, historyDays = 120): Model {
  const series = computeEnergySeries(data.days, addDays(today, -historyDays), today, data.settings.nutrition.kcalPerLb);
  const todayEnergy = series.find((d) => d.date === today) ?? null;
  const targets = targetsFor(today, series, data);
  const checkin = weeklyCheckin(data, series, today);
  return { today, series, todayEnergy, targets, checkin, insights: insights(data, series, today, targets) };
}

/** The last seven complete days (ending yesterday). */
export function weeklyCheckin(data: AppData, series: ReadonlyArray<EnergyDay>, today: ISODate): WeeklyCheckin {
  const to = addDays(today, -1);
  const from = addDays(to, -6);
  const dates = dateRange(from, to);
  const byDate = new Map(data.days.map((d) => [d.date, d]));
  const sessions = new Map(data.sessions.map((s) => [s.date, s]));
  const end = series.find((d) => d.date === to) ?? null;
  const weekAgo = series.find((d) => d.date === addDays(to, -7)) ?? null;
  const days = dates.map((d) => byDate.get(d)).filter((d): d is DayLog => !!d);

  const tdee = end ? effectiveTdee(end, data.settings.nutrition.initialTdee) : null;
  const next = tdee && end?.avgWeight != null ? recommend(data.settings, tdee.value, end.avgWeight) : null;

  // Adherence: each day against the target that day actually showed (built from the day before),
  // not next week's recommendation.
  const withCals = days.filter((d) => d.calories !== null);
  const judged = withCals
    .map((d) => ({ calories: d.calories!, target: targetsFor(d.date, series, data).recommendation?.calories ?? null }))
    .filter((x): x is { calories: number; target: number } => x.target !== null && x.target > 0);
  const adherent = judged.filter((x) => Math.abs(x.calories - x.target) <= x.target * 0.1).length;

  const count = (pred: (date: ISODate) => boolean, done: (date: ISODate) => boolean) => {
    const planned = dates.filter(pred);
    return { planned: planned.length, done: planned.filter(done).length };
  };
  const { settings } = data;

  return {
    from,
    to,
    tdee,
    trendWeight: end?.avgWeight ?? null,
    weightChangeLb: end?.avgWeight != null && weekAgo?.avgWeight != null ? end.avgWeight - weekAgo.avgWeight : null,
    targetRateLbPerWeek: next?.rateLbPerWeek ?? null,
    daysLogged: dates.filter((d) => {
      const x = byDate.get(d);
      return x && x.weightLb !== null && x.calories !== null;
    }).length,
    avgCalories: mean(withCals.map((d) => d.calories!)),
    avgProtein: mean(days.filter((d) => d.proteinG !== null).map((d) => d.proteinG!)),
    calorieAdherence: judged.length ? adherent / judged.length : null,
    avgSteps: mean(days.filter((d) => d.steps !== null).map((d) => d.steps!)),
    zone2: count(
      (d) => !!settings.schedule.zone2[weekdayOf(d)],
      (d) => !!byDate.get(d)?.zone2Done,
    ),
    metcon: count(
      (d) => !!settings.schedule.metcon[weekdayOf(d)],
      (d) => !!byDate.get(d)?.metconDone,
    ),
    lifts: count(
      (d) => !!scheduledProgramDay(settings.program, d),
      (d) => !!sessions.get(d)?.completedAt,
    ),
    avgSleepMinutes: mean(days.filter((d) => d.sleepMinutes !== null).map((d) => d.sleepMinutes!)),
    avgHrv: mean(days.filter((d) => d.hrvMs !== null).map((d) => d.hrvMs!)),
    next,
    projection: end?.avgWeight != null ? project(settings, today, end.avgWeight, weekAgo?.avgWeight ?? null) : null,
  };
}

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------

export interface Insight {
  key: string;
  tone: "good" | "warn" | "info";
  text: string;
}

export function insights(data: AppData, series: ReadonlyArray<EnergyDay>, today: ISODate, targets: DayTargets): Insight[] {
  const out: Insight[] = [];
  const byDate = new Map(data.days.map((d) => [d.date, d]));
  const last7 = dateRange(addDays(today, -7), addDays(today, -1))
    .map((d) => byDate.get(d))
    .filter((d): d is DayLog => !!d);
  const rec = targets.recommendation;

  // Protein adherence.
  if (rec) {
    const withProtein = last7.filter((d) => d.proteinG !== null);
    const short = withProtein.filter((d) => d.proteinG! < rec.macros.proteinG * 0.9).length;
    if (withProtein.length >= 3 && short >= 3)
      out.push({
        key: "protein-short",
        tone: "warn",
        text: `Protein came in short on ${short} of the last ${withProtein.length} logged days.`,
      });
    else if (withProtein.length >= 5 && short === 0)
      out.push({ key: "protein-good", tone: "good", text: "Protein target hit every logged day this week." });
  }

  // Rate of change safety vs limits.
  const end = series.find((d) => d.date === addDays(today, -1));
  const weekAgo = series.find((d) => d.date === addDays(today, -8));
  if (end?.avgWeight != null && weekAgo?.avgWeight != null && end.loggedCount >= 10) {
    const change = end.avgWeight - weekAgo.avgWeight;
    const pct = (change / weekAgo.avgWeight) * 100;
    const { maxLossPctPerWeek, maxGainPctPerWeek } = data.settings.limits;
    if (pct < -maxLossPctPerWeek)
      out.push({
        key: "loss-fast",
        tone: "warn",
        text: `Trend is dropping ${Math.abs(pct).toFixed(1)}%/week — faster than your ${maxLossPctPerWeek}% limit. Consider eating closer to target.`,
      });
    else if (pct > maxGainPctPerWeek)
      out.push({
        key: "gain-fast",
        tone: "warn",
        text: `Trend is climbing ${pct.toFixed(1)}%/week — above your ${maxGainPctPerWeek}% limit.`,
      });
    else if (
      rec &&
      rec.direction !== "maintain" &&
      Math.sign(change) === Math.sign(rec.rateLbPerWeek) &&
      Math.abs(change) >= Math.abs(rec.rateLbPerWeek) * 0.6
    )
      out.push({
        key: "on-rate",
        tone: "good",
        text: `Trend moved ${change > 0 ? "+" : ""}${change.toFixed(1)} lb this week — right on plan.`,
      });
  }

  // Sleep.
  const sleep = last7.filter((d) => d.sleepMinutes !== null).map((d) => d.sleepMinutes!);
  const avgSleep = mean(sleep);
  if (avgSleep !== null && sleep.length >= 3 && avgSleep < 7 * 60)
    out.push({
      key: "sleep-low",
      tone: "warn",
      text: `Averaging ${Math.floor(avgSleep / 60)}h ${Math.round(avgSleep % 60)}m of sleep — recovery is the limiter at this volume.`,
    });

  // HRV trend: last 3 days vs prior 28-day baseline.
  const hrv = (from: number, to: number) =>
    mean(
      dateRange(addDays(today, -from), addDays(today, -to))
        .map((d) => byDate.get(d)?.hrvMs)
        .filter((v): v is number => v != null),
    );
  const recent = hrv(2, 0);
  const baseline = hrv(30, 3);
  if (recent !== null && baseline !== null) {
    if (recent < baseline * 0.88)
      out.push({
        key: "hrv-low",
        tone: "warn",
        text: `HRV is ${Math.round((1 - recent / baseline) * 100)}% under your baseline. A lighter day may pay off.`,
      });
    else if (recent > baseline * 1.08) out.push({ key: "hrv-high", tone: "good", text: "HRV is running above baseline — primed to push." });
  }

  // Steps.
  const steps = last7.filter((d) => d.steps !== null).map((d) => d.steps!);
  const avgSteps = mean(steps);
  const stepTarget = data.settings.targets.steps;
  if (avgSteps !== null && steps.length >= 3 && stepTarget > 0) {
    if (avgSteps < stepTarget * 0.9)
      out.push({
        key: "steps-low",
        tone: "info",
        text: `Steps averaging ${Math.round(avgSteps).toLocaleString()} vs ${stepTarget.toLocaleString()} target.`,
      });
    else if (steps.every((s) => s >= stepTarget) && steps.length >= 5)
      out.push({ key: "steps-good", tone: "good", text: "Step target hit every logged day this week." });
  }

  return out;
}
