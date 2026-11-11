/**
 * Progress: five views behind a tablist (Week · Body · Fuel · Activity · Strength), the view kept in
 * the URL, one chart range across the chart views — and the weekly check-in's tiles (SPEC §3.3,
 * §4.6): the verdict, the optional recovery tiles, the Zone 2 machine kcal.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, dateRange } from "../../shared/dates";
import { defaultSettings } from "../../shared/defaults";
import { emptyDayLog } from "../../shared/empty";
import type { AppData } from "../../shared/gamify";
import { buildModel } from "../../shared/insights";
import type { DayLog, Exercise, MaxEntry } from "../../shared/schemas";
import { ProgressScreen } from "./Progress";

const TODAY = "2026-11-03";
const store = vi.hoisted(() => ({ data: null as unknown as AppData }));
vi.mock("../lib/store", () => ({
  useData: () => ({ data: store.data, today: TODAY, model: buildModel(store.data, TODAY) }),
  useAddMax: () => vi.fn(),
  useDeleteMax: () => vi.fn(),
  useMarkSeen: () => vi.fn(),
}));
vi.mock("../components/Toast", () => ({ useToast: () => ({ show: vi.fn(() => 1), dismiss: vi.fn() }) }));

const settings = {
  ...defaultSettings({ bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 }, "2026-10-01"),
  onboarded: true,
};
/** Three weeks of weights and calories up to yesterday (the check-in week is Oct 27 – Nov 2), plus `extra`. */
const withDays = (extra: (date: string) => Partial<DayLog> = () => ({})) => {
  store.data = {
    settings,
    days: dateRange(addDays(TODAY, -21), addDays(TODAY, -1)).map((date) => ({
      ...emptyDayLog(date),
      weightLb: 200,
      calories: 2800,
      ...extra(date),
    })),
    exercises: [],
    maxEntries: [],
    sessions: [],
    seenAchievements: [],
  } as AppData;
};
const tile = (label: string) => screen.getByText(label, { exact: true }).parentElement!.textContent;
/** Where the router is (path + query), so a test can read the URL the screen keeps its view in. */
function Where() {
  const { pathname, search } = useLocation();
  return <output data-testid="where">{pathname + search}</output>;
}
const where = () => screen.getByTestId("where").textContent;
const show = (path = "/progress") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <ProgressScreen />
      <Where />
    </MemoryRouter>,
  );
const tab = (name: string) => screen.getByRole("tab", { name });
const selected = () =>
  screen
    .getAllByRole("tab")
    .filter((t) => t.getAttribute("aria-selected") === "true")
    .map((t) => t.textContent);
const headings = (level: number) => screen.getAllByRole("heading", { level }).map((h) => h.textContent);

describe("Progress check-in recovery tiles", () => {
  beforeEach(() => withDays());

  it("shows no Resting HR or VO2 max tile when the week has none", () => {
    show();
    expect(screen.getByText("Sleep · HRV")).toBeTruthy();
    expect(screen.queryByText("Resting HR", { exact: true })).toBeNull();
    expect(screen.queryByText("VO2 max", { exact: true })).toBeNull();
  });

  it("averages the week's resting HR", () => {
    withDays((d) => (d >= "2026-10-27" ? { restingHrBpm: d === "2026-10-27" ? 50 : 48 } : {}));
    show();
    expect(tile("Resting HR")).toBe("Resting HR48bpmaverage");
  });

  it("dates a lone VO2 max from before the week (as of …)", () => {
    store.data = { ...store.data, days: [{ ...emptyDayLog("2026-08-20"), vo2Max: 50 }, ...store.data.days] };
    show();
    expect(tile("VO2 max")).toBe("VO2 max50.0mL/kg/minas of Aug 20");
  });

  it("dates a VO2 max from before the week instead of showing its change as this week's", () => {
    store.data = {
      ...store.data,
      days: [
        { ...emptyDayLog("2026-10-01"), vo2Max: 48 },
        ...store.data.days.map((d) => (d.date === "2026-10-20" ? { ...d, vo2Max: 50 } : d)),
      ],
    };
    show();
    expect(tile("VO2 max")).toBe("VO2 max50.0mL/kg/minas of Oct 20");
    // Logged this week: its change.
    store.data = { ...store.data, days: store.data.days.map((d) => (d.date === "2026-10-30" ? { ...d, vo2Max: 51 } : d)) };
    show();
    expect(screen.getAllByText("VO2 max", { exact: true }).at(-1)!.parentElement!.textContent).toBe("VO2 max51.0mL/kg/min+3.0 since Oct 1");
  });
});

describe("Progress check-in Zone 2 machine kcal", () => {
  const zone2Tile = () => screen.getByText("Zone 2", { exact: true }).parentElement!;

  it("adds the week's total under the Zone 2 count once logged, leaving Avg intake alone", () => {
    withDays((d) => (d >= "2026-10-27" && d <= "2026-10-29" ? { zone2Done: true, zone2Minutes: 30, zone2Kcal: 300 } : {}));
    show();
    expect(zone2Tile().textContent).toContain("900 kcal on the machine");
    // The qualifier is visible, not screen-reader only: beside intake numbers, a bare "900 kcal" reads as eaten.
    const qualifier = screen.getByText(/on the machine/);
    expect(qualifier.closest(".sr-only")).toBeNull();
    expect(qualifier.textContent).toBe("900 kcal on the machine");
    expect(screen.getByText("Avg intake").parentElement!.textContent).toContain("2,800");
  });

  it("shows no kcal line without readings (or on days cached by an older build)", () => {
    withDays((d) => (d >= "2026-10-27" ? { zone2Done: true, zone2Minutes: 30 } : {}));
    store.data = { ...store.data, days: store.data.days.map(({ zone2Kcal: _z, ...d }) => d as DayLog) };
    show();
    expect(zone2Tile().textContent).not.toContain("kcal");
  });
});

describe("Progress views: the tablist", () => {
  beforeEach(() => withDays());

  it("is headed Progress, with five tabs and Week selected by default", () => {
    show();
    expect(headings(1)).toEqual(["Progress"]);
    expect(screen.getByText("The trend")).toBeTruthy();
    const list = screen.getByRole("tablist", { name: "Progress views" });
    expect(
      within(list)
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual(["Week", "Body", "Fuel", "Activity", "Strength"]);
    expect(selected()).toEqual(["Week"]);
    // One tab stop (the selected tab); the panel is labelled by it.
    expect(screen.getAllByRole("tab").map((t) => t.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    const panel = screen.getByRole("tabpanel", { name: "Week" });
    expect(panel.id).toBe(tab("Week").getAttribute("aria-controls"));
    expect(where()).toBe("/progress");
  });

  it("selects a view on click and keeps it in the URL (Week is the bare path)", () => {
    show();
    fireEvent.click(tab("Body"));
    expect(selected()).toEqual(["Body"]);
    expect(where()).toBe("/progress?view=body");
    expect(screen.getByRole("tabpanel", { name: "Body" })).toBeTruthy();
    fireEvent.click(tab("Strength"));
    expect(where()).toBe("/progress?view=strength");
    fireEvent.click(tab("Week"));
    expect(selected()).toEqual(["Week"]);
    expect(where()).toBe("/progress");
  });

  it("opens on the view the URL names; an unknown one is the week", () => {
    const fuel = show("/progress?view=fuel");
    expect(selected()).toEqual(["Fuel"]);
    expect(headings(2)).toEqual(["Energy balance"]);
    fuel.unmount();
    const strength = show("/progress?view=strength");
    expect(selected()).toEqual(["Strength"]);
    strength.unmount();
    show("/progress?view=nope");
    expect(selected()).toEqual(["Week"]);
    expect(headings(2)).toEqual(["Weekly check-in"]);
  });

  it("moves and selects with the arrow keys, Home and End, wrapping at the ends", () => {
    show();
    tab("Week").focus();
    const press = (key: string) => fireEvent.keyDown(document.activeElement!, { key });
    press("ArrowRight");
    expect(selected()).toEqual(["Body"]);
    expect(document.activeElement).toBe(tab("Body"));
    expect(where()).toBe("/progress?view=body");
    press("End");
    expect(selected()).toEqual(["Strength"]);
    expect(document.activeElement).toBe(tab("Strength"));
    press("ArrowRight"); // wraps
    expect(selected()).toEqual(["Week"]);
    expect(where()).toBe("/progress");
    press("ArrowLeft"); // wraps back
    expect(selected()).toEqual(["Strength"]);
    press("ArrowLeft");
    expect(selected()).toEqual(["Activity"]);
    press("Home");
    expect(selected()).toEqual(["Week"]);
    expect(document.activeElement).toBe(tab("Week"));
    // Other keys are left alone.
    press("ArrowDown");
    expect(selected()).toEqual(["Week"]);
    expect(screen.getAllByRole("tab").map((t) => t.tabIndex)).toEqual([0, -1, -1, -1, -1]);
  });
});

describe("Progress views: what each one shows", () => {
  const bench: Exercise = {
    id: 1,
    name: "Bench press",
    category: "primary",
    tracksMax: true,
    measure: "reps",
    weighted: true,
    archived: false,
  };
  const max = (id: number, exerciseId: number, date: string, valueLb: number): MaxEntry => ({
    id,
    exerciseId,
    date,
    valueLb,
    source: "manual",
    note: null,
    createdAt: `${date}T08:00:00.000Z`,
  });
  beforeEach(() => {
    withDays((d) => ({ steps: 9000 + Number(d.slice(-2)) * 100 }));
    store.data = {
      ...store.data,
      settings: { ...settings, weightGoal: { targetLb: 190, pacePctPerWeek: 0.5, setOn: "2026-10-01", startLb: 205 } },
      exercises: [bench, { ...bench, id: 2, name: "Deadlift" }, { ...bench, id: 9, name: "Old lift", archived: true }],
      maxEntries: [max(1, 1, "2026-10-01", 215), max(2, 1, "2026-10-20", 225)],
    };
  });

  it("Week: the verdict first, then the tiles by group, then next week", () => {
    show();
    expect(headings(2)).toEqual(["Weekly check-in"]);
    expect(headings(3)).toEqual(["Body", "Fuel", "Activity", "Recovery"]);
    // A flat trend on a cut: slower than plan, in words (and an icon), not colour alone.
    const verdict = document.querySelector("[data-verdict]")!;
    expect(verdict.getAttribute("data-verdict")).toBe("slower");
    expect(verdict.textContent).toMatch(/^Slower than plan · 0\.0 lb this week against −\d\.\d$/);
    expect(verdict.querySelector("svg[aria-hidden]")).not.toBeNull();
    const group = (name: string) => screen.getByRole("heading", { level: 3, name }).parentElement!;
    expect([...group("Body").querySelectorAll(".label")].map((l) => l.textContent)).toEqual(["TDEE", "Trend weight"]);
    expect([...group("Fuel").querySelectorAll(".label")].map((l) => l.textContent)).toEqual(["Avg intake", "Avg protein"]);
    expect([...group("Activity").querySelectorAll(".label")].map((l) => l.textContent)).toEqual(["Avg steps", "Lifts", "Metcon", "Zone 2"]);
    expect([...group("Recovery").querySelectorAll(".label")].map((l) => l.textContent)).toEqual(["Sleep · HRV"]);
    expect(screen.getByText("Next week")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Share check-in" })).toBeTruthy();
    // The verdict comes before the first group.
    expect(verdict.compareDocumentPosition(group("Body")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // No charts, no range control on this view.
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByRole("group", { name: "Chart range" })).toBeNull();
  });

  it("Week: the first check-in's empty state, without a verdict", () => {
    store.data = { ...store.data, days: [] };
    show();
    expect(screen.getByText(/Your first check-in builds itself/)).toBeTruthy();
    expect(document.querySelector("[data-verdict]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Share check-in" })).toBeNull();
  });

  it("Week: says when the trend isn't judged yet", () => {
    store.data = { ...store.data, days: store.data.days.slice(-8) };
    show();
    expect(document.querySelector("[data-verdict]")!.textContent).toBe(
      "Not enough data yet · the trend is judged after 10 logged days (8 so far)",
    );
  });

  it("Body: the bodyweight chart with the goal line and its table", () => {
    show("/progress?view=body");
    expect(headings(2)).toEqual(["Bodyweight"]);
    const chart = screen.getByRole("img");
    expect(chart.getAttribute("aria-label")).toMatch(
      /^Bodyweight, Oct 5 to Nov 3\. Scale 200\.0 to 200\.0\. Trend 200\.0 to 200\.0\. goal 190\./,
    );
    fireEvent.click(screen.getByRole("button", { name: /Table/ }));
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Chart range" })).toBeTruthy();
    expect(screen.queryByText("Weekly check-in")).toBeNull();
  });

  it("Fuel: energy balance through yesterday, its caption and the intake strip", () => {
    show("/progress?view=fuel");
    expect(headings(2)).toEqual(["Energy balance"]);
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(
      /^Energy balance, Oct 5 to Nov 2\. Intake 2,800 to 2,800\. TDEE 2,800 to 2,800\./,
    );
    expect(screen.getByText(/through yesterday; today is still being logged/)).toBeTruthy();
    expect(screen.getByText("Intake vs target · 7 days")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Chart range" })).toBeTruthy();
  });

  it("Fuel: logging today's breakfast moves neither line, nor the Latest readout", () => {
    const readout = () => document.querySelector("[aria-live=polite]")!.textContent;
    const before = show("/progress?view=fuel");
    expect(readout()).toBe("Intake2,800TDEE2,800Latest");
    const label = screen.getByRole("img").getAttribute("aria-label");
    before.unmount();
    store.data = { ...store.data, days: [...store.data.days, { ...emptyDayLog(TODAY), weightLb: 200, calories: 300 }] };
    show("/progress?view=fuel");
    expect(readout()).toBe("Intake2,800TDEE2,800Latest");
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe(label);
    // The strip does show today, as "so far".
    expect(screen.getByText(/^Today so far: 300 /)).toBeTruthy();
  });

  it("Activity: the steps chart and a two-sentence caption", () => {
    show("/progress?view=activity");
    expect(headings(2)).toEqual(["Steps"]);
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(
      /^Steps, Oct 5 to Nov 3\. Steps [\d,]+ to [\d,]+\. Trend [\d,]+ to [\d,]+\. Target 15,000\./,
    );
    expect(screen.getByText(/The trend favours recent days/).textContent).toBe(
      "The trend favours recent days, so it differs from the Week view’s plain average. Today’s hollow dot joins it tomorrow.",
    );
    expect(screen.getByRole("group", { name: "Chart range" })).toBeTruthy();
  });

  it("Activity: its own empty state before there are counts", () => {
    withDays();
    show("/progress?view=activity");
    expect(screen.getByText("Log steps a few days to see your trend.")).toBeTruthy();
    expect(screen.queryByText(/The trend favours recent days/)).toBeNull();
  });

  it("Strength: the maxes, each lift's target progress, and the way to Goals", () => {
    store.data = {
      ...store.data,
      settings: {
        ...store.data.settings,
        strengthTargets: [
          { id: "t1", exerciseId: 1, targetLb: 275, setOn: "2026-10-01" },
          { id: "t0", exerciseId: 1, targetLb: 220, setOn: "2026-10-01" },
        ],
      },
    };
    show("/progress?view=strength");
    expect(headings(2)).toEqual(["Maxes"]);
    // Archived lifts are left out; no range control or chart here.
    const rows = screen.getAllByRole("button").filter((b) => b.closest("[role=tabpanel]"));
    expect(rows).toHaveLength(2);
    expect(screen.queryByRole("group", { name: "Chart range" })).toBeNull();
    const row = screen.getByRole("button", { name: /^Bench press/ });
    expect(row.textContent).toContain("+10 lb since start");
    expect(row.textContent).toContain("225");
    // Targets in ascending order: one reached (said in words), one with what is left.
    const targets = [...row.querySelectorAll("[data-target]")].map((t) => t.textContent);
    expect(targets).toEqual(["Target 220reached", "Target 27550 lb to go"]);
    const deadlift = screen.getByRole("button", { name: /^Deadlift/ });
    expect(deadlift.textContent).toBe("Deadliftno max yet—");
    expect(deadlift.querySelector("[data-target]")).toBeNull();
    expect(screen.getByRole("link", { name: "Edit targets in Goals" }).getAttribute("href")).toBe("/goals");
    // A row opens the lift's max sheet.
    fireEvent.click(row);
    expect(screen.getByRole("dialog", { name: "Bench press" })).toBeTruthy();
  });

  it("Strength: points to Goals when there are no targets, and says when no lift tracks a max", () => {
    const some = show("/progress?view=strength");
    expect(screen.getByRole("link", { name: "Set strength targets in Goals" }).getAttribute("href")).toBe("/goals");
    some.unmount();
    store.data = { ...store.data, exercises: [] };
    show("/progress?view=strength");
    expect(screen.getByText(/No lift tracks a max yet/)).toBeTruthy();
  });
});

describe("Progress views: one chart range", () => {
  beforeEach(() => {
    // 120 days of history, so 30 / 90 / All start on different days.
    withDays();
    store.data = {
      ...store.data,
      days: dateRange(addDays(TODAY, -120), addDays(TODAY, -1)).map((date) => ({
        ...emptyDayLog(date),
        weightLb: 200,
        calories: 2800,
        steps: 10000,
      })),
    };
  });
  const pressed = () =>
    within(screen.getByRole("group", { name: "Chart range" }))
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-pressed") === "true")
      .map((b) => b.getAttribute("aria-label"));
  const chartFrom = () =>
    screen
      .getByRole("img")
      .getAttribute("aria-label")!
      .match(/^[\w ]+, (\w+ \d+)/)![1];

  it("sits at the top of Body, Fuel and Activity and holds across them", () => {
    show("/progress?view=body");
    expect(pressed()).toEqual(["30 days"]);
    expect(chartFrom()).toBe("Oct 5");
    fireEvent.click(screen.getByRole("button", { name: "90 days" }));
    expect(pressed()).toEqual(["90 days"]);
    expect(chartFrom()).toBe("Aug 6");

    fireEvent.click(tab("Fuel"));
    expect(pressed()).toEqual(["90 days"]);
    expect(chartFrom()).toBe("Aug 6");
    fireEvent.click(screen.getByRole("button", { name: "All time" }));
    expect(chartFrom()).toBe("Jul 6");

    fireEvent.click(tab("Activity"));
    expect(pressed()).toEqual(["All time"]);
    expect(chartFrom()).toBe("Jul 6");

    // Through a view without charts and back: still the same range.
    fireEvent.click(tab("Week"));
    fireEvent.click(tab("Body"));
    expect(pressed()).toEqual(["All time"]);
    expect(chartFrom()).toBe("Jul 6");
  });
});
