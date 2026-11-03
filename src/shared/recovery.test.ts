import { describe, expect, it } from "vitest";
import { addDays, dateRange } from "./dates";
import { defaultSettings } from "./defaults";
import type { AppData } from "./gamify";
import { buildModel } from "./insights";
import {
  baselineReading,
  hrvSignal,
  recoveryInsight,
  RECOVERY_MIN_BASELINE_READINGS,
  RECOVERY_MIN_RECENT_READINGS,
  restingHrSignal,
  vo2MaxTrend,
} from "./recovery";
import { emptyDayLog, type DayLog } from "./schemas";

const today = "2026-12-01";
const byDate = (days: DayLog[]) => new Map(days.map((d) => [d.date, d]));

/** The 31 days up to today: `recent` on the last three (today included), `base` on the 28 before. */
const month = (f: (recent: boolean) => Partial<DayLog>): DayLog[] =>
  dateRange(addDays(today, -30), today).map((date) => ({ ...emptyDayLog(date), ...f(date >= addDays(today, -2)) }));
const rhr = (recent: number, base = 50) => month((r) => ({ restingHrBpm: r ? recent : base }));
/** A day as an older build cached it: without the fields added since (resting HR, VO2 max, the flags). */
const legacy = (date: string, extra: Partial<DayLog> = {}): DayLog => {
  const { restingHrBpm: _r, vo2Max: _v, alcohol: _a, nicotine: _n, thc: _t, caffeine: _c, ...rest } = { ...emptyDayLog(date), ...extra };
  return rest as DayLog;
};

describe("baselineReading", () => {
  it("means the last three days against the 28 before, skipping days without a value", () => {
    const days = [
      { ...emptyDayLog(today), restingHrBpm: 54 },
      { ...emptyDayLog(addDays(today, -2)), restingHrBpm: 56 },
      // Day 3 back is the baseline's newest day; day 30 back its oldest; day 31 back is outside.
      { ...emptyDayLog(addDays(today, -3)), restingHrBpm: 48 },
      ...[-5, -8, -11, -14, -20].map((n) => ({ ...emptyDayLog(addDays(today, n)), restingHrBpm: 49 })),
      { ...emptyDayLog(addDays(today, -30)), restingHrBpm: 50 },
      { ...emptyDayLog(addDays(today, -31)), restingHrBpm: 99 },
    ];
    expect(baselineReading(byDate(days), today, (d) => d.restingHrBpm)).toEqual({ recent: 55, baseline: 49 });
  });

  it("needs 2 readings in the recent window and 7 in the baseline: one stray value isn't a trend", () => {
    expect(RECOVERY_MIN_RECENT_READINGS).toBe(2);
    expect(RECOVERY_MIN_BASELINE_READINGS).toBe(7);
    /** `recent` readings from today back, `base` from 3 days back, one every other day. */
    const readings = (recent: number, base: number) =>
      byDate([
        ...Array.from({ length: recent }, (_, i) => ({ ...emptyDayLog(addDays(today, -i)), restingHrBpm: 60 })),
        ...Array.from({ length: base }, (_, i) => ({ ...emptyDayLog(addDays(today, -3 - 2 * i)), restingHrBpm: 50 })),
      ]);
    const read = (recent: number, base: number) => baselineReading(readings(recent, base), today, (d) => d.restingHrBpm);
    expect(read(1, 14)).toBeNull();
    expect(read(2, 14)).toEqual({ recent: 60, baseline: 50 });
    expect(read(3, 6)).toBeNull();
    expect(read(3, 7)).toEqual({ recent: 60, baseline: 50 });
    // A single high morning against a full baseline raises nothing.
    expect(recoveryInsight(readings(1, 14), today)).toBeNull();
    expect(recoveryInsight(readings(2, 14), today)?.key).toBe("rhr-high");
    expect(baselineReading(new Map(), today, (d) => d.restingHrBpm)).toBeNull();
  });

  it("reads days cached by an older build (no resting HR field) as missing, in both windows", () => {
    // Every other day is a legacy copy; HRV is on all of them.
    const days = dateRange(addDays(today, -30), today).map((date, i) =>
      i % 2 ? legacy(date, { hrvMs: 60 }) : { ...emptyDayLog(date), hrvMs: 60, restingHrBpm: date >= addDays(today, -2) ? 56 : 50 },
    );
    const r = baselineReading(byDate(days), today, (d) => d.restingHrBpm);
    expect(r).toEqual({ recent: 56, baseline: 50 });
    expect(Number.isFinite(r!.recent) && Number.isFinite(r!.baseline)).toBe(true);
    expect(baselineReading(byDate(days), today, (d) => d.hrvMs)).toEqual({ recent: 60, baseline: 60 });
    expect(recoveryInsight(byDate(days), today)?.key).toBe("rhr-high");
    // Only legacy days: nothing.
    expect(baselineReading(byDate(dateRange(addDays(today, -30), today).map((d) => legacy(d))), today, (d) => d.restingHrBpm)).toBeNull();
  });
});

describe("hrvSignal", () => {
  it("is low strictly under 88 % of the baseline and high strictly over 108 %", () => {
    expect(hrvSignal({ recent: 52.8, baseline: 60 })).toBeNull();
    expect(hrvSignal({ recent: 52.79, baseline: 60 })).toBe("low");
    expect(hrvSignal({ recent: 64.8, baseline: 60 })).toBeNull();
    expect(hrvSignal({ recent: 64.81, baseline: 60 })).toBe("high");
    expect(hrvSignal(null)).toBeNull();
  });

  it("holds at the same boundaries through the windows' means (and the minimum readings)", () => {
    const hrv = (recent: number) => byDate(month((r) => ({ hrvMs: r ? recent : 60 })));
    expect(recoveryInsight(hrv(52.8), today)).toBeNull();
    expect(recoveryInsight(hrv(52.79), today)?.key).toBe("hrv-low");
    expect(recoveryInsight(hrv(64.8), today)).toBeNull();
    expect(recoveryInsight(hrv(64.81), today)?.key).toBe("hrv-high");
    // One low morning alone (the other two recent days unlogged) is no warning.
    const one = month((r) => ({ hrvMs: r ? null : 60 }));
    one[one.length - 1] = { ...one[one.length - 1]!, hrvMs: 40 };
    expect(recoveryInsight(byDate(one), today)).toBeNull();
  });
});

describe("restingHrSignal", () => {
  it("is elevated at +5 bpm or +7 %, whichever comes first", () => {
    // Baseline 50: 7 % is 3.5 bpm, under 5.
    expect(restingHrSignal({ recent: 53.4, baseline: 50 })).toBeNull();
    expect(restingHrSignal({ recent: 53.5, baseline: 50 })).toBe("high");
    // Baseline 80: 5 bpm comes before 7 % (5.6 bpm).
    expect(restingHrSignal({ recent: 84.9, baseline: 80 })).toBeNull();
    expect(restingHrSignal({ recent: 85, baseline: 80 })).toBe("high");
  });

  it("is down by as much the other way", () => {
    expect(restingHrSignal({ recent: 46.6, baseline: 50 })).toBeNull();
    expect(restingHrSignal({ recent: 46.5, baseline: 50 })).toBe("low");
    expect(restingHrSignal({ recent: 75, baseline: 80 })).toBe("low");
    expect(restingHrSignal(null)).toBeNull();
  });
});

describe("recoveryInsight", () => {
  it("warns when resting HR runs above its baseline", () => {
    expect(recoveryInsight(byDate(rhr(56)), today)).toEqual({
      key: "rhr-high",
      tone: "warn",
      text: "Resting HR is 6 bpm above your 4-week baseline. A lighter day may pay off.",
    });
    expect(recoveryInsight(byDate(rhr(46)), today)).toEqual({
      key: "rhr-low",
      tone: "good",
      text: "Resting HR is 4 bpm below your 4-week baseline — recovering well.",
    });
    expect(recoveryInsight(byDate(rhr(51)), today)).toBeNull();
  });

  it("rounds the difference's magnitude, the same either way", () => {
    expect(recoveryInsight(byDate(rhr(56.4)), today)?.text).toBe("Resting HR is 6 bpm above your 4-week baseline. A lighter day may pay off.");
    // ±3.5 at a 50 baseline is the 7 % threshold: 4 bpm both ways (Math.round(−3.5) would say 3).
    expect(recoveryInsight(byDate(rhr(53.5)), today)?.text).toContain("4 bpm above");
    expect(recoveryInsight(byDate(rhr(46.5)), today)?.text).toBe("Resting HR is 4 bpm below your 4-week baseline — recovering well.");
  });

  it("keeps HRV's own insight", () => {
    const hrv = (recent: number) => byDate(month((r) => ({ hrvMs: r ? recent : 60 })));
    expect(recoveryInsight(hrv(50), today)).toMatchObject({
      key: "hrv-low",
      text: "HRV is 17% under your 4-week baseline. A lighter day may pay off.",
    });
    expect(recoveryInsight(hrv(70), today)).toMatchObject({ key: "hrv-high", tone: "good" });
    expect(recoveryInsight(hrv(60), today)).toBeNull();
  });

  it("makes HRV down and resting HR up one warning, never two", () => {
    const both = byDate(month((r) => ({ hrvMs: r ? 50 : 60, restingHrBpm: r ? 56 : 50 })));
    expect(recoveryInsight(both, today)).toEqual({
      key: "recovery-low",
      tone: "warn",
      text: "HRV is 17% under and resting HR 6 bpm above your 4-week baseline. A lighter day may pay off.",
    });
  });

  it("lets a warning win over good news from the other metric, and folds two good ones into one", () => {
    const mixed = (hrv: number, hr: number) => byDate(month((r) => ({ hrvMs: r ? hrv : 60, restingHrBpm: r ? hr : 50 })));
    expect(recoveryInsight(mixed(70, 56), today)?.key).toBe("rhr-high");
    expect(recoveryInsight(mixed(50, 45), today)?.key).toBe("hrv-low");
    expect(recoveryInsight(mixed(70, 45), today)).toEqual({
      key: "recovery-high",
      tone: "good",
      text: "HRV is up and resting HR is down — primed to push.",
    });
  });

  it("is what the model's insights show (one recovery insight at most)", () => {
    const ids = { bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 };
    const data: AppData = {
      settings: { ...defaultSettings(ids, "2026-11-01"), onboarded: true },
      days: month((r) => ({ hrvMs: r ? 50 : 60, restingHrBpm: r ? 56 : 50 })),
      exercises: [],
      maxEntries: [],
      sessions: [],
    };
    const keys = buildModel(data, today).insights.map((i) => i.key);
    expect(keys).toContain("recovery-low");
    expect(keys).not.toContain("hrv-low");
    expect(keys).not.toContain("rhr-high");
  });
});

describe("vo2MaxTrend", () => {
  const vo2 = (date: string, vo2Max: number): DayLog => ({ ...emptyDayLog(date), vo2Max });

  it("is the latest value with its change against the oldest one in the 30 days before it", () => {
    const days = [
      vo2("2026-10-01", 48), // 31 days before the latest: outside the window
      vo2("2026-10-02", 50.1),
      vo2("2026-10-20", 50.8),
      vo2("2026-11-01", 51.3),
      vo2("2026-11-05", 60), // after the as-of date
      { ...emptyDayLog("2026-11-02"), hrvMs: 60 },
    ];
    expect(vo2MaxTrend(days, "2026-11-03")).toEqual({ value: 51.3, date: "2026-11-01", change: 1.2, since: "2026-10-02", current: true });
    // Order doesn't matter, and a day cached by an older build (no VO2 field) after the latest is skipped.
    const shuffled = [days[3]!, legacy("2026-11-02", { hrvMs: 50 }), days[0]!, days[4]!, days[2]!, days[1]!, days[5]!];
    expect(vo2MaxTrend(shuffled, "2026-11-03")).toEqual({ value: 51.3, date: "2026-11-01", change: 1.2, since: "2026-10-02", current: true });
  });

  it("is not current when the latest value is from before the period shown", () => {
    const days = [vo2("2026-08-01", 48), vo2("2026-08-20", 50)];
    expect(vo2MaxTrend(days, "2026-11-01", "2026-10-26")).toEqual({
      value: 50,
      date: "2026-08-20",
      change: 2,
      since: "2026-08-01",
      current: false,
    });
    expect(vo2MaxTrend([vo2("2026-10-26", 50)], "2026-11-01", "2026-10-26")?.current).toBe(true);
    expect(vo2MaxTrend([vo2("2026-10-25", 50)], "2026-11-01", "2026-10-26")?.current).toBe(false);
  });

  it("has no change without an earlier value in the window, and nothing when stale or never logged", () => {
    expect(vo2MaxTrend([vo2("2026-09-01", 47), vo2("2026-11-01", 51)], "2026-11-03")).toEqual({
      value: 51,
      date: "2026-11-01",
      change: null,
      since: null,
      current: true,
    });
    // 90 days: Nov 1 + 90 is Jan 30.
    expect(vo2MaxTrend([vo2("2026-11-01", 51)], "2027-01-30")?.value).toBe(51);
    expect(vo2MaxTrend([vo2("2026-11-01", 51)], "2027-01-31")).toBeNull();
    expect(vo2MaxTrend([{ ...emptyDayLog("2026-11-01"), hrvMs: 50 }], "2026-11-03")).toBeNull();
    expect(vo2MaxTrend([], "2026-11-03")).toBeNull();
  });

  it("reports no change as 0, never −0", () => {
    expect(vo2MaxTrend([vo2("2026-10-20", 50.04), vo2("2026-11-01", 50)], "2026-11-01")?.change).toBe(0);
    expect(Object.is(vo2MaxTrend([vo2("2026-10-20", 50.04), vo2("2026-11-01", 50)], "2026-11-01")?.change, -0)).toBe(false);
  });

  it("feeds the weekly check-in as of its last day, with the week's average resting HR", () => {
    const ids = { bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 };
    // The check-in week is Nov 24–30: resting HR 48, 50, 48, … (48·4 + 50·3 = 342 over 7 days).
    const week = dateRange(addDays(today, -7), addDays(today, -1)).map((date, i) => ({
      ...emptyDayLog(date),
      restingHrBpm: 48 + (i % 2) * 2,
    }));
    week[6] = { ...week[6]!, vo2Max: 52 };
    const data: AppData = {
      settings: { ...defaultSettings(ids, "2026-11-01"), onboarded: true },
      // Today (not in the check-in) has the highest values of all.
      days: [vo2("2026-11-01", 50), ...week, { ...vo2(today, 55), restingHrBpm: 90 }],
      exercises: [],
      maxEntries: [],
      sessions: [],
    };
    const c = buildModel(data, today).checkin;
    expect(c.vo2Max).toEqual({ value: 52, date: addDays(today, -1), change: 2, since: "2026-11-01", current: true });
    expect(c.avgRestingHr).toBeCloseTo(342 / 7);

    // A day of the week cached by an older build (without the new fields) leaves finite averages.
    const withLegacy = { ...data, days: data.days.map((d) => (d.date === addDays(today, -4) ? legacy(d.date, { hrvMs: 55 }) : d)) };
    const l = buildModel(withLegacy, today).checkin;
    expect(l.avgRestingHr).toBeCloseTo((342 - 50) / 6);
    expect(Number.isFinite(l.avgRestingHr)).toBe(true);
    expect(l.avgHrv).toBe(55);
    expect(l.vo2Max?.value).toBe(52);

    // A VO2 max from before the check-in week (Nov 24–30) isn't current.
    const old = buildModel({ ...data, days: [vo2("2026-11-01", 50), vo2("2026-11-20", 51)] }, today).checkin;
    expect(old.vo2Max).toMatchObject({ value: 51, date: "2026-11-20", current: false });
  });
});
