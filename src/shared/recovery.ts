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

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export interface BaselineReading {
  /** Mean of the recent window (today and the two days before). */
  recent: number;
  /** Mean of the 28 days before that. */
  baseline: number;
}

/**
 * A field's recent mean against its baseline as of `today`: days without a value are skipped;
 * null unless both windows have at least one value.
 */
export function baselineReading(
  byDate: ReadonlyMap<ISODate, DayLog>,
  today: ISODate,
  pick: (d: DayLog) => number | null | undefined,
): BaselineReading | null {
  const avg = (from: number, to: number) =>
    mean(
      dateRange(addDays(today, -from), addDays(today, -to))
        .map((d) => {
          const day = byDate.get(d);
          return day ? pick(day) : null;
        })
        .filter((v): v is number => v != null),
    );
  const recent = avg(RECOVERY_RECENT_DAYS - 1, 0);
  const baseline = avg(RECOVERY_RECENT_DAYS + RECOVERY_BASELINE_DAYS - 1, RECOVERY_RECENT_DAYS);
  return recent !== null && baseline !== null ? { recent, baseline } : null;
}

export type Signal = "low" | "high" | null;

export function hrvSignal(r: BaselineReading | null): Signal {
  if (!r) return null;
  if (r.recent < r.baseline * HRV_LOW_RATIO) return "low";
  if (r.recent > r.baseline * HRV_HIGH_RATIO) return "high";
  return null;
}

export function restingHrSignal(r: BaselineReading | null): Signal {
  if (!r) return null;
  const diff = r.recent - r.baseline;
  // "At least", with float noise ignored (50 × 0.07 is 3.5000000000000004).
  const atLeast = (x: number, limit: number) => x >= limit - 1e-9;
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
  const hrvUnder = hrv && Math.round((1 - hrv.recent / hrv.baseline) * 100);
  const rhrOver = rhr && Math.round(rhr.recent - rhr.baseline);
  const lighter = "A lighter day may pay off.";

  if (h === "low" && r === "high")
    return {
      key: "recovery-low",
      tone: "warn",
      text: `HRV is ${hrvUnder}% under and resting HR ${rhrOver} bpm above your baseline. ${lighter}`,
    };
  if (h === "low") return { key: "hrv-low", tone: "warn", text: `HRV is ${hrvUnder}% under your baseline. ${lighter}` };
  if (r === "high") return { key: "rhr-high", tone: "warn", text: `Resting HR is ${rhrOver} bpm above your baseline. ${lighter}` };
  if (h === "high" && r === "low")
    return { key: "recovery-high", tone: "good", text: "HRV is up and resting HR is down — primed to push." };
  if (h === "high") return { key: "hrv-high", tone: "good", text: "HRV is running above baseline — primed to push." };
  if (r === "low") return { key: "rhr-low", tone: "good", text: `Resting HR is ${-rhrOver!} bpm below your baseline — recovering well.` };
  return null;
}

export interface Vo2Trend {
  /** The latest VO2 max on or before the as-of date. */
  value: number;
  date: ISODate;
  /** Latest minus the oldest value in the 30 days before it (one decimal); null without one. */
  change: number | null;
  since: ISODate | null;
}

/**
 * VO2 max moves slowly, so it is shown as the latest value with its change over about a month:
 * against the oldest value logged in the `VO2_CHANGE_DAYS` before the latest (daily logging
 * compares with 30 days earlier; sparser logging with the earliest it has, named by `since`).
 * Null when nothing was logged in the `VO2_STALE_DAYS` up to `asOf`.
 */
export function vo2MaxTrend(days: ReadonlyArray<DayLog>, asOf: ISODate): Vo2Trend | null {
  const logged = days.filter((d) => d.vo2Max != null && d.date <= asOf).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const latest = logged.at(-1);
  if (!latest || latest.date < addDays(asOf, -VO2_STALE_DAYS)) return null;
  const from = addDays(latest.date, -VO2_CHANGE_DAYS);
  const ref = logged.find((d) => d.date >= from && d.date < latest.date);
  const change = ref ? Math.round((latest.vo2Max! - ref.vo2Max!) * 10) / 10 || 0 : null;
  return { value: latest.vo2Max!, date: latest.date, change, since: ref?.date ?? null };
}
