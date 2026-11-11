/**
 * Progress → Week, on its own: the verdict's tone as rendered (the icon and the colour that go with
 * each wording, SPEC §4.6) and the check-in's tiles — the plan rate, the done/planned counts, "Next
 * week" and the calibration strip.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../../../shared/defaults";
import { CALIBRATION_DAYS } from "../../../shared/energy";
import type { AppData } from "../../../shared/gamify";
import { weeklyRate, type WeeklyCheckin } from "../../../shared/insights";
import { recommend } from "../../../shared/nutrition";
import { WeekView } from "./WeekView";

vi.mock("../Toast", () => ({ useToast: () => ({ show: vi.fn(() => 1), dismiss: vi.fn() }) }));

const TODAY = "2026-11-03";
const settings = {
  ...defaultSettings({ bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 }, "2026-10-01"),
  onboarded: true,
};
const data = { settings, days: [], exercises: [], maxEntries: [], sessions: [], seenAchievements: [] } as unknown as AppData;
const limits = { maxLossPctPerWeek: 1, maxGainPctPerWeek: 0.5 };
type Plan = Parameters<typeof weeklyRate>[0]["plan"];
const cut: Plan = { direction: "lose", rateLbPerWeek: -1.5 };
const hold: Plan = { direction: "maintain", rateLbPerWeek: 0 };

/** A week that moved the trend by `changeLb` from 200 lb, judged against `plan`. */
const rate = (changeLb: number, plan: Plan = cut, loggedCount = 30) =>
  weeklyRate({ trendWeight: 200 + changeLb, weekAgoTrendWeight: 200, loggedCount, plan, limits });

const checkin = (patch: Partial<WeeklyCheckin> = {}): WeeklyCheckin => ({
  from: "2026-10-27",
  to: "2026-11-02",
  tdee: { value: 2800, measured: 2800, prior: 3000, provisional: false, confidence: 1 },
  trendWeight: 198.7,
  weightChangeLb: -1.3,
  targetRateLbPerWeek: -1.5,
  rate: rate(-1.3),
  daysLogged: 7,
  avgCalories: 2100,
  avgProtein: 180,
  calorieAdherence: 6 / 7,
  avgSteps: 9000,
  zone2: { done: 2, planned: 3 },
  zone2Kcal: null,
  metcon: { done: 2, planned: 2 },
  lifts: { done: 3, planned: 4 },
  avgSleepMinutes: 430,
  avgHrv: 60,
  avgRestingHr: null,
  vo2Max: null,
  next: recommend(settings, 2800, 198.7),
  projection: null,
  ...patch,
});

/** A cut at 1%/week from 198.7 lb: about 2 lb/week, 1,000 kcal/day under the TDEE. */
const cutting = { ...settings, weightGoal: { targetLb: 180, pacePctPerWeek: 1, setOn: "2026-10-01", startLb: 200 } };

const show = (c: WeeklyCheckin, loggedCount = 30) => render(<WeekView data={data} today={TODAY} checkin={c} loggedCount={loggedCount} />);
const verdict = () => document.querySelector<HTMLElement>("[data-verdict]")!;
const tile = (label: string) => screen.getByText(label, { exact: true }).parentElement!;

describe("WeekView: the verdict's tone, as rendered", () => {
  // Each wording with the icon and the colour that carry its tone (lucide names its icons in a class).
  const ICON = {
    good: { icon: "lucide-circle-check", colour: "text-accent" },
    warn: { icon: "lucide-triangle-alert", colour: "text-warn" },
    info: { icon: "lucide-circle-dashed", colour: "text-mute" },
  } as const;
  const cases: Array<[name: string, c: WeeklyCheckin, kind: string, tone: keyof typeof ICON, text: string]> = [
    ["on plan", checkin({ rate: rate(-1.3) }), "on-plan", "good", "On plan · −1.3 lb this week against −1.5 lb"],
    ["slower", checkin({ rate: rate(-0.4) }), "slower", "info", "Slower than plan · −0.4 lb this week against −1.5 lb"],
    ["flat", checkin({ rate: rate(0.1) }), "flat", "info", "Flat this week · +0.1 lb against −1.5 lb"],
    ["wrong direction", checkin({ rate: rate(0.6) }), "wrong-way", "warn", "Wrong direction · +0.6 lb this week against −1.5 lb"],
    [
      "faster, within the limit",
      checkin({ rate: rate(-1.9, { direction: "lose", rateLbPerWeek: -0.5 }) }),
      "faster",
      "info",
      "Faster than plan · −1.9 lb this week against −0.5 lb",
    ],
    [
      "faster, past the limit",
      checkin({ rate: rate(-2.4) }),
      "faster",
      "warn",
      "Faster than plan · −2.4 lb this week against −1.5 lb, past your 1% weekly limit",
    ],
    ["maintaining", checkin({ rate: rate(0.2, hold) }), "maintaining", "info", "Maintaining · Trend +0.2 lb this week"],
    ["drifting", checkin({ rate: rate(-2.4, hold) }), "drifting", "warn", "Drifting · Trend −2.4 lb this week, past your 1% weekly limit"],
    [
      "not enough data",
      checkin({ rate: rate(-1.3, cut, 6) }),
      "no-data",
      "info",
      "Not enough data yet · The trend is judged after 10 logged days (6 so far)",
    ],
  ];

  it.each(cases)("%s", (_name, c, kind, tone, text) => {
    show(c);
    const v = verdict();
    expect(v.getAttribute("data-verdict")).toBe(kind);
    expect(v.getAttribute("data-tone")).toBe(tone);
    // One icon, decorative, of the tone's shape and colour — the words say the same.
    const icons = v.querySelectorAll("svg");
    expect(icons).toHaveLength(1);
    const icon = icons[0]!;
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(icon.classList.contains(ICON[tone].icon)).toBe(true);
    expect(icon.classList.contains(ICON[tone].colour)).toBe(true);
    for (const other of Object.values(ICON))
      if (other !== ICON[tone]) {
        expect(icon.classList.contains(other.icon)).toBe(false);
        expect(icon.classList.contains(other.colour)).toBe(false);
      }
    // The title, a separator for screen readers, then the detail (its first letter capitalised in CSS).
    const [title, sep, detail] = [...v.querySelector("p")!.children] as HTMLElement[];
    const [wantTitle, wantDetail] = text.split(" · ") as [string, string];
    expect(title!.textContent).toBe(wantTitle);
    expect(sep!.className).toContain("sr-only");
    expect(detail!.textContent!.toLowerCase()).toBe(wantDetail.toLowerCase());
    expect(detail!.className).toContain("first-letter:uppercase");
  });
});

describe("WeekView: the tiles", () => {
  it("Trend weight: the week's change, and the plan's rate beside it when there is one", () => {
    const withPlan = show(checkin());
    expect(tile("Trend weight").textContent).toBe("Trend weight198.7lb−1.3 lb this week · plan −1.5");
    withPlan.unmount();
    // Maintaining (a rate of 0) or no recommendation yet: no plan beside the change.
    const holding = show(checkin({ targetRateLbPerWeek: 0, rate: rate(-1.3, hold) }));
    expect(tile("Trend weight").textContent).toBe("Trend weight198.7lb−1.3 lb this week");
    holding.unmount();
    const none = show(checkin({ targetRateLbPerWeek: null }));
    expect(tile("Trend weight").textContent).toBe("Trend weight198.7lb−1.3 lb this week");
    none.unmount();
    // A build's plan carries its sign.
    const build = show(checkin({ weightChangeLb: 0.7, targetRateLbPerWeek: 0.8 }));
    expect(tile("Trend weight").textContent).toBe("Trend weight198.7lb+0.7 lb this week · plan +0.8");
    build.unmount();
    show(checkin({ weightChangeLb: null }));
    expect(tile("Trend weight").textContent).toBe("Trend weight198.7lbneeds a week of data");
  });

  it("TDEE: says how far it is learned", () => {
    const learned = show(checkin());
    expect(tile("TDEE").textContent).toBe("TDEE2,800kcallearned from your logs");
    learned.unmount();
    const learning = show(checkin({ tdee: { value: 2700, measured: 2600, prior: 2800, provisional: true, confidence: 0.5 } }));
    expect(tile("TDEE").textContent).toBe("TDEE2,700kcalstill learning · 50% from your logs");
    learning.unmount();
    const estimate = show(checkin({ tdee: { value: 3000, measured: null, prior: 3000, provisional: true, confidence: 0 } }));
    expect(tile("TDEE").textContent).toBe("TDEE3,000kcalstarting estimate");
    estimate.unmount();
    show(checkin({ tdee: null }));
    expect(tile("TDEE").textContent).toBe("TDEE—kcal—");
  });

  it("Avg intake: adherence when days could be judged, else how many were logged", () => {
    const judged = show(checkin());
    expect(tile("Avg intake").textContent).toBe("Avg intake2,100kcal86% of days on target");
    judged.unmount();
    show(checkin({ calorieAdherence: null, daysLogged: 4 }));
    expect(tile("Avg intake").textContent).toBe("Avg intake2,100kcal4/7 days logged");
  });

  it("Lifts · Metcon · Zone 2: done of planned, with a check (and words) only for a week fully done", () => {
    show(checkin({ lifts: { done: 3, planned: 4 }, metcon: { done: 2, planned: 2 }, zone2: { done: 4, planned: 3 } }));
    const lifts = tile("Lifts");
    expect(lifts.textContent).toBe("Lifts3/4");
    expect(lifts.querySelector("svg")).toBeNull();
    expect(within(lifts).queryByText("all done")).toBeNull();
    // Met exactly: a check in the accent colour, hidden from screen readers, which hear "all done".
    const metcon = tile("Metcon");
    expect(metcon.textContent).toBe("Metcon2/2all done");
    const check = metcon.querySelector("svg")!;
    expect(check.classList.contains("lucide-check")).toBe(true);
    expect(check.classList.contains("text-accent")).toBe(true);
    expect(check.getAttribute("aria-hidden")).toBe("true");
    expect(within(metcon).getByText("all done").className).toContain("sr-only");
    // More than planned is met too.
    const zone2 = tile("Zone 2");
    expect(zone2.textContent).toBe("Zone 24/3all done");
    expect(zone2.querySelector("svg.lucide-check")).not.toBeNull();
  });

  it("nothing planned and nothing done is a dash and 'none planned', never 0/0 or a check", () => {
    show(checkin({ lifts: { done: 0, planned: 0 }, metcon: { done: 1, planned: 0 }, zone2: { done: 0, planned: 2 } }));
    const lifts = tile("Lifts");
    expect(lifts.textContent).toBe("Lifts—none planned");
    expect(lifts.querySelector("svg")).toBeNull();
    // Done without a plan: the count, no dash — and not "met" (nothing was planned).
    const metcon = tile("Metcon");
    expect(metcon.textContent).toBe("Metcon1/0");
    expect(metcon.querySelector("svg")).toBeNull();
    // Planned and not done: 0 of 2.
    expect(tile("Zone 2").textContent).toBe("Zone 20/2");
  });

  it("the counts' bars fill by done over planned, empty when nothing was planned", () => {
    show(checkin({ lifts: { done: 1, planned: 4 }, metcon: { done: 1, planned: 0 }, zone2: { done: 2, planned: 2 } }));
    const fill = (label: string) => (tile(label).querySelector("[data-severity], [style*=width]") as HTMLElement | null)?.style.width;
    expect(fill("Lifts")).toBe("25%");
    expect(fill("Metcon")).toBe("0%");
    expect(fill("Zone 2")).toBe("100%");
  });

  it("Next week: next week's calories and macros, once the week has a logged day", () => {
    const c = checkin();
    const shown = show(c);
    const card = screen.getByText("Next week").parentElement!;
    expect(card.textContent).toContain(`${c.next!.calories.toLocaleString("en-US")}kcal/day`);
    expect(card.textContent).toContain(`P ${c.next!.macros.proteinG}`);
    shown.unmount();
    // A recommendation but no logged day this week (a week off): the card waits.
    const off = show(checkin({ daysLogged: 0 }));
    expect(screen.queryByText("Next week")).toBeNull();
    // …though the check-in itself still shows (it has a TDEE).
    expect(verdict()).not.toBeNull();
    off.unmount();
    // One logged day is enough.
    const one = show(checkin({ daysLogged: 1 }));
    expect(screen.getByText("Next week")).toBeTruthy();
    one.unmount();
    show(checkin({ next: null }));
    expect(screen.queryByText("Next week")).toBeNull();
  });

  it("the calibration strip shows until the engine is calibrated, and not a day longer", () => {
    const early = show(checkin(), CALIBRATION_DAYS - 1);
    expect(screen.getByText("Calibrating").textContent).toBe(`Calibrating ${CALIBRATION_DAYS - 1}/${CALIBRATION_DAYS}`);
    early.unmount();
    show(checkin(), CALIBRATION_DAYS);
    expect(screen.queryByText("Calibrating")).toBeNull();
  });

  it("the first check-in's empty state: no verdict, no tiles, no share — only when there is neither a logged day nor a TDEE", () => {
    const empty = show(checkin({ daysLogged: 0, tdee: null, next: null }), 0);
    expect(screen.getByText(/Your first check-in builds itself/)).toBeTruthy();
    expect(document.querySelector("[data-verdict]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Share check-in" })).toBeNull();
    expect(screen.queryByText("TDEE")).toBeNull();
    empty.unmount();
    show(checkin({ daysLogged: 1, tdee: null, next: null }), 1);
    expect(screen.queryByText(/Your first check-in builds itself/)).toBeNull();
    expect(screen.getByRole("button", { name: "Share check-in" })).toBeTruthy();
  });
});

describe("WeekView: next week's target held at the minimum calorie target", () => {
  const nextWeek = () => screen.getByText("Next week").parentElement!;
  /** The check-in as `weeklyCheckin` builds it for a 2,000 kcal TDEE: the plan and the verdict come from `next`. */
  const held = (tdee = 2000, s = cutting) => {
    const next = recommend(s, tdee, 198.7);
    return checkin({ next, targetRateLbPerWeek: next.rateLbPerWeek, rate: rate(-1.0, next), projection: null });
  };

  it("says so in one quiet line under the number", () => {
    show(held());
    expect(nextWeek().textContent).toContain("1,500kcal/day");
    const note = nextWeek().querySelector<HTMLElement>("[data-floor-note]")!;
    expect(note.textContent).toBe("Held at your 1,500 kcal minimum.");
    expect(note.className).toContain("text-mute");
    expect(note.className).not.toMatch(/text-(warn|caution|gold|accent|faint)/);
    expect(note.querySelector("svg")).toBeNull();
  });

  it("judges the week against the rate the held target is built for: on plan, not slower than a pace it was held back from", () => {
    // 1,500 against a 2,000 kcal TDEE is 1 lb/week; the pace asked for about 2.
    show(held());
    expect(verdict().dataset.verdict).toBe("on-plan");
    expect(verdict().textContent).toBe("On plan · −1.0 lb this week against −1.0 lb");
    expect(tile("Trend weight").textContent).toContain("plan −1.0");
  });

  it("a cut on hold (a minimum a few kcal under the TDEE) is a plan to hold: Maintaining, and no plan beside the trend", () => {
    // 1,500 against a 1,510 TDEE: what is left of the rate prints as 0.0, so it is 0.
    const next = recommend(cutting, 1510, 198.7);
    expect(next).toMatchObject({ floored: true, rateLbPerWeek: 0 });
    show(checkin({ next, targetRateLbPerWeek: next.rateLbPerWeek, rate: rate(-1.3, next), projection: null }));
    expect(verdict().dataset.verdict).toBe("maintaining");
    expect(verdict().textContent).toBe("Maintaining · trend −1.3 lb this week");
    expect(tile("Trend weight").textContent).toBe("Trend weight198.7lb−1.3 lb this week");
    expect(document.body.textContent).not.toMatch(/plan|against|[−-]0\.0/);
    expect(nextWeek().querySelector("[data-floor-note]")!.textContent).toBe("Held at your 1,500 kcal minimum.");
  });

  it("a week far past the held rate is on plan, not faster than it: the hold made the plan small", () => {
    // Held at 1,500 on a 1,700 TDEE the plan is 0.4 lb/week; the week lost 1.3.
    const next = recommend(cutting, 1700, 198.7);
    show(checkin({ next, targetRateLbPerWeek: next.rateLbPerWeek, rate: rate(-1.3, next), projection: null }));
    expect(verdict().dataset.verdict).toBe("on-plan");
    expect(verdict().dataset.tone).toBe("good");
    expect(verdict().textContent).toBe("On plan · −1.3 lb this week against −0.4 lb");
  });

  it("a trend change that prints as zero has no sign", () => {
    show(checkin({ weightChangeLb: -0.04, rate: rate(-0.04) }));
    expect(tile("Trend weight").textContent).toBe("Trend weight198.7lb0.0 lb this week · plan −1.5");
  });

  it("names the athlete's own minimum", () => {
    show(held(2000, { ...cutting, limits: { ...cutting.limits, minCalories: 1250 } }));
    expect(nextWeek().querySelector("[data-floor-note]")!.textContent).toBe("Held at your 1,250 kcal minimum.");
  });

  it("says nothing while the target stands on its own", () => {
    show(checkin({ next: recommend(cutting, 2800, 198.7) }));
    expect(nextWeek().textContent).toContain("1,810kcal/day");
    expect(document.querySelector("[data-floor-note]")).toBeNull();
  });
});
