import { describe, expect, it } from "vitest";
import { addDays, dateRange } from "./dates";
import { defaultSettings } from "./defaults";
import { computeEnergySeries } from "./energy";
import { dayChecklist, type AppData } from "./gamify";
import {
  buildModel,
  FASTER_THAN_PLAN_SHARE,
  FLAT_MAX_LB,
  insights,
  ON_PLAN_MIN_SHARE,
  targetsFor,
  weeklyCheckin,
  weeklyRate,
  weeklyVerdict,
} from "./insights";
import { isOnHold, overTarget, recommend } from "./nutrition";
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

describe("the week's rate against the plan (weeklyRate, weeklyVerdict)", () => {
  const limits = { maxLossPctPerWeek: 1, maxGainPctPerWeek: 0.5 };
  const cut = { direction: "lose", rateLbPerWeek: -1.5 } as const;
  const build = { direction: "gain", rateLbPerWeek: 0.8 } as const;
  const hold = { direction: "maintain", rateLbPerWeek: 0 } as const;
  type Plan = Parameters<typeof weeklyRate>[0]["plan"];
  /** A week that moved the trend by `changeLb` from 200 lb. */
  const rate = (changeLb: number, plan: Plan = cut, loggedCount = 30) =>
    weeklyRate({ trendWeight: 200 + changeLb, weekAgoTrendWeight: 200, loggedCount, plan, limits });
  const verdict = (...args: Parameters<typeof rate>) => weeklyVerdict({ rate: rate(...args) });

  it("on plan: at least 60% of the planned change, the planned way, within the limit", () => {
    expect(verdict(-1.3)).toEqual({
      kind: "on-plan",
      tone: "good",
      title: "On plan",
      detail: "−1.3 lb this week against −1.5 lb",
      text: "On plan · −1.3 lb this week against −1.5 lb",
    });
    expect(rate(-0.95).kind).toBe("on-plan");
    // Quicker than planned but inside the safety limit is still on plan for the rule (the limit is its only ceiling).
    expect(rate(-1.9).kind).toBe("on-plan");
    expect(verdict(0.7, build).text).toBe("On plan · +0.7 lb this week against +0.8 lb");
  });

  it("the 60% share is inclusive: exactly that much of the plan is on plan, a hair less is slower", () => {
    // 60% of 2.5 lb is 1.5 lb (both exact in binary), at 0.75%/week: inside the 1% limit.
    const plan = { direction: "lose", rateLbPerWeek: -2.5 } as const;
    expect(ON_PLAN_MIN_SHARE).toBe(0.6);
    expect(rate(-1.5, plan).kind).toBe("on-plan");
    expect(rate(-1.49, plan).kind).toBe("slower");
    expect(verdict(-1.5, plan)).toMatchObject({ kind: "on-plan", tone: "good" });
    expect(verdict(-1.49, plan)).toMatchObject({ kind: "slower", tone: "info" });
  });

  it("slower than plan: the planned way, under 60%", () => {
    expect(verdict(-0.4)).toMatchObject({ kind: "slower", tone: "info", text: "Slower than plan · −0.4 lb this week against −1.5 lb" });
    expect(rate(-0.85).kind).toBe("slower");
    expect(rate(0.3, build).kind).toBe("slower");
    // The smallest change that prints, the planned way: slow, not flat.
    expect(verdict(-0.06).text).toBe("Slower than plan · −0.1 lb this week against −1.5 lb");
    // For the rule, a week that prints as 0.0 is slow, whichever side of zero it fell (the verdict calls it flat, below).
    expect(rate(0.04).kind).toBe("slower");
    expect(rate(-0.04).kind).toBe("slower");
  });

  it("flat this week: 0.0, or within 0.2 lb against the plan, is noise — a note, not a warning", () => {
    expect(FLAT_MAX_LB).toBe(0.2);
    expect(verdict(0.1)).toEqual({
      kind: "flat",
      tone: "info",
      title: "Flat this week",
      detail: "+0.1 lb against −1.5 lb",
      text: "Flat this week · +0.1 lb against −1.5 lb",
    });
    // The rule itself still reads these as against the plan: only the verdict's wording softens.
    expect(rate(0.06).kind).toBe("wrong-way"); // prints as +0.1
    expect(verdict(0.06).text).toBe("Flat this week · +0.1 lb against −1.5 lb");
    // Up to what prints as 0.2…
    expect(verdict(0.2)).toMatchObject({ kind: "flat", tone: "info", text: "Flat this week · +0.2 lb against −1.5 lb" });
    expect(verdict(0.24)).toMatchObject({ kind: "flat", text: "Flat this week · +0.2 lb against −1.5 lb" });
    // …and a week that prints as 0.0, from either side.
    expect(verdict(0.04)).toMatchObject({ kind: "flat", tone: "info", text: "Flat this week · 0.0 lb against −1.5 lb" });
    expect(verdict(-0.04).text).toBe("Flat this week · 0.0 lb against −1.5 lb");
    // A build, slipping a touch.
    expect(verdict(-0.2, build)).toMatchObject({ kind: "flat", tone: "info", text: "Flat this week · −0.2 lb against +0.8 lb" });
  });

  it("wrong direction: against the plan by more than 0.2 lb, a warning", () => {
    // 0.25 prints as +0.3: the first change past flat.
    expect(verdict(0.25)).toMatchObject({ kind: "wrong-way", tone: "warn", text: "Wrong direction · +0.3 lb this week against −1.5 lb" });
    expect(verdict(0.6)).toMatchObject({ kind: "wrong-way", tone: "warn", text: "Wrong direction · +0.6 lb this week against −1.5 lb" });
    expect(verdict(-0.5, build).text).toBe("Wrong direction · −0.5 lb this week against +0.8 lb");
    expect(verdict(-0.3, build)).toMatchObject({ kind: "wrong-way", tone: "warn" });
    // …and past the limit for that direction, it says so.
    expect(verdict(1.2).text).toBe("Wrong direction · +1.2 lb this week against −1.5 lb, past your 0.5% weekly limit");
    expect(rate(1.2).overLimit).toEqual({ direction: "gain", limitPct: 0.5 });
  });

  it("a change past a limit is never flat, however small it prints", () => {
    // A 0.05% gain limit: +0.2 lb at 200 lb is 0.1%/week, twice it.
    const tight = weeklyRate({
      trendWeight: 200.2,
      weekAgoTrendWeight: 200,
      loggedCount: 30,
      plan: cut,
      limits: { maxLossPctPerWeek: 1, maxGainPctPerWeek: 0.05 },
    });
    expect(weeklyVerdict({ rate: tight })).toMatchObject({
      kind: "wrong-way",
      tone: "warn",
      text: "Wrong direction · +0.2 lb this week against −1.5 lb, past your 0.05% weekly limit",
    });
  });

  it("faster than plan, within the limit: more than 1.5× the plan, a note", () => {
    const gentle = { direction: "lose", rateLbPerWeek: -0.5 } as const;
    expect(FASTER_THAN_PLAN_SHARE).toBe(1.5);
    expect(verdict(-1.9, gentle)).toEqual({
      kind: "faster",
      tone: "info",
      title: "Faster than plan",
      detail: "−1.9 lb this week against −0.5 lb",
      text: "Faster than plan · −1.9 lb this week against −0.5 lb",
    });
    // The rule (and the on-rate insight) still has it on plan.
    expect(rate(-1.9, gentle)).toMatchObject({ kind: "on-plan", overLimit: null });
    // Exactly 1.5× is still on plan; a hair more is faster.
    expect(verdict(-0.75, gentle)).toMatchObject({ kind: "on-plan", tone: "good", text: "On plan · −0.8 lb this week against −0.5 lb" });
    expect(verdict(-0.76, gentle)).toMatchObject({ kind: "faster", tone: "info" });
    expect(verdict(-1.9)).toMatchObject({ kind: "on-plan", tone: "good" }); // 1.9 against 1.5: within 1.5×
    // A build: +0.8 against +0.5 (the 0.5% limit is 1 lb here).
    expect(verdict(0.8, { direction: "gain", rateLbPerWeek: 0.5 })).toMatchObject({
      kind: "faster",
      tone: "info",
      text: "Faster than plan · +0.8 lb this week against +0.5 lb",
    });
  });

  it("faster than plan, past the safety limit: a warning that names the limit", () => {
    expect(verdict(-2.4)).toMatchObject({
      kind: "faster",
      tone: "warn",
      text: "Faster than plan · −2.4 lb this week against −1.5 lb, past your 1% weekly limit",
    });
    expect(rate(-2.4)).toMatchObject({ kind: "faster", overLimit: { direction: "loss", limitPct: 1 } });
    expect(verdict(1.2, build).text).toBe("Faster than plan · +1.2 lb this week against +0.8 lb, past your 0.5% weekly limit");
    // The same week on a gentle plan: the band's note turns into the warning.
    expect(verdict(-2.4, { direction: "lose", rateLbPerWeek: -0.5 })).toMatchObject({
      kind: "faster",
      tone: "warn",
      text: "Faster than plan · −2.4 lb this week against −0.5 lb, past your 1% weekly limit",
    });
  });

  it("the limits are exclusive: exactly at one is not past it", () => {
    // Loss: 1% of 200 lb is 2 lb.
    expect(rate(-2)).toMatchObject({ kind: "on-plan", overLimit: null });
    expect(rate(-2.01)).toMatchObject({ kind: "faster", overLimit: { direction: "loss", limitPct: 1 } });
    // Gain: 0.5% of 200 lb is 1 lb.
    expect(rate(1, build)).toMatchObject({ kind: "on-plan", overLimit: null });
    expect(rate(1.01, build)).toMatchObject({ kind: "faster", overLimit: { direction: "gain", limitPct: 0.5 } });
    expect(rate(1, hold).overLimit).toBeNull();
    expect(rate(1.01, hold).overLimit).toEqual({ direction: "gain", limitPct: 0.5 });
  });

  it("maintaining: no direction to judge, only the limits", () => {
    expect(verdict(0.2, hold)).toMatchObject({ kind: "maintaining", tone: "info", text: "Maintaining · trend +0.2 lb this week" });
    expect(verdict(-0.3, null).text).toBe("Maintaining · trend −0.3 lb this week");
    // Exactly at the limit is still calm.
    expect(verdict(-2, hold)).toMatchObject({ kind: "maintaining", tone: "info", text: "Maintaining · trend −2.0 lb this week" });
    // A maintenance plan plans no change, whatever rate it carries.
    const odd = { direction: "maintain", rateLbPerWeek: -0.7 } as const;
    expect(rate(-0.7, odd)).toMatchObject({ kind: "maintaining", planLb: 0 });
    expect(rate(0.7, odd).kind).toBe("maintaining");
    expect(verdict(0.7, odd).text).toBe("Maintaining · trend +0.7 lb this week");
  });

  it("drifting: holding, with the trend past a safety limit — never a calm 'Maintaining'", () => {
    expect(verdict(-2.4, hold)).toEqual({
      kind: "drifting",
      tone: "warn",
      title: "Drifting",
      detail: "trend −2.4 lb this week, past your 1% weekly limit",
      text: "Drifting · trend −2.4 lb this week, past your 1% weekly limit",
    });
    // The rule's kind is unchanged: the insights read `overLimit`, not the verdict.
    expect(rate(-2.4, hold)).toMatchObject({ kind: "maintaining", overLimit: { direction: "loss", limitPct: 1 } });
    expect(verdict(1.2, null)).toMatchObject({
      kind: "drifting",
      tone: "warn",
      text: "Drifting · trend +1.2 lb this week, past your 0.5% weekly limit",
    });
  });

  it("not enough data yet: under 10 logged days, or no trend a week apart", () => {
    expect(verdict(-1.3, cut, 6)).toMatchObject({
      kind: "no-data",
      tone: "info",
      text: "Not enough data yet · the trend is judged after 10 logged days (6 so far)",
    });
    // The change is still known (the Trend weight tile shows it); it just isn't judged, nor flagged.
    expect(rate(-3, cut, 9)).toMatchObject({ kind: "no-data", overLimit: null });
    expect(rate(-3, cut, 9).changeLb).toBeCloseTo(-3);
    expect(rate(-1.3, cut, 10).kind).toBe("on-plan");
    // Nor softened or sharpened: a flat or a drifting week under 10 days only says it's early.
    expect(verdict(0.1, cut, 9).kind).toBe("no-data");
    expect(verdict(-3, hold, 9)).toMatchObject({ kind: "no-data", tone: "info" });
    const noTrend = weeklyRate({ trendWeight: 200, weekAgoTrendWeight: null, loggedCount: 30, plan: cut, limits });
    expect(noTrend).toMatchObject({ kind: "no-data", changeLb: null, pctPerWeek: null });
    expect(weeklyVerdict({ rate: noTrend }).text).toBe("Not enough data yet · it takes trend weights a week apart");
  });

  it("is the rule behind both the check-in's verdict and the rate insights", () => {
    const goal = { targetLb: 180, pacePctPerWeek: 1, setOn: addDays(today, -30), startLb: 205 };
    const onPlan = buildModel(
      data(
        daysBefore(21, (i) => ({ weightLb: 205 - i * 0.25, calories: 2500 })),
        { settings: { ...settings, weightGoal: goal } },
      ),
      today,
    );
    expect(onPlan.checkin.rate).toMatchObject({ kind: "on-plan", overLimit: null, loggedCount: 21 });
    expect(onPlan.checkin.rate.changeLb).toBe(onPlan.checkin.weightChangeLb);
    expect(onPlan.checkin.rate.planLb).toBe(onPlan.checkin.targetRateLbPerWeek);
    expect(onPlan.insights.map((i) => i.key)).toContain("on-rate");
    expect(weeklyVerdict(onPlan.checkin)).toMatchObject({ kind: "on-plan", tone: "good" });
    expect(weeklyVerdict(onPlan.checkin).text).toMatch(/^On plan · −1\.\d lb this week against −\d\.\d lb$/);

    // No goal, dropping a pound a day: maintaining on paper, past the loss limit — the verdict says drifting.
    const fast = buildModel(data(daysBefore(21, (i) => ({ weightLb: 230 - i, calories: 2500 }))), today);
    expect(fast.checkin.rate).toMatchObject({ kind: "maintaining", overLimit: { direction: "loss", limitPct: 1 } });
    expect(fast.insights.map((i) => i.key)).toContain("loss-fast");
    expect(weeklyVerdict(fast.checkin)).toMatchObject({ kind: "drifting", tone: "warn" });

    // Eight logged days: neither speaks.
    const early = buildModel(data(daysBefore(8, (i) => ({ weightLb: 230 - i, calories: 2500 }))), today);
    expect(early.checkin.rate.kind).toBe("no-data");
    expect(early.insights.map((i) => i.key)).not.toContain("loss-fast");
    expect(weeklyVerdict(early.checkin).text).toBe("Not enough data yet · the trend is judged after 10 logged days (8 so far)");
  });

  it("faster than plan inside the limit: the verdict says so, and the on-rate insight says 'ahead of plan' as a note", () => {
    // A gentle cut (0.25%/week, about 0.5 lb) with the trend dropping ~1.2 lb a week: inside the 1% limit.
    const goal = { targetLb: 180, pacePctPerWeek: 0.25, setOn: addDays(today, -30), startLb: 205 };
    const model = buildModel(
      data(
        daysBefore(21, (i) => ({ weightLb: 205 - i * 0.17, calories: 2500 })),
        { settings: { ...settings, weightGoal: goal } },
      ),
      today,
    );
    expect(model.checkin.rate).toMatchObject({ kind: "on-plan", overLimit: null });
    expect(weeklyVerdict(model.checkin)).toMatchObject({ kind: "faster", tone: "info" });
    const insight = model.insights.find((i) => i.key === "on-rate")!;
    expect(insight.tone).toBe("info");
    expect(insight.text).toMatch(/ahead of plan\.$/);
  });
});

describe("the minimum calorie target across the model", () => {
  const withMinimum = (s: Settings, minCalories: number): Settings => ({ ...s, limits: { ...s.limits, minCalories } });

  describe("a pace the minimum holds back (a 2,000 kcal TDEE, cutting at 1%/week)", () => {
    // Thirty days eating 1,500 and losing a steady 1 lb/week: a 2,000 kcal TDEE. The pace asks for
    // 1.9 lb/week, which would be about 1,040 kcal.
    const goal = { targetLb: 170, pacePctPerWeek: 1, setOn: addDays(today, -30), startLb: 195 };
    const days = daysBefore(30, (i) => ({ weightLb: 195 - i / 7, calories: 1500 }));
    const held = buildModel(data(days, { settings: { ...settings, weightGoal: goal } }), today);
    const unheld = buildModel(data(days, { settings: withMinimum({ ...settings, weightGoal: goal }, 800) }), today);

    it("holds today's target, next week's and each past day's at the minimum", () => {
      expect(unheld.targets.recommendation).toMatchObject({ calories: 1040, floored: false });
      expect(held.targets.recommendation).toMatchObject({ direction: "lose", calories: 1500, floored: true, minCalories: 1500 });
      expect(held.checkin.next).toMatchObject({ calories: 1500, floored: true });
      // Adherence: each day against the target it showed, which was the held one.
      expect(held.checkin.calorieAdherence).toBe(1);
      expect(unheld.checkin.calorieAdherence).toBe(0);
    });

    it("plans the rate the held target is built for, so a week at the minimum is on plan, not slower than it", () => {
      expect(unheld.checkin.targetRateLbPerWeek).toBeCloseTo(-1.91, 1);
      expect(weeklyVerdict(unheld.checkin).text).toBe("Slower than plan · −1.0 lb this week against −1.9 lb");

      expect(held.targets.recommendation!.rateLbPerWeek).toBeCloseTo(-1);
      expect(held.checkin.targetRateLbPerWeek).toBeCloseTo(-1);
      expect(weeklyVerdict(held.checkin)).toMatchObject({
        kind: "on-plan",
        tone: "good",
        text: "On plan · −1.0 lb this week against −1.0 lb",
      });
      expect(held.insights.find((i) => i.key === "on-rate")).toMatchObject({ tone: "good" });
      expect(unheld.insights.find((i) => i.key === "on-rate")).toBeUndefined();
    });

    it("projects the goal at the observed trend alone: no date at a pace the target isn't built for", () => {
      expect(unheld.checkin.projection!.atPace!.weeks).toBeCloseTo(11.7, 1);
      const p = held.checkin.projection!;
      expect(p.atPace).toBeNull();
      expect(p.observed).toEqual(unheld.checkin.projection!.observed);
      expect(p.range).toEqual([p.observed!.date, p.observed!.date]);
    });
  });

  describe("a minimum a few kcal under the TDEE: on hold, on every screen", () => {
    // Forty flat days at 190 lb eating 1,510: a 1,510 kcal TDEE, ten over the minimum (0.02 lb/week).
    const goal = { targetLb: 180, pacePctPerWeek: 0.75, setOn: addDays(today, -40), startLb: 200 };
    const s = { ...settings, weightGoal: goal };
    const flat = daysBefore(40, () => ({ weightLb: 190, calories: 1510 }));
    const model = buildModel(data(flat, { settings: s }), today);
    const rec = model.targets.recommendation!;
    /** The week `changeLb` from 190 lb, judged against that plan. */
    const week = (changeLb: number) =>
      weeklyVerdict({
        rate: weeklyRate({ trendWeight: 190 + changeLb, weekAgoTrendWeight: 190, loggedCount: 30, plan: rec, limits: s.limits }),
      });

    it("is a plan of exactly 0: what Today and Goals call on hold", () => {
      expect(model.targets.tdee!.value).toBeCloseTo(1510, 5);
      expect(rec).toMatchObject({ direction: "lose", floored: true, calories: 1500, rateLbPerWeek: 0, pacePctPerWeek: 0 });
      expect(isOnHold(rec)).toBe(true);
      expect(model.checkin.next).toMatchObject({ floored: true, rateLbPerWeek: 0 });
      expect(model.checkin.targetRateLbPerWeek).toBe(0);
    });

    it("so the check-in's plan is to hold: Maintaining, never a week against 0.0 lb", () => {
      expect(model.checkin.rate).toMatchObject({ kind: "maintaining", planLb: 0, held: true });
      expect(week(-0.6).text).toBe("Maintaining · trend −0.6 lb this week");
      expect(week(0.6)).toMatchObject({ kind: "maintaining", tone: "info", text: "Maintaining · trend +0.6 lb this week" });
      // Past a safety limit it is drifting, as for any plan to hold.
      expect(week(1.2)).toMatchObject({ kind: "drifting", tone: "warn" });
      for (const change of [-2.5, -0.6, -0.04, 0, 0.04, 0.6, 1.2]) expect(week(change).text).not.toMatch(/against|[−-]0\.0/);
    });

    it("and no goal date is projected at pace (it would be years out)", () => {
      expect(model.checkin.projection).toMatchObject({ direction: "lose", atPace: null, range: null });
    });

    it("one step further from the TDEE it is a cut again, on every screen at once", () => {
      // 1,530: 30 kcal over the minimum, 0.06 lb/week — prints as −0.1.
      const m = buildModel(
        data(
          daysBefore(40, () => ({ weightLb: 190, calories: 1530 })),
          { settings: s },
        ),
        today,
      );
      const r = m.targets.recommendation!;
      expect(r.floored).toBe(true);
      expect(r.rateLbPerWeek).toBeCloseTo(-0.06, 5);
      expect(isOnHold(r)).toBe(false);
      expect(m.checkin.rate.planLb).toBeCloseTo(-0.06, 5);
      expect(m.checkin.rate.kind).not.toBe("maintaining");
    });
  });

  describe("a held week is never fast because of the hold", () => {
    // 150 lb, cutting at 1 %/week on a 2,000 kcal TDEE: the pace asks 1,250. Held at 1,800 the plan is 0.4 lb/week.
    const goal = { targetLb: 130, pacePctPerWeek: 1, setOn: addDays(today, -40), startLb: 160 };
    const s = (min: number) => withMinimum({ ...settings, weightGoal: goal }, min);
    const plan = (min: number) => recommend(s(min), 2000, 150);
    const week = (changeLb: number, min: number) =>
      weeklyRate({ trendWeight: 150 + changeLb, weekAgoTrendWeight: 150, loggedCount: 30, plan: plan(min), limits: s(min).limits });

    it("far past the held rate, inside the safety limit: on plan, not faster", () => {
      expect(plan(1800)).toMatchObject({ floored: true, calories: 1800 });
      expect(plan(1800).rateLbPerWeek).toBeCloseTo(-0.4);
      const rate = week(-1.0, 1800); // 2.5 × the held plan
      expect(rate).toMatchObject({ kind: "on-plan", held: true, overLimit: null });
      expect(weeklyVerdict({ rate })).toMatchObject({ kind: "on-plan", tone: "good", text: "On plan · −1.0 lb this week against −0.4 lb" });
    });

    it("the same week against a plan of the same size the athlete chose herself is faster than plan", () => {
      // 0.4 lb/week as a pace (0.2667 %/week of 150 lb), nothing held.
      const own = { ...s(800), weightGoal: { ...goal, pacePctPerWeek: 0.4 / 1.5 } };
      const p = recommend(own, 2000, 150);
      expect(p.floored).toBe(false);
      expect(p.rateLbPerWeek).toBeCloseTo(-0.4);
      const rate = weeklyRate({ trendWeight: 149, weekAgoTrendWeight: 150, loggedCount: 30, plan: p, limits: own.limits });
      expect(rate.held).toBe(false);
      expect(weeklyVerdict({ rate })).toMatchObject({ kind: "faster", tone: "info" });
    });

    it("only the safety limit calls a held week fast, as a warning", () => {
      const rate = week(-1.8, 1800); // 1.2 % of 150 lb, past the 1 % limit
      expect(rate).toMatchObject({ kind: "faster", held: true, overLimit: { direction: "loss", limitPct: 1 } });
      expect(weeklyVerdict({ rate })).toMatchObject({
        kind: "faster",
        tone: "warn",
        text: "Faster than plan · −1.8 lb this week against −0.4 lb, past your 1% weekly limit",
      });
    });

    it("is still slower, flat or the wrong way when it is", () => {
      expect(weeklyVerdict({ rate: week(-0.2, 1800) }).kind).toBe("slower");
      expect(weeklyVerdict({ rate: week(0.1, 1800) }).kind).toBe("flat");
      expect(weeklyVerdict({ rate: week(0.6, 1800) })).toMatchObject({ kind: "wrong-way", tone: "warn" });
    });

    it("Today's signal agrees: right on plan, not ahead of it", () => {
      // Falling 1 lb/week at 1,500 kcal: a 2,000 kcal TDEE. Held at 1,800 the plan is 0.4 lb/week.
      const days = daysBefore(40, (i) => ({ weightLb: Math.round((156 - i / 7) * 100) / 100, calories: 1500 }));
      const signal = (min: number, pacePctPerWeek = 1) =>
        buildModel(data(days, { settings: { ...s(min), weightGoal: { ...goal, pacePctPerWeek } } }), today);
      const held = signal(1800);
      expect(held.targets.recommendation).toMatchObject({ floored: true, calories: 1800 });
      expect(weeklyVerdict(held.checkin)).toMatchObject({ kind: "on-plan", tone: "good" });
      expect(held.insights.find((i) => i.key === "on-rate")).toMatchObject({
        tone: "good",
        text: expect.stringMatching(/right on plan\.$/),
      });
      // A pace of that size chosen by the athlete, nothing held: ahead of plan, a note.
      const own = signal(800, 0.27);
      expect(own.targets.recommendation!.floored).toBe(false);
      expect(weeklyVerdict(own.checkin).kind).toBe("faster");
      expect(own.insights.find((i) => i.key === "on-rate")).toMatchObject({
        tone: "info",
        text: expect.stringMatching(/ahead of plan\.$/),
      });
    });
  });

  describe("a plan of a tenth of a pound and a week that prints as 0.0", () => {
    // Held 30 kcal under the TDEE: 0.06 lb/week. A week of −0.04 lb is two thirds of it.
    const goal = { targetLb: 180, pacePctPerWeek: 0.75, setOn: addDays(today, -40), startLb: 200 };
    const s = { ...settings, weightGoal: goal };
    const plan = recommend(s, 1530, 190);
    const rate = weeklyRate({ trendWeight: 189.96, weekAgoTrendWeight: 190, loggedCount: 30, plan, limits: s.limits });

    it("is flat in the verdict, with no sign on the zero", () => {
      expect(rate.kind).toBe("on-plan");
      expect(weeklyVerdict({ rate })).toMatchObject({ kind: "flat", tone: "info", text: "Flat this week · 0.0 lb against −0.1 lb" });
    });

    it("and Today has no rate signal for it (never 'Trend moved -0.0 lb')", () => {
      // The same through the model, with a plan that small whatever the TDEE does: a pace of 0.06 lb/week.
      // Flat at 190 lb, then 0.2 lb lighter yesterday: the trend moved −0.04 lb, two thirds of the plan.
      const tiny = { ...settings, weightGoal: { ...goal, pacePctPerWeek: (0.06 / 190) * 100 } };
      const days = daysBefore(40, (i) => ({ weightLb: i === 39 ? 189.8 : 190, calories: 2600 }));
      const m = buildModel(data(days, { settings: tiny }), today);
      expect(m.checkin.weightChangeLb).toBeCloseTo(-0.04, 5);
      expect(m.checkin.rate).toMatchObject({ kind: "on-plan", held: false });
      expect(weeklyVerdict(m.checkin).text).toBe("Flat this week · 0.0 lb against −0.1 lb");
      expect(m.insights.find((i) => i.key === "on-rate")).toBeUndefined();
      for (const i of m.insights) expect(i.text).not.toMatch(/[−-]0\.0/);
      // A week that prints (−0.1 lb, still on plan) does get its signal.
      const more = daysBefore(40, (i) => ({ weightLb: i === 39 ? 189.6 : 190, calories: 2600 }));
      expect(buildModel(data(more, { settings: tiny }), today).insights.find((i) => i.key === "on-rate")).toBeDefined();
    });
  });

  describe("a scale jump that collapses the TDEE estimate (8 lb overnight)", () => {
    const goal = { targetLb: 185, pacePctPerWeek: 1, setOn: addDays(today, -30), startLb: 200 };
    const days = daysBefore(30, (i) => ({ weightLb: i === 29 ? 208 : 200, calories: 2600 }));
    const model = buildModel(data(days, { settings: { ...settings, weightGoal: goal } }), today);

    it("is caught by the minimum", () => {
      expect(model.targets.tdee!.value).toBeLessThan(1500); // 2,600 the day before
      expect(model.targets.recommendation).toMatchObject({ direction: "lose", calories: 1500, floored: true, rateLbPerWeek: 0 });
      // Protein and fat for the day still come out of the held 1,500.
      expect(model.targets.recommendation!.macros).toMatchObject({ proteinG: 202, fatG: 71, carbsG: 13 });
      // Without it (the lowest minimum the settings allow): under 1,000 kcal.
      const low = buildModel(data(days, { settings: withMinimum({ ...settings, weightGoal: goal }, 800) }), today);
      expect(low.targets.recommendation!.calories).toBe(800);
    });

    it("judges the week as holding (there is no deficit to be behind on) and offers no date at pace", () => {
      expect(model.checkin.rate).toMatchObject({ kind: "maintaining", planLb: 0 });
      expect(model.checkin.targetRateLbPerWeek).toBe(0);
      expect(model.checkin.projection).toMatchObject({ direction: "lose", atPace: null, range: null });
    });
  });

  it("holds the first day's target too (no history: the starting estimate)", () => {
    const first = data([{ ...emptyDayLog(today), weightLb: 120 }], {
      settings: { ...settings, weightGoal: { targetLb: 110, pacePctPerWeek: 1, setOn: today, startLb: 120 } },
    });
    // 15 kcal/lb × 120 = 1,800; 1.2 lb/week off that is 1,200.
    expect(buildModel(first, today).targets.recommendation).toMatchObject({ calories: 1500, floored: true });
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

  it("totals only the days the Zone 2 count counts (planned and done)", () => {
    // Default plan: Mon-Fri. The week is Tue 11-24 .. Mon 11-30.
    const week = daysBefore(7, (i) => ({
      zone2Done: i !== 1, // Wed not done
      zone2Minutes: i !== 1 ? 30 : null,
      zone2Kcal: 300 + i, // Tue 300, Wed 301 (not done), Thu 302, Fri 303, Sat 304 / Sun 305 (unplanned), Mon 306
    }));
    const series = computeEnergySeries(week, addDays(today, -120), today, 3500);
    const c = weeklyCheckin(data(week), series, today);
    expect(c.zone2).toEqual({ planned: 5, done: 4 });
    expect(c.zone2Kcal).toBe(300 + 302 + 303 + 306);
    // Only readings from days not counted: none.
    const notCounted = week.map((d, i) => (i === 1 || i === 4 || i === 5 ? d : { ...d, zone2Kcal: null }));
    expect(weeklyCheckin(data(notCounted), series, today).zone2Kcal).toBeNull();
  });
});
