import { afterEach, describe, expect, it, vi } from "vitest";
import type { WeeklyCheckin } from "../../../shared/insights";
import { checkinText, shareText, vo2Change } from "./shareCheckin";

const base: WeeklyCheckin = {
  from: "2026-10-26",
  to: "2026-11-01",
  tdee: { value: 2850, measured: 2860, prior: 2800, confidence: 1, provisional: false },
  trendWeight: 201.34,
  weightChangeLb: -0.8,
  targetRateLbPerWeek: -1,
  daysLogged: 7,
  avgCalories: 2310,
  avgProtein: 188,
  calorieAdherence: 0.71,
  avgSteps: 9820,
  zone2: { done: 1, planned: 2 },
  zone2Kcal: null,
  metcon: { done: 2, planned: 3 },
  lifts: { done: 3, planned: 4 },
  avgSleepMinutes: 440,
  avgHrv: 52,
  avgRestingHr: 48.4,
  vo2Max: { value: 52.3, date: "2026-11-01", change: 1.2, since: "2026-10-02", current: true },
  next: {
    direction: "lose",
    rateLbPerWeek: -1,
    pacePctPerWeek: -0.5,
    paceCapped: false,
    tdee: 2850,
    calories: 2400,
    macros: { proteinG: 200, carbsG: 220, fatG: 70 },
  },
  projection: {
    direction: "lose",
    remainingLb: 16,
    atPace: null,
    atLimit: null,
    observed: null,
    observedRateLbPerWeek: null,
    range: ["2026-12-19", "2027-01-08"],
  },
} as WeeklyCheckin;

describe("checkinText", () => {
  it("gives VO2 max without a change when there is nothing to compare it with", () => {
    const text = checkinText(
      { ...base, vo2Max: { value: 52, date: "2026-11-01", change: null, since: null, current: true } },
      { today: "2026-11-02" },
    );
    expect(text).toContain("\nVO2 max 52.0\n");
    expect(vo2Change({ value: 52, date: "2026-11-01", change: null, since: null, current: true })).toBe("as of Nov 1");
    expect(vo2Change({ value: 52, date: "2026-11-01", change: -0.5, since: "2026-10-05", current: true })).toBe("−0.5 since Oct 5");
  });

  it("dates a VO2 max from before the check-in week instead of showing its change as this week's", () => {
    const stale = { value: 50, date: "2026-08-20", change: 2, since: "2026-08-01", current: false };
    expect(vo2Change(stale)).toBe("as of Aug 20");
    expect(checkinText({ ...base, vo2Max: stale }, { today: "2026-11-02" })).toContain("\nVO2 max 50.0 (as of Aug 20)\n");
    expect(checkinText({ ...base, vo2Max: { ...stale, change: null, since: null } }, { today: "2026-11-02" })).toContain(
      "\nVO2 max 50.0 (as of Aug 20)\n",
    );
  });

  it("summarises what the check-in shows, one line per group", () => {
    expect(checkinText(base, { today: "2026-11-02", goalLb: 185 })).toBe(
      [
        "Strawvine check-in · Oct 26 – Nov 1",
        "TDEE 2,850 kcal · trend 201.3 lb (−0.8 this week, plan −1.0)",
        "Intake 2,310 kcal avg · 71% of days on target · protein 188 g",
        "Steps 9,820 avg · sleep 7h 20m · HRV 52 ms · resting HR 48 bpm",
        "VO2 max 52.3 (+1.2 since Oct 2)",
        "Lifts 3/4 · Metcon 2/3 · Zone 2 1/2",
        "Next week 2,400 kcal/day · P 200 · C 220 · F 70",
        "Goal 185 lb projected Dec 19 – Jan 8, 2027",
      ].join("\n"),
    );
  });

  it("adds the week's Zone 2 machine kcal to the Zone 2 count, once logged", () => {
    const text = checkinText({ ...base, zone2Kcal: 1240 }, { today: "2026-11-02" });
    expect(text).toContain("\nLifts 3/4 · Metcon 2/3 · Zone 2 1/2 (1,240 kcal on the machine)\n");
    // Not part of intake.
    expect(text).toContain("\nIntake 2,310 kcal avg · ");
  });

  it("drops what isn't known yet", () => {
    const text = checkinText(
      {
        ...base,
        tdee: null,
        weightChangeLb: null,
        calorieAdherence: null,
        avgProtein: null,
        avgSteps: null,
        avgSleepMinutes: null,
        avgHrv: null,
        avgRestingHr: null,
        vo2Max: null,
        daysLogged: 3,
        lifts: { done: 0, planned: 0 },
        next: null,
        projection: null,
      },
      { today: "2026-11-02", goalLb: null },
    );
    expect(text).toBe(
      ["Strawvine check-in · Oct 26 – Nov 1", "trend 201.3 lb", "Intake 2,310 kcal avg · 3/7 days logged", "Metcon 2/3 · Zone 2 1/2"].join(
        "\n",
      ),
    );
  });
});

describe("shareText", () => {
  afterEach(() => vi.unstubAllGlobals());
  const stub = (nav: Partial<Navigator>) => vi.stubGlobal("navigator", nav);

  it("uses the share sheet when there is one", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    stub({ share });
    expect(await shareText("hi", "t")).toBe("shared");
    expect(share).toHaveBeenCalledWith({ text: "hi", title: "t" });
  });

  it("treats a dismissed sheet as cancelled (no copy)", async () => {
    const writeText = vi.fn();
    stub({ share: vi.fn().mockRejectedValue(new DOMException("x", "AbortError")), clipboard: { writeText } as unknown as Clipboard });
    expect(await shareText("hi", "t")).toBe("cancelled");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("copies when sharing isn't available or fails", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stub({ clipboard: { writeText } as unknown as Clipboard });
    expect(await shareText("hi", "t")).toBe("copied");
    stub({ share: vi.fn().mockRejectedValue(new DOMException("x", "NotAllowedError")), clipboard: { writeText } as unknown as Clipboard });
    expect(await shareText("hi", "t")).toBe("copied");
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it("reports failure when copying fails too", async () => {
    stub({ clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } as unknown as Clipboard });
    expect(await shareText("hi", "t")).toBe("failed");
  });
});
