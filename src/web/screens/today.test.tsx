/**
 * Today, rendered whole: the Fuel section against the Zone 2 machine kcal reading (SPEC §3.5) — a
 * reading only: the day's calories, target, bars, macros and TDEE read exactly the same with or
 * without it — what Fuel says is left / over / eaten (§3.1), Signals under the header, and the
 * header's place in the program.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { addDays, dateRange } from "../../shared/dates";
import { defaultSettings } from "../../shared/defaults";
import { emptyDayLog } from "../../shared/empty";
import { streaks, type AppData } from "../../shared/gamify";
import { buildModel } from "../../shared/insights";
import { cycleLabel, type CyclePosition } from "../../shared/program";
import type { DayLog } from "../../shared/schemas";
import { cycleParts, TodayScreen } from "./Today";

const TODAY = "2026-11-03";
const store = vi.hoisted(() => ({ data: null as unknown as AppData }));
vi.mock("../lib/store", () => ({
  useData: () => ({ data: store.data, today: TODAY, model: buildModel(store.data, TODAY), streak: streaks(store.data, TODAY) }),
  useSaveDay: () => vi.fn(),
  usePendingDates: () => new Set<string>(),
  useSavedPulse: () => 0,
  useSyncInfo: () => ({ pending: 0, online: true }),
  useEditExercise: () => vi.fn(),
  useMarkSeen: () => vi.fn(),
}));
vi.mock("../components/Toast", () => ({ useToast: () => ({ show: vi.fn(() => 1), dismiss: vi.fn() }) }));

const settings = {
  ...defaultSettings({ bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 }, "2026-10-01"),
  onboarded: true,
};

/** Three weeks of weights and food up to today (today part-eaten, over target), with `zone2Kcal` on the Zone 2 days. */
const withReadings = (zone2Kcal: number | null): AppData =>
  ({
    settings,
    days: dateRange(addDays(TODAY, -21), TODAY).map((date): DayLog => ({
      ...emptyDayLog(date),
      weightLb: 200,
      calories: date === TODAY ? 3400 : 2800,
      proteinG: 180,
      carbsG: 300,
      fatG: 90,
      zone2Done: true,
      zone2Minutes: 30,
      zone2Kcal,
    })),
    exercises: [],
    maxEntries: [],
    sessions: [],
    seenAchievements: [],
  }) as AppData;

/** The Fuel section's text and every bar's fill, as rendered. */
function fuel(data: AppData) {
  store.data = data;
  const { container, unmount } = render(
    <MemoryRouter>
      <TodayScreen />
    </MemoryRouter>,
  );
  const heading = within(container).getByRole("heading", { name: "Fuel" });
  const section = heading.closest("section")!;
  const out = {
    text: section.textContent,
    bars: [...section.querySelectorAll("[style]")].map((el) => el.getAttribute("style")),
    html: section.innerHTML,
  };
  unmount();
  return out;
}

describe("Today's Fuel section with a Zone 2 machine reading", () => {
  it("reads the same with and without the reading (calories, target, bars, macros, TDEE)", () => {
    const without = fuel(withReadings(null));
    const withKcal = fuel(withReadings(900));
    // Sanity: the section is the real one, with today's intake, a target and its bars.
    expect(without.text).toContain("3,400");
    expect(without.text).toContain("Target");
    expect(without.text).toContain("TDEE");
    expect(without.bars.length).toBeGreaterThan(0);
    expect(withKcal.text).not.toContain("900");
    expect(withKcal.text).toBe(without.text);
    expect(withKcal.bars).toEqual(without.bars);
    expect(withKcal.html).toBe(without.html);
  });
});

/** Three weeks of steady logging up to yesterday, and `today` for today's log (nothing by default). */
const history = (today: Partial<DayLog> = {}, past: Partial<DayLog> = {}): AppData =>
  ({
    settings,
    days: dateRange(addDays(TODAY, -21), TODAY).map((date): DayLog => ({
      ...emptyDayLog(date),
      ...(date === TODAY ? today : { weightLb: 200, calories: 2800, proteinG: 180, carbsG: 300, fatG: 90, steps: 9000, ...past }),
    })),
    exercises: [],
    maxEntries: [],
    sessions: [],
    seenAchievements: [],
  }) as AppData;

/** Today (or `/day/:date`) as the app routes it. */
function renderDay(data: AppData, path = "/") {
  store.data = data;
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<TodayScreen />} />
        <Route path="/day/:date" element={<TodayScreen />} />
      </Routes>
    </MemoryRouter>,
  );
  const section = (name: string) => screen.getByRole("heading", { name }).closest("section")!;
  return { ...view, section };
}

const num = (text: string | null | undefined) => Number((text ?? "").replace(/[^\d.-]/g, ""));

describe("Today's Fuel: a target held at the minimum calorie target", () => {
  /** A cut at 1%/week (2 lb/week at 200 lb, 1,000 kcal/day under the TDEE), with `limits` on top. */
  const cutting = (limits: Partial<AppData["settings"]["limits"]> = {}): AppData["settings"] => ({
    ...settings,
    limits: { ...settings.limits, ...limits },
    weightGoal: { targetLb: 180, pacePctPerWeek: 1, setOn: addDays(TODAY, -21), startLb: 200 },
  });
  /** Three weeks at 200 lb eating `kcal` a day: a TDEE of `kcal`. */
  const eating = (kcal: number, s: AppData["settings"] = cutting()): AppData => ({ ...history({}, { calories: kcal }), settings: s });
  const target = (fuelSection: HTMLElement) => within(fuelSection).getByText("Target").parentElement!;
  const note = (el: HTMLElement) => el.querySelector<HTMLElement>("[data-floor-note]");

  it("shows the minimum as the target, with one quiet line saying so", () => {
    // A 1,900 kcal TDEE: the pace alone would be 900.
    const fuelSection = renderDay(eating(1900)).section("Fuel");
    expect(target(fuelSection).textContent).toBe("Target1,500kcalCut · −0.8 lb/wkHeld at your 1,500 kcal minimum.");
    expect(note(fuelSection)!.textContent).toBe("Held at your 1,500 kcal minimum.");
    // What is left to eat is counted from the held target.
    expect(fuelSection.querySelector("[data-fuel-side]")!.textContent).toBe("1,500 kcalleft");
  });

  it("is reassurance, not a warning: the page's muted text, no alert, no warning colour, no icon", () => {
    const fuelSection = renderDay(eating(1900)).section("Fuel");
    const line = note(fuelSection)!;
    expect(line.tagName).toBe("P");
    expect(line.className).toContain("text-mute");
    expect(line.className).not.toMatch(/text-(warn|caution|gold|accent|faint)/);
    expect(line.closest("[role=alert], [role=status]")).toBeNull();
    expect(line.querySelector("svg")).toBeNull();
  });

  it("gives the rate the held target is built for, not the pace it was held back from", () => {
    // 1,500 against 1,900 is 400 kcal/day: 0.8 lb/week, where the pace asked for 2.
    expect(target(renderDay(eating(1900)).section("Fuel")).textContent).toContain("Cut · −0.8 lb/wk");
  });

  it("says the cut is on hold when the minimum leaves no deficit (a collapsed TDEE estimate)", () => {
    const fuelSection = renderDay(eating(1400)).section("Fuel");
    expect(target(fuelSection).textContent).toBe("Target1,500kcalCut · on holdHeld at your 1,500 kcal minimum.");
  });

  it("builds the macro targets from the held calories", () => {
    // 200 g protein and 70 g fat are 1,430 kcal: 18 g of carbs fit under 1,500 (none would under 900).
    const fuelSection = renderDay(eating(1900)).section("Fuel");
    expect(within(fuelSection).getByText("Carbs").parentElement!.textContent).toContain("/ 18g");
  });

  it("says nothing while the target stands on its own: above the minimum, or exactly on it", () => {
    for (const kcal of [3000, 2500]) {
      const view = renderDay(eating(kcal));
      const fuelSection = view.section("Fuel");
      expect(target(fuelSection).textContent).toBe(`Target${(kcal - 1000).toLocaleString("en-US")}kcalCut · −2.0 lb/wk`);
      expect(note(fuelSection)).toBeNull();
      view.unmount();
    }
  });

  it("names the athlete's own minimum, and the default for settings stored before the field existed", () => {
    let view = renderDay(eating(1900, cutting({ minCalories: 1800 })));
    expect(note(view.section("Fuel"))!.textContent).toBe("Held at your 1,800 kcal minimum.");
    expect(target(view.section("Fuel")).textContent).toContain("Target1,800kcalCut · −0.2 lb/wk");
    view.unmount();

    const { minCalories: _m, ...legacyLimits } = settings.limits;
    view = renderDay(eating(1900, { ...cutting(), limits: legacyLimits }));
    expect(note(view.section("Fuel"))!.textContent).toBe("Held at your 1,500 kcal minimum.");
    view.unmount();

    // Lowered far enough, the pace's own number shows again.
    view = renderDay(eating(1900, cutting({ minCalories: 800 })));
    expect(target(view.section("Fuel")).textContent).toBe("Target900kcalCut · −2.0 lb/wk");
    expect(note(view.section("Fuel"))).toBeNull();
  });

  it("holds maintenance too, and a past day's target as it is recomputed", () => {
    let view = renderDay(eating(1300, settings));
    expect(target(view.section("Fuel")).textContent).toBe("Target1,500kcalMaintenanceHeld at your 1,500 kcal minimum.");
    view.unmount();

    view = renderDay(eating(1900), `/day/${addDays(TODAY, -2)}`);
    expect(target(view.section("Fuel")).textContent).toBe("Target1,500kcalCut · −0.8 lb/wkHeld at your 1,500 kcal minimum.");
  });
});

describe("Today's Fuel: what's left", () => {
  /** The day's calorie target, as shown. */
  const target = (fuelSection: HTMLElement) => num(within(fuelSection).getByText("Target").nextElementSibling!.firstChild!.textContent);
  const side = (fuelSection: HTMLElement) => fuelSection.querySelector<HTMLElement>("[data-fuel-side]")!;

  it("nothing logged yet: the whole target is left", () => {
    const fuelSection = renderDay(history()).section("Fuel");
    const kcal = target(fuelSection);
    expect(kcal).toBeGreaterThan(1500);
    expect(side(fuelSection).dataset.fuelSide).toBe("left");
    expect(side(fuelSection).textContent).toBe(`${kcal.toLocaleString("en-US")} kcalleft`);
    expect(fuelSection.querySelector("[data-fuel-eaten]")!.textContent).toBe("Nothing logged yet");
    expect(fuelSection.textContent).not.toContain("so far");
  });

  it("part-way through the day: target minus eaten is left, with what was eaten under the bar", () => {
    const fuelSection = renderDay(history({ weightLb: 200, calories: 1480 })).section("Fuel");
    const kcal = target(fuelSection);
    expect(side(fuelSection).dataset.fuelSide).toBe("left");
    expect(num(side(fuelSection).firstElementChild!.textContent)).toBe(kcal - 1480);
    expect(side(fuelSection).lastElementChild!.textContent).toBe("left");
    expect(fuelSection.querySelector("[data-fuel-eaten]")!.textContent).toBe("1,480 eaten");
    expect(fuelSection.textContent).not.toContain("over");
  });

  it("within the tolerance over the target it is 0 left, not over", () => {
    store.data = history();
    const kcal = buildModel(store.data, TODAY).targets.recommendation!.calories;
    const fuelSection = renderDay(history({ calories: Math.round(kcal * 1.03) })).section("Fuel");
    expect(side(fuelSection).dataset.fuelSide).toBe("left");
    expect(side(fuelSection).textContent).toBe("0 kcalleft");
    expect(fuelSection.querySelector('[data-severity="0"]')).not.toBeNull();
  });

  it("past the tolerance: the overage, in the bar's over-target colour and in words, once", () => {
    store.data = history();
    const kcal = buildModel(store.data, TODAY).targets.recommendation!.calories;
    const eaten = Math.round(kcal * 1.3);
    const fuelSection = renderDay(history({ calories: eaten })).section("Fuel");
    expect(target(fuelSection)).toBe(kcal);
    const block = side(fuelSection);
    expect(block.dataset.fuelSide).toBe("over");
    expect(block.textContent).toBe(`+${(eaten - kcal).toLocaleString("en-US")} kcalover`);
    // Same colour as the calorie bar (severity 1 at 30 % over), not colour alone ("over").
    const bar = fuelSection.querySelector<HTMLElement>("[data-severity]")!;
    expect(bar.dataset.severity).toBe("1");
    const number = block.firstElementChild as HTMLElement;
    expect(number.style.color).toBe("var(--color-warn)");
    expect(bar.style.backgroundColor).toBe("var(--color-warn)");
    expect(number.className).toContain("text-warn");
    expect(fuelSection.querySelector("[data-fuel-eaten]")!.textContent).toBe(`${eaten.toLocaleString("en-US")} eaten`);
    // The overage is said once: no "+N kcal over" note under the bar as well.
    expect(fuelSection.textContent).not.toContain("kcal over");
  });

  it("a past day keeps what was eaten (and its over note): left means nothing in hindsight", () => {
    const yesterday = addDays(TODAY, -1);
    const data = history();
    data.days.find((d) => d.date === yesterday)!.calories = 3600;
    const { section } = renderDay(data, `/day/${yesterday}`);
    const fuelSection = section("Fuel");
    expect(side(fuelSection).dataset.fuelSide).toBe("eaten");
    expect(side(fuelSection).textContent).toBe("3,600eaten");
    expect(fuelSection.querySelector("[data-fuel-eaten]")).toBeNull();
    expect(fuelSection.textContent).toMatch(/\+[\d,]+ kcal over/);
    expect(fuelSection.textContent).not.toContain("left");
  });
});

describe("Today's Signals", () => {
  it("sit right under the header, before Fuel: the most important one, the rest behind '+N more'", () => {
    const data = history({}, { steps: 9000, proteinG: 90 });
    const insights = buildModel(data, TODAY).insights;
    expect(insights.length).toBeGreaterThan(1);
    const { container, section } = renderDay(data);
    const signals = section("Signals");
    // Order on the page: h1, Signals, Fuel, the checklist, Journal.
    const headings = [...container.querySelectorAll("h1, h2")].map((h) => h.textContent);
    expect(headings).toEqual(["Today", "Signals", "Fuel", "Close the day", "Journal"]);
    // Collapsed: one line, the first by the model's order (warnings, notes, good news).
    let rows = within(signals).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dataset.tone).toBe(insights[0]!.tone);
    const toggle = within(signals).getByRole("button", {
      name: `+${insights.length - 1} more ${insights.length === 2 ? "signal" : "signals"}`,
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toBe(within(signals).getByRole("list"));

    fireEvent.click(toggle);
    rows = within(signals).getAllByRole("listitem");
    expect(rows.map((r) => r.dataset.tone)).toEqual(insights.map((i) => i.tone));
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toBe("Show less");
    fireEvent.click(toggle);
    expect(within(signals).getAllByRole("listitem")).toHaveLength(1);
  });

  it("render nothing when there are none, and not on a past day", () => {
    const quiet: AppData = { ...history(), days: [] };
    expect(buildModel(quiet, TODAY).insights).toEqual([]);
    const first = renderDay(quiet);
    expect(screen.queryByRole("heading", { name: "Signals" })).toBeNull();
    expect(first.container.querySelector("[data-signals]")).toBeNull();
    first.unmount();

    const data = history({}, { steps: 9000, proteinG: 90 });
    renderDay(data, `/day/${addDays(TODAY, -1)}`);
    expect(screen.queryByRole("heading", { name: "Signals" })).toBeNull();
  });
});

describe("Today's header", () => {
  it("places the day in the program in words, not codes", () => {
    // The first cycle starts on Monday 2026-10-05: Nov 3 is in its fifth week, the deload.
    const first = renderDay(history());
    const sub = () => screen.getByRole("heading", { level: 1 }).nextElementSibling!.textContent;
    expect(sub()).toMatch(/left to close the day · Deload week$/);
    first.unmount();
    renderDay(history(), `/day/${addDays(TODAY, -8)}`);
    expect(sub()).toMatch(/ · Week 4 of 5$/);
    expect(sub()).not.toMatch(/C1|W4/);
  });

  it("names the cycle from the second one on", () => {
    const earlier = { ...settings, program: { ...settings.program, cycleStartDate: addDays(settings.program.cycleStartDate, -35) } };
    renderDay({ ...history(), settings: earlier });
    expect(screen.getByRole("heading", { level: 1 }).nextElementSibling!.textContent).toMatch(/ · Cycle 2 · Deload week$/);
  });

  /** The subtitle's lines (each a block of its own), and in each the tail a narrow header drops. */
  const subtitle = () => {
    const p = document.querySelector<HTMLElement>("[data-day-sub]")!;
    const lines = [...p.children] as HTMLElement[];
    return {
      p,
      lines,
      // What a sighted reader sees: the screen-reader separator left out.
      text: lines.map((l) =>
        [...l.childNodes]
          .filter((n) => !(n instanceof HTMLElement && n.classList.contains("sr-only")))
          .map((n) => n.textContent)
          .join(""),
      ),
      tails: lines.map((l) => [...l.querySelectorAll<HTMLElement>("[class*='@max-[10.5rem]:hidden']")].map((t) => t.textContent)),
    };
  };

  it("is two lines that break at the separator: what is left of the day, then the place in the program", () => {
    // Cycle 2, week 1 of 5: the longest label ("6 left to close the day · Cycle 2 · Week 1 of 5" wrapped into three lines at 320 px).
    const cycle2 = { ...settings, program: { ...settings.program, cycleStartDate: addDays(TODAY, -36) } };
    renderDay({ ...history(), settings: cycle2 });
    const sub = subtitle();
    expect(sub.p).toBe(screen.getByRole("heading", { level: 1 }).nextElementSibling);
    expect(sub.lines).toHaveLength(2);
    for (const line of sub.lines) expect(line.classList.contains("block")).toBe(true);
    expect(sub.text[0]).toMatch(/^\d left to close the day$/);
    expect(sub.text[1]).toBe("Cycle 2 · Week 1 of 5");
    // No separator dangles at the end of the first line; a screen reader still gets one between the two.
    expect(sub.text[0]).not.toMatch(/·/);
    expect(sub.lines[1]!.firstElementChild!.className).toContain("sr-only");
    expect(sub.lines[1]!.firstElementChild!.textContent).toBe(" · ");
    expect(sub.p.textContent).toMatch(/^\d left to close the day · Cycle 2 · Week 1 of 5$/);
    // Where the column is narrow, each line drops its tail instead of wrapping: "6 left to close" / "Cycle 2 · Week 1".
    expect(sub.tails).toEqual([[" the day"], [" of 5"]]);
    // The header's text column is the container those tails answer to.
    expect(sub.p.parentElement!.className).toContain("@container");
  });

  it("a closed day: 'Day closed.' on its own line, 'Nicely done.' where there is room", () => {
    const closed: Partial<DayLog> = { weightLb: 200, calories: 2800, steps: 20000, zone2Done: true, metconDone: true };
    const restDay = { ...settings, program: { ...settings.program, days: {} } };
    renderDay({ ...history(closed), settings: restDay });
    const sub = subtitle();
    expect(sub.text[0]).toBe("Day closed. Nicely done.");
    expect(sub.tails[0]).toEqual([" Nicely done."]);
    expect(sub.lines[0]!.querySelector(".text-accent")!.textContent).toBe("Day closed. Nicely done.");
    expect(sub.text[1]).toBe("Deload week");
    expect(sub.tails[1]).toEqual([" week"]);
  });

  it("before the first cycle there is no second line", () => {
    const later = { ...settings, program: { ...settings.program, cycleStartDate: addDays(TODAY, 6) } };
    renderDay({ ...history(), settings: later });
    const sub = subtitle();
    expect(sub.lines).toHaveLength(1);
    expect(sub.p.textContent).toMatch(/^\d left to close the day$/);
  });
});

describe("cycleParts: the short label, and the tail of the full one", () => {
  const week = (deload = false) => ({ deload }) as CyclePosition["week"];
  const pos = (cycle: number, weekIndex: number, deload = false) => ({ cycle, weekIndex, week: week(deload) }) as CyclePosition;

  it("splits every shape of label so that short + rest is the full one", () => {
    expect(cycleParts(pos(1, 1), 5)).toEqual({ short: "Week 2", rest: " of 5" });
    expect(cycleParts(pos(1, 4, true), 5)).toEqual({ short: "Deload", rest: " week" });
    expect(cycleParts(pos(2, 0), 5)).toEqual({ short: "Cycle 2 · Week 1", rest: " of 5" });
    expect(cycleParts(pos(12, 4, true), 5)).toEqual({ short: "Cycle 12 · Deload", rest: " week" });
    for (const p of [pos(1, 0), pos(3, 2), pos(2, 4, true)]) {
      const { short, rest } = cycleParts(p, 5);
      expect(short + rest).toBe(cycleLabel(p, 5));
      expect(short).toBe(cycleLabel(p, 5, { short: true }));
    }
  });

  it("has no tail when the full label is already the short one", () => {
    // A week past the cycle's length is just "Week 7".
    expect(cycleParts(pos(1, 6), 5)).toEqual({ short: "Week 7", rest: "" });
  });
});
