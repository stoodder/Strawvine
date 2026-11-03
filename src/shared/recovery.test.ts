import { describe, expect, it } from "vitest";
import { addDays, dateRange } from "./dates";
import { defaultSettings } from "./defaults";
import type { AppData } from "./gamify";
import { buildModel } from "./insights";
import { baselineReading, recoveryInsight, restingHrSignal, vo2MaxTrend, VO2_STALE_DAYS } from "./recovery";
import { emptyDayLog, type DayLog } from "./schemas";

const today = "2026-12-01";
const byDate = (days: DayLog[]) => new Map(days.map((d) => [d.date, d]));

/** The 31 days up to today: `recent` on the last three (today included), `base` on the 28 before. */
const month = (f: (recent: boolean) => Partial<DayLog>): DayLog[] =>
  dateRange(addDays(today, -30), today).map((date) => ({ ...emptyDayLog(date), ...f(date >= addDays(today, -2)) }));
const rhr = (recent: number, base = 50) => month((r) => ({ restingHrBpm: r ? recent : base }));

describe("baselineReading", () => {
  it("means the last three days against the 28 before, skipping days without a value", () => {
    const days = [
      { ...emptyDayLog(today), restingHrBpm: 54 },
      { ...emptyDayLog(addDays(today, -2)), restingHrBpm: 56 },
      // Day 3 back is the baseline's newest day; day 30 back its oldest; day 31 back is outside.
      { ...emptyDayLog(addDays(today, -3)), restingHrBpm: 48 },
      { ...emptyDayLog(addDays(today, -30)), restingHrBpm: 50 },
      { ...emptyDayLog(addDays(today, -31)), restingHrBpm: 99 },
    ];
    expect(baselineReading(byDate(days), today, (d) => d.restingHrBpm)).toEqual({ recent: 55, baseline: 49 });
  });

  it("needs a value in both windows (and reads days cached without the field as missing)", () => {
    expect(baselineReading(byDate([{ ...emptyDayLog(today), restingHrBpm: 54 }]), today, (d) => d.restingHrBpm)).toBeNull();
    expect(baselineReading(byDate([{ ...emptyDayLog(addDays(today, -10)), restingHrBpm: 54 }]), today, (d) => d.restingHrBpm)).toBeNull();
    const { restingHrBpm: _r, ...legacy } = emptyDayLog(today);
    expect(baselineReading(byDate([legacy as DayLog]), today, (d) => d.restingHrBpm)).toBeNull();
    expect(baselineReading(new Map(), today, (d) => d.restingHrBpm)).toBeNull();
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
      text: "Resting HR is 6 bpm above your baseline. A lighter day may pay off.",
    });
    expect(recoveryInsight(byDate(rhr(46)), today)).toEqual({
      key: "rhr-low",
      tone: "good",
      text: "Resting HR is 4 bpm below your baseline — recovering well.",
    });
    expect(recoveryInsight(byDate(rhr(51)), today)).toBeNull();
  });

  it("keeps HRV's own insight", () => {
    const hrv = (recent: number) => byDate(month((r) => ({ hrvMs: r ? recent : 60 })));
    expect(recoveryInsight(hrv(50), today)).toMatchObject({
      key: "hrv-low",
      text: "HRV is 17% under your baseline. A lighter day may pay off.",
    });
    expect(recoveryInsight(hrv(70), today)).toMatchObject({ key: "hrv-high", tone: "good" });
    expect(recoveryInsight(hrv(60), today)).toBeNull();
  });

  it("makes HRV down and resting HR up one warning, never two", () => {
    const both = byDate(month((r) => ({ hrvMs: r ? 50 : 60, restingHrBpm: r ? 56 : 50 })));
    expect(recoveryInsight(both, today)).toEqual({
      key: "recovery-low",
      tone: "warn",
      text: "HRV is 17% under and resting HR 6 bpm above your baseline. A lighter day may pay off.",
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
    expect(vo2MaxTrend(days, "2026-11-03")).toEqual({ value: 51.3, date: "2026-11-01", change: 1.2, since: "2026-10-02" });
  });

  it("has no change without an earlier value in the window, and nothing when stale or never logged", () => {
    expect(vo2MaxTrend([vo2("2026-09-01", 47), vo2("2026-11-01", 51)], "2026-11-03")).toEqual({
      value: 51,
      date: "2026-11-01",
      change: null,
      since: null,
    });
    expect(vo2MaxTrend([vo2("2026-11-01", 51)], addDays("2026-11-01", VO2_STALE_DAYS))?.value).toBe(51);
    expect(vo2MaxTrend([vo2("2026-11-01", 51)], addDays("2026-11-01", VO2_STALE_DAYS + 1))).toBeNull();
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
    expect(c.vo2Max).toEqual({ value: 52, date: addDays(today, -1), change: 2, since: "2026-11-01" });
    expect(c.avgRestingHr).toBeCloseTo(342 / 7);
  });
});
