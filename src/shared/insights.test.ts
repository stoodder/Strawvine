import { describe, expect, it } from "vitest";
import { addDays, dateRange } from "./dates";
import { defaultSettings } from "./defaults";
import { computeEnergySeries } from "./energy";
import type { AppData } from "./gamify";
import { buildModel, insights, targetsFor, weeklyCheckin } from "./insights";
import { emptyDayLog, type DayLog, type Settings } from "./schemas";

const ids = { bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 };
const settings: Settings = { ...defaultSettings(ids, "2026-11-01"), onboarded: true };
const today = "2026-12-01";
const data = (days: DayLog[], patch: Partial<AppData> = {}): AppData => ({
  settings,
  days,
  exercises: [],
  maxEntries: [],
  sessions: [],
  ...patch,
});
const keys = (d: AppData) => buildModel(d, today).insights.map((i) => i.key);

/** `n` days ending yesterday, each built by `f(i, date)` (i = 0 is the oldest). */
const daysBefore = (n: number, f: (i: number, date: string) => Partial<DayLog>): DayLog[] =>
  dateRange(addDays(today, -n), addDays(today, -1)).map((date, i) => ({ ...emptyDayLog(date), ...f(i, date) }));
const steady = (n = 20, extra: (i: number) => Partial<DayLog> = () => ({})) =>
  daysBefore(n, (i) => ({ weightLb: 200, calories: 3000, ...extra(i) }));

describe("targetsFor", () => {
  it("falls back to the starting estimate and today's weight without history", () => {
    const withWeight = data([{ ...emptyDayLog(today), weightLb: 200 }]);
    const series = computeEnergySeries(withWeight.days, addDays(today, -30), today, 3500);
    const t = targetsFor(today, series, withWeight);
    expect(t.basis?.avgWeight ?? null).toBeNull();
    // No initial estimate set: 15 kcal/lb of bodyweight, provisional.
    expect(t.tdee).toMatchObject({ value: 3000, measured: null, provisional: true });
    expect(t.recommendation).toMatchObject({ direction: "maintain", calories: 3000 });

    const estimate = { ...settings, nutrition: { ...settings.nutrition, initialTdee: 2600 } };
    expect(targetsFor(today, series, { ...withWeight, settings: estimate }).recommendation?.calories).toBe(2600);
  });

  it("has nothing to offer without a weight", () => {
    const empty = data([{ ...emptyDayLog(today), calories: 2000 }]);
    const series = computeEnergySeries(empty.days, addDays(today, -30), today, 3500);
    expect(targetsFor(today, series, empty)).toMatchObject({ tdee: null, recommendation: null });
  });
});

describe("weekly check-in adherence", () => {
  it("judges each day against the target it showed, not next week's", () => {
    // A cut started a week ago: every day's target is ~1000 kcal under maintenance, and each day
    // ate exactly its own target. Next week's recommendation differs from the earlier targets.
    const goal = { targetLb: 180, pacePctPerWeek: 1, setOn: addDays(today, -30), startLb: 200 };
    const s = { ...settings, weightGoal: goal };
    let days = steady(30);
    // Eat each day's own target (which itself depends on the days before it).
    for (const date of dateRange(addDays(today, -7), addDays(today, -1))) {
      const series = computeEnergySeries(days, addDays(today, -120), today, 3500);
      const target = targetsFor(date, series, data(days, { settings: s })).recommendation!.calories;
      days = days.map((d) => (d.date === date ? { ...d, calories: target } : d));
    }
    const targets = new Set(days.slice(-7).map((d) => d.calories));
    expect(targets.size).toBeGreaterThan(1);
    const model = buildModel(data(days, { settings: s }), today);
    expect(model.checkin.calorieAdherence).toBe(1);
    // Measured against next week's single number, some of those days would miss.
    const next = model.checkin.next!.calories;
    expect(days.slice(-7).some((d) => Math.abs(d.calories! - next) > next * 0.1)).toBe(true);
  });

  it("is unknown without calories or targets", () => {
    const d = data(daysBefore(7, () => ({ steps: 1000 })));
    const series = computeEnergySeries(d.days, addDays(today, -120), today, 3500);
    expect(weeklyCheckin(d, series, today).calorieAdherence).toBeNull();
  });
});

describe("insights", () => {
  it("warns about short protein and praises a full week", () => {
    expect(keys(data(steady(20, (i) => (i >= 15 ? { proteinG: 120 } : {}))))).toContain("protein-short");
    expect(keys(data(steady(20, (i) => (i >= 13 ? { proteinG: 210 } : {}))))).toContain("protein-good");
    // Too few logged protein days for either.
    const few = keys(data(steady(20, (i) => (i >= 18 ? { proteinG: 120 } : {}))));
    expect(few).not.toContain("protein-short");
    expect(few).not.toContain("protein-good");
  });

  it("flags a trend moving faster than the limits, or right on plan", () => {
    expect(keys(data(daysBefore(21, (i) => ({ weightLb: 230 - i, calories: 2500 }))))).toContain("loss-fast");
    expect(keys(data(daysBefore(21, (i) => ({ weightLb: 190 + i * 0.5, calories: 3500 }))))).toContain("gain-fast");
    const goal = { targetLb: 180, pacePctPerWeek: 1, setOn: addDays(today, -30), startLb: 205 };
    const onPlan = data(
      daysBefore(21, (i) => ({ weightLb: 205 - i * 0.25, calories: 2500 })),
      { settings: { ...settings, weightGoal: goal } },
    );
    const k = keys(onPlan);
    expect(k).toContain("on-rate");
    expect(k).not.toContain("loss-fast");
    // Not before 10 logged days.
    expect(keys(data(daysBefore(8, (i) => ({ weightLb: 230 - i, calories: 2500 }))))).not.toContain("loss-fast");
  });

  it("warns about short sleep", () => {
    expect(keys(data(steady(20, (i) => (i >= 17 ? { sleepMinutes: 360 } : {}))))).toContain("sleep-low");
    expect(keys(data(steady(20, (i) => (i >= 17 ? { sleepMinutes: 480 } : {}))))).not.toContain("sleep-low");
  });

  it("compares the last three days of HRV with the month before", () => {
    const hrv = (recent: number) =>
      data(
        dateRange(addDays(today, -30), today).map((date) => ({
          ...emptyDayLog(date),
          hrvMs: date >= addDays(today, -2) ? recent : 60,
        })),
      );
    expect(keys(hrv(50))).toContain("hrv-low");
    expect(keys(hrv(70))).toContain("hrv-high");
    const flat = keys(hrv(60));
    expect(flat).not.toContain("hrv-low");
    expect(flat).not.toContain("hrv-high");
  });

  it("nudges on steps against the target", () => {
    expect(keys(data(steady(20, (i) => (i >= 17 ? { steps: 5000 } : {}))))).toContain("steps-low");
    expect(keys(data(steady(20, (i) => (i >= 15 ? { steps: 16000 } : {}))))).toContain("steps-good");
    const noTarget = { ...settings, targets: { ...settings.targets, steps: 0 } };
    expect(
      keys(
        data(
          steady(20, (i) => (i >= 17 ? { steps: 5000 } : {})),
          { settings: noTarget },
        ),
      ),
    ).not.toContain("steps-low");
  });

  it("says nothing without data", () => {
    const d = data([]);
    expect(insights(d, [], today, { basis: null, tdee: null, recommendation: null })).toEqual([]);
  });
});
