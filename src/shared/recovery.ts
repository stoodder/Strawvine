/**
 * Recovery signals from the morning check-in: HRV and resting heart rate against their own
 * baseline, and the slow-moving VO2 max trend. Thresholds are display/insight constants (like the
 * over-target tolerances), not training rules.
 */
import { addDays, dateRange, type ISODate } from "./dates";
import type { DayLog } from "./schemas";

/** The recent window: today and the two days before it. */
export const RECOVERY_RECENT_DAYS = 3;
/** The baseline: the 28 days before the recent window. */
export const RECOVERY_BASELINE_DAYS = 28;
/**
 * Readings a window needs before it's compared at all: one stray value can't make a "recent"
 * mean (+7 % is ~3.4 bpm at a 48 bpm baseline), nor a handful of days a baseline.
 */
export const RECOVERY_MIN_RECENT_READINGS = 2;
export const RECOVERY_MIN_BASELINE_READINGS = 7;

/** HRV is low under 88 % of its baseline, high over 108 %. */
export const HRV_LOW_RATIO = 0.88;
export const HRV_HIGH_RATIO = 1.08;

/** Resting HR is elevated at +5 bpm or +7 % over its baseline (whichever comes first)… */
export const RHR_HIGH_BPM = 5;
export const RHR_HIGH_PCT = 0.07;
/** …and down by as much under it. */
export const RHR_LOW_BPM = 5;
export const RHR_LOW_PCT = 0.07;

/** VO2 max change is measured against the oldest value in the 30 days before the latest one. */
export const VO2_CHANGE_DAYS = 30;
/** A VO2 max logged longer ago than this isn't shown as "latest". */
export const VO2_STALE_DAYS = 90;

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export interface BaselineReading {
  /** Mean of the recent window (today and the two days before). */
  recent: number;
  /** Mean of the 28 days before that. */
  baseline: number;
}

/**
 * A field's recent mean against its baseline as of `today`: days without a value are skipped;
 * null unless the recent window has `RECOVERY_MIN_RECENT_READINGS` values and the baseline
 * `RECOVERY_MIN_BASELINE_READINGS`.
 */
export function baselineReading(
  byDate: ReadonlyMap<ISODate, DayLog>,
  today: ISODate,
  pick: (d: DayLog) => number | null | undefined,
): BaselineReading | null {
  const values = (from: number, to: number) =>
    dateRange(addDays(today, -from), addDays(today, -to))
      .map((d) => {
        const day = byDate.get(d);
        return day ? pick(day) : null;
      })
      .filter((v): v is number => v != null && Number.isFinite(v));
  const recent = values(RECOVERY_RECENT_DAYS - 1, 0);
  const baseline = values(RECOVERY_RECENT_DAYS + RECOVERY_BASELINE_DAYS - 1, RECOVERY_RECENT_DAYS);
  if (recent.length < RECOVERY_MIN_RECENT_READINGS || baseline.length < RECOVERY_MIN_BASELINE_READINGS) return null;
  return { recent: mean(recent), baseline: mean(baseline) };
}

export type Signal = "low" | "high" | null;

/** Float noise ignored at the thresholds (50 × 0.07 is 3.5000000000000004; a mean of 52.8s may be 52.79999…). */
const EPS = 1e-9;

/** Low strictly under 88 % of the baseline, high strictly over 108 %. */
export function hrvSignal(r: BaselineReading | null): Signal {
  if (!r) return null;
  if (r.recent < r.baseline * HRV_LOW_RATIO - EPS) return "low";
  if (r.recent > r.baseline * HRV_HIGH_RATIO + EPS) return "high";
  return null;
}

export function restingHrSignal(r: BaselineReading | null): Signal {
  if (!r) return null;
  const diff = r.recent - r.baseline;
  const atLeast = (x: number, limit: number) => x >= limit - EPS;
  if (atLeast(diff, RHR_HIGH_BPM) || atLeast(diff, r.baseline * RHR_HIGH_PCT)) return "high";
  if (atLeast(-diff, RHR_LOW_BPM) || atLeast(-diff, r.baseline * RHR_LOW_PCT)) return "low";
  return null;
}

export interface RecoveryInsight {
  key: "recovery-low" | "hrv-low" | "rhr-high" | "recovery-high" | "hrv-high" | "rhr-low";
  tone: "good" | "warn";
  text: string;
}

/**
 * At most one recovery insight. HRV under and resting HR over baseline are the same story, so
 * both together are one warning ("recovery-low"), never two. Any warning wins over good news
 * (HRV up while resting HR is up reads as the resting-HR warning alone); both good is one
 * combined note.
 */
export function recoveryInsight(byDate: ReadonlyMap<ISODate, DayLog>, today: ISODate): RecoveryInsight | null {
  const hrv = baselineReading(byDate, today, (d) => d.hrvMs);
  const rhr = baselineReading(byDate, today, (d) => d.restingHrBpm);
  const h = hrvSignal(hrv);
  const r = restingHrSignal(rhr);
  // Magnitudes, rounded half away from zero: −3.5 bpm reads "4 bpm below", like +3.5 "4 bpm above".
  const hrvUnder = hrv && Math.round(Math.abs(1 - hrv.recent / hrv.baseline) * 100);
  const rhrBy = rhr && Math.round(Math.abs(rhr.recent - rhr.baseline));
  const lighter = "A lighter day may pay off.";
  const base = "your 4-week baseline";

  if (h === "low" && r === "high")
    return {
      key: "recovery-low",
      tone: "warn",
      text: `HRV is ${hrvUnder}% under and resting HR ${rhrBy} bpm above ${base}. ${lighter}`,
    };
  if (h === "low") return { key: "hrv-low", tone: "warn", text: `HRV is ${hrvUnder}% under ${base}. ${lighter}` };
  if (r === "high") return { key: "rhr-high", tone: "warn", text: `Resting HR is ${rhrBy} bpm above ${base}. ${lighter}` };
  if (h === "high" && r === "low")
    return { key: "recovery-high", tone: "good", text: "HRV is up and resting HR is down — primed to push." };
  if (h === "high") return { key: "hrv-high", tone: "good", text: `HRV is running above ${base} — primed to push.` };
  if (r === "low") return { key: "rhr-low", tone: "good", text: `Resting HR is ${rhrBy} bpm below ${base} — recovering well.` };
  return null;
}

export interface Vo2Trend {
  /** The latest VO2 max on or before the as-of date. */
  value: number;
  date: ISODate;
  /** Latest minus the oldest value in the 30 days before it (one decimal); null without one. */
  change: number | null;
  since: ISODate | null;
  /** Logged within the period being shown (on/after `currentFrom`); a stale value is labelled with its date. */
  current: boolean;
}

/**
 * VO2 max moves slowly, so it is shown as the latest value with its change over about a month:
 * against the oldest value logged in the `VO2_CHANGE_DAYS` before the latest (daily logging
 * compares with 30 days earlier; sparser logging with the earliest it has, named by `since`).
 * Null when nothing was logged in the `VO2_STALE_DAYS` up to `asOf`. With `currentFrom` (the
 * check-in week's first day), a latest value from before it is not `current`.
 */
export function vo2MaxTrend(days: ReadonlyArray<DayLog>, asOf: ISODate, currentFrom?: ISODate): Vo2Trend | null {
  const logged = days.filter((d) => d.vo2Max != null && d.date <= asOf).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const latest = logged.at(-1);
  if (!latest || latest.date < addDays(asOf, -VO2_STALE_DAYS)) return null;
  const from = addDays(latest.date, -VO2_CHANGE_DAYS);
  const ref = logged.find((d) => d.date >= from && d.date < latest.date);
  const change = ref ? Math.round((latest.vo2Max! - ref.vo2Max!) * 10) / 10 || 0 : null;
  return {
    value: latest.vo2Max!,
    date: latest.date,
    change,
    since: ref?.date ?? null,
    current: currentFrom === undefined || latest.date >= currentFrom,
  };
}
