import { describe, expect, it } from "vitest";
import { addDays, dateRange } from "./dates";
import { defaultSettings } from "./defaults";
import { computeEnergySeries } from "./energy";
import { dayChecklist, type AppData } from "./gamify";
import { buildModel, insights, targetsFor, weeklyCheckin } from "./insights";
import { overTarget } from "./nutrition";
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

  it("lists warnings first, then notes, then good news, keeping their own order within a tone", () => {
    // Protein good (pushed first), short sleep (warn), HRV low (warn), steps low (info).
    const days = dateRange(addDays(today, -30), today).map((date) => ({
      ...emptyDayLog(date),
      ...(date < today ? { weightLb: 200, calories: 3000, proteinG: 300, sleepMinutes: 360, steps: 5000 } : {}),
      hrvMs: date >= addDays(today, -2) ? 40 : 60,
    }));
    const list = buildModel(data(days), today).insights;
    expect(list.map((i) => i.key)).toEqual(["sleep-low", "hrv-low", "steps-low", "protein-good"]);
    expect(list.map((i) => i.tone)).toEqual(["warn", "warn", "info", "good"]);
  });

  it("says nothing without data", () => {
    const d = data([]);
    expect(insights(d, [], today, { basis: null, tdee: null, recommendation: null })).toEqual([]);
  });
});

describe("Zone 2 machine kcal", () => {
  // 40 days of a cut with varied intake and weight, Zone 2 on most of them; today half logged.
  const goal = { targetLb: 185, pacePctPerWeek: 0.75, setOn: addDays(today, -40), startLb: 204 };
  const s = { ...settings, weightGoal: goal };
  const base = dateRange(addDays(today, -40), today).map((date, i) => ({
    ...emptyDayLog(date),
    weightLb: i % 6 === 3 ? null : Math.round((204 - i * 0.12 + (i % 3) * 0.3) * 10) / 10,
    calories: i % 7 === 4 ? null : 2400 + ((i * 37) % 5) * 90,
    proteinG: 190 + (i % 4) * 6,
    zone2Done: i % 2 === 0,
    zone2Minutes: i % 2 === 0 ? 30 + (i % 3) * 10 : null,
  }));
  const withKcal = base.map((d, i) => ({ ...d, zone2Kcal: i % 2 === 0 ? 250 + (i % 5) * 150 : i % 3 === 0 ? 3000 : null }));

  it("leaves intake, the TDEE, targets, macros, fuel bars, insights and closing the day exactly as without it", () => {
    expect(withKcal.filter((d) => d.zone2Kcal !== null).length).toBeGreaterThan(20);
    const a = buildModel(data(base, { settings: s }), today);
    const b = buildModel(data(withKcal, { settings: s }), today);
    expect(a.targets.recommendation).not.toBeNull();
    expect(b.series).toEqual(a.series);
    expect(b.todayEnergy).toEqual(a.todayEnergy);
    expect(b.targets).toEqual(a.targets);
    expect(b.insights).toEqual(a.insights);
    // Every past day's own target too (adherence, the check-in's averages, next week's numbers).
    const { zone2Kcal, ...checkin } = b.checkin;
    const { zone2Kcal: none, ...without } = a.checkin;
    expect(checkin).toEqual(without);
    expect(none).toBeNull();
    expect(zone2Kcal).toBeGreaterThan(0);
    for (const date of dateRange(addDays(today, -14), today))
      expect(targetsFor(date, b.series, data(withKcal, { settings: s }))).toEqual(targetsFor(date, a.series, data(base, { settings: s })));
    // Today's fuel bar and the energy series computed directly.
    const day = (days: DayLog[]) => days.find((d) => d.date === today)!;
    expect(overTarget(day(withKcal).calories, b.targets.recommendation!.calories)).toEqual(
      overTarget(day(base).calories, a.targets.recommendation!.calories),
    );
    expect(computeEnergySeries(withKcal, addDays(today, -40), today, 3500)).toEqual(
      computeEnergySeries(base, addDays(today, -40), today, 3500),
    );
    // Closing the day: Zone 2 is still done by "done", whatever the reading.
    for (const date of dateRange(addDays(today, -7), today))
      expect(dayChecklist(date, data(withKcal, { settings: s }))).toEqual(dayChecklist(date, data(base, { settings: s })));
    const readingOnly = [{ ...emptyDayLog(today), zone2Kcal: 400 }];
    expect(dayChecklist(today, data(readingOnly, { settings: s })).find((i) => i.key === "zone2")?.done ?? false).toBe(false);
  });

  it("totals the week's readings in the check-in (null when none were logged)", () => {
    const week = daysBefore(7, (i) => ({ zone2Done: true, zone2Minutes: 30, zone2Kcal: i < 3 ? 300 + i * 10 : null }));
    const series = computeEnergySeries(week, addDays(today, -120), today, 3500);
    expect(weeklyCheckin(data(week), series, today).zone2Kcal).toBe(930);
    // Today's reading isn't in last week's check-in; nor is a day cached by an older build (no field).
    const legacy = week.map(({ zone2Kcal: _z, ...d }) => d as DayLog);
    const todayToo = [...legacy, { ...emptyDayLog(today), zone2Kcal: 500 }];
    expect(weeklyCheckin(data(todayToo), series, today).zone2Kcal).toBeNull();
  });
});
