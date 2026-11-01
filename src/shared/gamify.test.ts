import { describe, expect, it } from "vitest";
import { addDays } from "./dates";
import { defaultSettings } from "./defaults";
import { computeEnergySeries } from "./energy";
import { achievements, checklist, isClosed, type AppData } from "./gamify";
import { buildModel } from "./insights";
import { emptyDayLog, type DayLog, type Exercise, type MaxEntry, type Settings } from "./schemas";

const ids = { bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 };
// The program's first cycle starts Monday 2026-11-02.
const settings: Settings = { ...defaultSettings(ids, "2026-11-01"), onboarded: true };
const exercises: Exercise[] = [{ id: 1, name: "Bench press", category: "primary", tracksMax: true, measure: "reps", archived: false }];
const today = "2026-12-31";

const appData = (patch: Partial<AppData> = {}): AppData => ({ settings, days: [], exercises, maxEntries: [], sessions: [], ...patch });
const find = (data: AppData, key: string) => achievements(data, today).find((a) => a.key === key);
const loggedDay = (date: string): DayLog => ({ ...emptyDayLog(date), weightLb: 200, calories: 3000 });
const weighIn = (date: string, weightLb: number): DayLog => ({ ...emptyDayLog(date), weightLb });
const fullDay = (date: string): DayLog => ({
  ...emptyDayLog(date),
  weightLb: 200,
  calories: 3000,
  steps: 16000,
  metconDone: true,
  zone2Done: true,
});

describe("before the program starts", () => {
  it("doesn't expect a lift on program weekdays before the first cycle", () => {
    const tuesdayBefore = checklist("2026-10-27", fullDay("2026-10-27"), undefined, settings);
    expect(tuesdayBefore.map((i) => i.key)).not.toContain("lift");
    expect(isClosed(tuesdayBefore)).toBe(true);
    expect(checklist("2026-11-03", fullDay("2026-11-03"), undefined, settings).map((i) => i.key)).toContain("lift");
  });

  it("only plans lifts from the program start in the weekly check-in", () => {
    // Week of Wed Oct 28 – Tue Nov 3: program weekdays Oct 28–30 come before the start.
    expect(buildModel(appData(), "2026-11-04").checkin.lifts).toEqual({ planned: 2, done: 0 });
  });
});

describe("max PR achievements", () => {
  const initial: MaxEntry = {
    id: 1,
    exerciseId: 1,
    date: "2026-11-01",
    valueLb: 315,
    source: "initial",
    note: null,
    createdAt: "2026-11-01T00:00:00Z",
  };
  const amrap = (id: number): MaxEntry => ({
    ...initial,
    id,
    date: "2026-11-02",
    valueLb: 318,
    source: "amrap",
    createdAt: "2026-11-02T18:00:00Z",
  });

  it("ignores the client's optimistic placeholder and keys the PR by the saved row", () => {
    const withTarget = { ...settings, strengthTargets: [{ id: "t1", exerciseId: 1, targetLb: 318, setOn: "2026-11-01" }] };
    const before = achievements(appData({ settings: withTarget, maxEntries: [initial] }), today);
    expect(achievements(appData({ settings: withTarget, maxEntries: [initial, amrap(-1)] }), today)).toEqual(before);

    const saved = achievements(appData({ settings: withTarget, maxEntries: [initial, amrap(42)] }), today).map((a) => a.key);
    expect(saved.filter((k) => k.startsWith("max-"))).toEqual(["max-42"]);
    expect(saved).toContain("target-t1");
  });
});

describe("calibration milestones", () => {
  it("awards the first TDEE reading on the first logged day that has a TDEE", () => {
    // 8 days apart: the day before's 7-day weight window is empty, so Nov 10 has no TDEE.
    // Nov 17 is 7 days after Nov 10 — inside the window.
    const days = [loggedDay("2026-11-02"), loggedDay("2026-11-10"), loggedDay("2026-11-17")];
    const data = appData({ days });
    expect(find(data, "calib-1")?.date).toBe("2026-11-02");
    expect(find(data, "calib-2")?.date).toBe("2026-11-17");
    expect(computeEnergySeries(days, "2026-11-02", "2026-11-17").find((d) => d.tdee !== null)?.date).toBe("2026-11-17");
  });

  it("awards it on consecutive logged days as before, and not at all without a TDEE", () => {
    expect(find(appData({ days: [loggedDay("2026-11-02"), loggedDay("2026-11-03")] }), "calib-2")?.date).toBe("2026-11-03");
    expect(find(appData({ days: [loggedDay("2026-11-02"), loggedDay("2026-11-20")] }), "calib-2")).toBeUndefined();
  });

  it("keeps the other milestones on the nth logged day", () => {
    const days = Array.from({ length: 14 }, (_, i) => loggedDay(addDays("2026-11-02", i * 2)));
    const data = appData({ days });
    expect(find(data, "calib-7")?.date).toBe(days[6]!.date);
    expect(find(data, "calib-14")?.date).toBe(days[13]!.date);
  });
});

describe("goal weight achievement", () => {
  const withGoal = (goal: NonNullable<Settings["weightGoal"]>) => ({ ...settings, weightGoal: goal });
  const goalReached = (data: AppData) => achievements(data, today).find((a) => a.key.startsWith("goal-"));

  it("doesn't fire a gain goal straight away when there's no weigh-in before it was set", () => {
    const goal = withGoal({ targetLb: 190, pacePctPerWeek: 0.5, setOn: "2026-11-10" });
    const days = [weighIn("2026-11-12", 180), weighIn("2026-11-20", 185)];
    expect(goalReached(appData({ settings: goal, days }))).toBeUndefined();
    expect(goalReached(appData({ settings: goal, days: [...days, weighIn("2026-12-20", 190.2)] }))?.date).toBe("2026-12-20");
  });

  it("takes the direction from the start weight recorded with the goal", () => {
    // A stale weigh-in above the target would otherwise make this build look like a cut.
    const goal = withGoal({ targetLb: 190, pacePctPerWeek: 0.5, setOn: "2026-11-10", startLb: 180 });
    const days = [weighIn("2026-09-01", 195), weighIn("2026-11-11", 181), weighIn("2026-12-01", 190)];
    expect(goalReached(appData({ settings: goal, days }))?.date).toBe("2026-12-01");
  });

  it("otherwise uses the latest weigh-in on or before the day the goal was set", () => {
    const goal = withGoal({ targetLb: 190, pacePctPerWeek: 1, setOn: "2026-11-10" });
    const days = [weighIn("2026-11-01", 180), weighIn("2026-11-10", 200), weighIn("2026-11-20", 195), weighIn("2026-12-05", 189.8)];
    expect(goalReached(appData({ settings: goal, days }))?.date).toBe("2026-12-05");
  });

  it("has no achievement without any weigh-in", () => {
    expect(goalReached(appData({ settings: withGoal({ targetLb: 190, pacePctPerWeek: 1, setOn: "2026-11-10" }) }))).toBeUndefined();
  });
});
