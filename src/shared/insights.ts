/**
 * The derived "model" the UI renders: today's targets, the weekly check-in, projections and
 * rule-based insights.
 */
import { addDays, dateRange, weekdayOf, type ISODate } from "./dates";
import { computeEnergySeries, effectiveTdee, type EffectiveTdee, type EnergyDay } from "./energy";
import { type AppData } from "./gamify";
import { project, recommend, type Projection, type Recommendation } from "./nutrition";
import { scheduledProgramDay } from "./program";
import type { DayLog, Settings } from "./schemas";
import { recoveryInsight, vo2MaxTrend, type Vo2Trend } from "./recovery";
import { planDateOf, sessionDoneEarly } from "./session";

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
  /** The week's trend change judged against the plan and the safety limits (`weeklyRate`). */
  rate: WeeklyRate;
  daysLogged: number;
  avgCalories: number | null;
  avgProtein: number | null;
  calorieAdherence: number | null;
  avgSteps: number | null;
  zone2: { done: number; planned: number };
  /**
   * The week's total of the Zone 2 machine's calorie readings (a reading only, not intake), over the days `zone2.done`
   * counts (planned and done); null when none of them has one.
   */
  zone2Kcal: number | null;
  metcon: { done: number; planned: number };
  lifts: { done: number; planned: number };
  avgSleepMinutes: number | null;
  avgHrv: number | null;
  avgRestingHr: number | null;
  /** The latest VO2 max as of the week's last day, with its change over ~30 days. */
  vo2Max: Vo2Trend | null;
  next: Recommendation | null;
  projection: Projection | null;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sumOrNull = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) : null);

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

  /** The planned days, and those done: the count's numerator. */
  const plannedDone = (pred: (date: ISODate) => boolean, done: (date: ISODate) => boolean) => {
    const planned = dates.filter(pred);
    return { planned, done: planned.filter(done) };
  };
  const count = (pred: (date: ISODate) => boolean, done: (date: ISODate) => boolean) => {
    const p = plannedDone(pred, done);
    return { planned: p.planned.length, done: p.done.length };
  };
  const { settings } = data;
  // Zone 2: the machine total covers the same days as the "done" count beside it (planned and done),
  // so a reading from a day not ticked off, or an unplanned day, doesn't inflate it.
  const zone2 = plannedDone(
    (d) => !!settings.schedule.zone2[weekdayOf(d)],
    (d) => !!byDate.get(d)?.zone2Done,
  );
  const zone2Readings = zone2.done.map((d) => byDate.get(d)?.zone2Kcal).filter((k): k is number => k != null);

  return {
    from,
    to,
    tdee,
    trendWeight: end?.avgWeight ?? null,
    weightChangeLb: end?.avgWeight != null && weekAgo?.avgWeight != null ? end.avgWeight - weekAgo.avgWeight : null,
    targetRateLbPerWeek: next?.rateLbPerWeek ?? null,
    rate: weeklyRate({
      trendWeight: end?.avgWeight,
      weekAgoTrendWeight: weekAgo?.avgWeight,
      loggedCount: end?.loggedCount ?? 0,
      plan: next,
      limits: settings.limits,
    }),
    daysLogged: dates.filter((d) => {
      const x = byDate.get(d);
      return x && x.weightLb !== null && x.calories !== null;
    }).length,
    avgCalories: mean(withCals.map((d) => d.calories!)),
    avgProtein: mean(days.filter((d) => d.proteinG !== null).map((d) => d.proteinG!)),
    calorieAdherence: judged.length ? adherent / judged.length : null,
    avgSteps: mean(days.filter((d) => d.steps !== null).map((d) => d.steps!)),
    zone2: { planned: zone2.planned.length, done: zone2.done.length },
    zone2Kcal: sumOrNull(zone2Readings),
    metcon: count(
      (d) => !!settings.schedule.metcon[weekdayOf(d)],
      (d) => !!byDate.get(d)?.metconDone,
    ),
    // By plan: each program day counts once, done when its plan was completed — on the day or
    // moved to another ("do this session today", credited by `plannedFor`), as its checklist says.
    lifts: count(
      (d) => !!scheduledProgramDay(settings.program, d),
      (d) => {
        const own = sessions.get(d);
        return (!!own?.completedAt && planDateOf(own) === d) || !!sessionDoneEarly(d, data.sessions)?.completedAt;
      },
    ),
    avgSleepMinutes: mean(days.filter((d) => d.sleepMinutes !== null).map((d) => d.sleepMinutes!)),
    avgHrv: mean(days.filter((d) => d.hrvMs != null).map((d) => d.hrvMs!)),
    avgRestingHr: mean(days.filter((d) => d.restingHrBpm != null).map((d) => d.restingHrBpm!)),
    vo2Max: vo2MaxTrend(data.days, to, from),
    next,
    // With the plan: a target held at the minimum has no date "at pace".
    projection: end?.avgWeight != null ? project(settings, today, end.avgWeight, weekAgo?.avgWeight ?? null, next) : null,
  };
}

// ---------------------------------------------------------------------------
// The week's rate of change, judged: one rule for the check-in's verdict and the rate insights
// ---------------------------------------------------------------------------

/** Logged days needed before a week's trend change is judged (the trend is too noisy before). */
export const RATE_MIN_LOGGED_DAYS = 10;
/** A week counts as on plan from this share of the planned change, in the planned direction. */
export const ON_PLAN_MIN_SHARE = 0.6;

/**
 * - `no-data`: no trend weight a week apart yet, or fewer than `RATE_MIN_LOGGED_DAYS` logged days;
 * - `maintaining`: the plan is to hold (no goal, at the goal, or past it);
 * - `faster`: moving the planned way, past the safety limit for that direction;
 * - `wrong-way`: moving against the plan (by an amount that shows at one decimal);
 * - `on-plan`: at least `ON_PLAN_MIN_SHARE` of the planned change, the planned way, within the limit;
 * - `slower`: the planned way (or flat), but less than that.
 */
export type RateKind = "no-data" | "maintaining" | "on-plan" | "faster" | "slower" | "wrong-way";

export interface WeeklyRate {
  kind: RateKind;
  /** Trend weight change over the week (null without a trend a week apart). */
  changeLb: number | null;
  /** The same change as % of the trend weight a week ago. */
  pctPerWeek: number | null;
  /**
   * Signed lb/week the plan asks for (0 when maintaining). It is `recommend`'s rate, so while the
   * minimum calorie target holds a cut's target up it is the slower rate that target is built for:
   * a week is never "slower than plan" against a pace the app itself held back. A cut on hold
   * (`isOnHold`) is 0: the plan is to maintain.
   */
  planLb: number;
  /**
   * The plan's target is held up by the minimum calorie target (`Recommendation.floored`). The
   * plan's rate is then smaller than the athlete's pace by the app's doing, so being well past it
   * is not "faster than plan" / "ahead of plan": only a safety limit calls a held week fast.
   */
  held: boolean;
  /** The change is past a safety limit (Settings → limits), whatever the plan says. */
  overLimit: { direction: "loss" | "gain"; limitPct: number } | null;
  /** Logged days through the week's last day. */
  loggedCount: number;
}

/**
 * Judges a week's trend change against the plan (`recommend`'s rate) and the safety limits. The
 * only place these thresholds live: `insights` (loss-fast / gain-fast / on-rate) and the weekly
 * check-in's verdict (`weeklyVerdict`) both read it.
 */
export function weeklyRate(input: {
  /** Trend weight on the week's last day, and seven days before it. */
  trendWeight: number | null | undefined;
  weekAgoTrendWeight: number | null | undefined;
  loggedCount: number;
  plan: (Pick<Recommendation, "direction" | "rateLbPerWeek"> & Partial<Pick<Recommendation, "floored">>) | null;
  limits: Settings["limits"];
}): WeeklyRate {
  const { trendWeight, weekAgoTrendWeight, loggedCount, plan, limits } = input;
  // `|| 0`: a plan of −0 (a cut at no pace) is 0.
  const planLb = (plan && plan.direction !== "maintain" ? plan.rateLbPerWeek : 0) || 0;
  const held = !!plan?.floored;
  if (trendWeight == null || weekAgoTrendWeight == null)
    return { kind: "no-data", changeLb: null, pctPerWeek: null, planLb, held, overLimit: null, loggedCount };
  const changeLb = trendWeight - weekAgoTrendWeight;
  const pctPerWeek = (changeLb / weekAgoTrendWeight) * 100;
  if (loggedCount < RATE_MIN_LOGGED_DAYS) return { kind: "no-data", changeLb, pctPerWeek, planLb, held, overLimit: null, loggedCount };

  const overLimit: WeeklyRate["overLimit"] =
    pctPerWeek < -limits.maxLossPctPerWeek
      ? { direction: "loss", limitPct: limits.maxLossPctPerWeek }
      : pctPerWeek > limits.maxGainPctPerWeek
        ? { direction: "gain", limitPct: limits.maxGainPctPerWeek }
        : null;
  // "Against the plan" is read at the precision the change is shown in, so a week that prints
  // as 0.0 lb is slow, never the wrong direction.
  const shown = Math.round(changeLb * 10) / 10;
  let kind: RateKind;
  if (planLb === 0) kind = "maintaining";
  else if (overLimit && (overLimit.direction === "loss") === planLb < 0) kind = "faster";
  else if (shown !== 0 && Math.sign(shown) !== Math.sign(planLb)) kind = "wrong-way";
  else if (Math.sign(changeLb) === Math.sign(planLb) && Math.abs(changeLb) >= Math.abs(planLb) * ON_PLAN_MIN_SHARE) kind = "on-plan";
  else kind = "slower";
  return { kind, changeLb, pctPerWeek, planLb, held, overLimit, loggedCount };
}

/*
 * The verdict's wording thresholds. They refine how `weeklyRate`'s kinds are *said*; the rule
 * itself (and with it the rate insights) is untouched.
 */
/** Against the plan by no more than this (as printed), or 0.0: scale noise — "Flat this week". */
export const FLAT_MAX_LB = 0.2;
/** The planned way by more than this multiple of the plan, within the safety limit: "Faster than plan". */
export const FASTER_THAN_PLAN_SHARE = 1.5;

/**
 * `weeklyRate`'s kinds as the verdict words them, plus two of its own:
 * - `flat`: the week prints as 0.0 lb, or as at most `FLAT_MAX_LB` against the plan — noise, not a direction;
 * - `drifting`: the plan is to hold and the trend is past a safety limit;
 * - `faster` also covers the planned way by more than `FASTER_THAN_PLAN_SHARE` × the plan, within the limit
 *   — unless the plan is held at the minimum calorie target (`WeeklyRate.held`): that week stays `on-plan`.
 */
export type VerdictKind = RateKind | "flat" | "drifting";

export interface WeeklyVerdict {
  kind: VerdictKind;
  /** good: on plan · warn: past a safety limit, or against the plan · info: everything else. */
  tone: Insight["tone"];
  /** "On plan" */
  title: string;
  /** "−1.3 lb this week against −1.5 lb" */
  detail: string;
  /** The whole line: "On plan · −1.3 lb this week against −1.5 lb". */
  text: string;
}

const VERDICT_TITLE: Record<VerdictKind, string> = {
  "no-data": "Not enough data yet",
  maintaining: "Maintaining",
  drifting: "Drifting",
  "on-plan": "On plan",
  faster: "Faster than plan",
  slower: "Slower than plan",
  flat: "Flat this week",
  "wrong-way": "Wrong direction",
};

/** "+1.3" / "−1.3" / "0.0": one decimal, with a real minus sign. */
function signedLb(n: number): string {
  const s = Math.abs(n).toFixed(1);
  return s === "0.0" ? s : n > 0 ? `+${s}` : `−${s}`;
}

/**
 * The weekly check-in's headline: the week's trend change against the plan, in one line. It words
 * `checkin.rate` (`weeklyRate`) and splits three of its kinds further for the reader; what counts
 * as on plan, past a limit or against the plan is still `weeklyRate`'s call:
 * - against the plan by a change that prints within `FLAT_MAX_LB` (or a week that prints as 0.0)
 *   is "Flat this week", a note — "Wrong direction", a warning, starts beyond that;
 * - on plan by more than `FASTER_THAN_PLAN_SHARE` × the plan is "Faster than plan", a note (past
 *   the safety limit it already was, as a warning) — except while the minimum calorie target holds
 *   the plan's target up: the plan is small because the app held it, so only the limit calls it fast;
 * - on plan with a change that prints as 0.0 (a plan of a tenth of a pound) is "Flat this week" too;
 * - holding with the trend past a safety limit is "Drifting", not a calm "Maintaining".
 */
export function weeklyVerdict(checkin: Pick<WeeklyCheckin, "rate">): WeeklyVerdict {
  const { kind: rateKind, changeLb, planLb, held, overLimit, loggedCount } = checkin.rate;
  let kind: VerdictKind = rateKind;
  let tone: Insight["tone"] = "info";
  let detail: string;
  if (rateKind === "no-data" || changeLb === null) {
    detail =
      loggedCount < RATE_MIN_LOGGED_DAYS
        ? `the trend is judged after ${RATE_MIN_LOGGED_DAYS} logged days (${loggedCount} so far)`
        : "it takes trend weights a week apart";
  } else {
    // Read at the precision the change is shown in, so the title never contradicts the number under it.
    const printed = Number(Math.abs(changeLb).toFixed(1));
    if (rateKind === "maintaining") {
      if (overLimit) kind = "drifting";
    } else if (
      !overLimit &&
      (((rateKind === "slower" || rateKind === "on-plan") && printed === 0) || (rateKind === "wrong-way" && printed <= FLAT_MAX_LB))
    )
      kind = "flat";
    else if (rateKind === "on-plan" && !held && Math.abs(changeLb) > Math.abs(planLb) * FASTER_THAN_PLAN_SHARE) kind = "faster";

    const limit = overLimit ? `, past your ${overLimit.limitPct}% weekly limit` : "";
    detail =
      kind === "maintaining" || kind === "drifting"
        ? `trend ${signedLb(changeLb)} lb this week${limit}`
        : // "Flat this week" has already said when.
          `${signedLb(changeLb)} lb${kind === "flat" ? "" : " this week"} against ${signedLb(planLb)} lb${limit}`;
    if (overLimit || kind === "wrong-way") tone = "warn";
    else if (kind === "on-plan") tone = "good";
  }
  const title = VERDICT_TITLE[kind];
  return { kind, tone, title, detail, text: `${title} · ${detail}` };
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

  // Rate of change: past a safety limit, or on plan — the judgement the check-in's verdict words (`weeklyRate`).
  const end = series.find((d) => d.date === addDays(today, -1));
  const weekAgo = series.find((d) => d.date === addDays(today, -8));
  const rate = weeklyRate({
    trendWeight: end?.avgWeight,
    weekAgoTrendWeight: weekAgo?.avgWeight,
    loggedCount: end?.loggedCount ?? 0,
    plan: rec,
    limits: data.settings.limits,
  });
  if (rate.kind !== "no-data" && rate.changeLb !== null && rate.pctPerWeek !== null) {
    const { changeLb: change, pctPerWeek: pct, overLimit } = rate;
    if (overLimit?.direction === "loss")
      out.push({
        key: "loss-fast",
        tone: "warn",
        text: `Trend is dropping ${Math.abs(pct).toFixed(1)}%/week — faster than your ${overLimit.limitPct}% limit. Consider eating closer to target.`,
      });
    else if (overLimit)
      out.push({
        key: "gain-fast",
        tone: "warn",
        text: `Trend is climbing ${pct.toFixed(1)}%/week — above your ${overLimit.limitPct}% limit.`,
      });
    // (A change that prints as 0.0 is the verdict's "Flat this week": nothing to say here.)
    else if (rate.kind === "on-plan" && Number(Math.abs(change).toFixed(1)) !== 0) {
      // Well ahead of the plan (inside the limit) is a note, not "right on plan": the same band the
      // weekly verdict calls "Faster than plan", so Today's signal and Progress never disagree — and
      // like the verdict, not while the minimum calorie target is what made the plan small.
      const ahead = !rate.held && Math.abs(change) > Math.abs(rate.planLb) * FASTER_THAN_PLAN_SHARE;
      out.push({
        key: "on-rate",
        tone: ahead ? "info" : "good",
        text: `Trend moved ${change > 0 ? "+" : ""}${change.toFixed(1)} lb this week — ${ahead ? "ahead of plan" : "right on plan"}.`,
      });
    }
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

  // Recovery: HRV and resting HR, last 3 days vs the 28 days before — one insight at most.
  const recovery = recoveryInsight(byDate, today);
  if (recovery) out.push(recovery);

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

  // Warnings first, then notes, then good news; within a tone, the order above (a stable sort).
  return out.sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone]);
}

const TONE_ORDER: Record<Insight["tone"], number> = { warn: 0, info: 1, good: 2 };
