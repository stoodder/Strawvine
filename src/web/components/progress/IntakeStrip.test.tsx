/**
 * Progress → Fuel's 7-day intake strip: a finished day shows its difference from the target on a
 * solid bar; today is still being eaten, and looks it — a hollow bar and "so far" where the
 * difference would be (SPEC §4.7).
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { addDays, dateRange } from "../../../shared/dates";
import { defaultSettings } from "../../../shared/defaults";
import { emptyDayLog } from "../../../shared/empty";
import { computeEnergySeries } from "../../../shared/energy";
import type { AppData } from "../../../shared/gamify";
import type { DayLog } from "../../../shared/schemas";
import { IntakeStrip } from "./IntakeStrip";

const TODAY = "2026-11-03"; // a Tuesday
const settings = {
  ...defaultSettings({ bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 }, "2026-10-01"),
  onboarded: true,
};

/** Three steady weeks at 200 lb and 2,800 kcal (so every day's target is 2,800), then `patch` per date. */
function show(patch: Record<string, Partial<DayLog>> = {}) {
  const days = dateRange(addDays(TODAY, -21), TODAY).map((date): DayLog => ({
    ...emptyDayLog(date),
    ...(date < TODAY ? { weightLb: 200, calories: 2800 } : {}),
    ...patch[date],
  }));
  const data = { settings, days, exercises: [], maxEntries: [], sessions: [], seenAchievements: [] } as unknown as AppData;
  const series = computeEnergySeries(days, addDays(TODAY, -60), TODAY, settings.nutrition.kcalPerLb);
  return render(<IntakeStrip data={data} series={series} today={TODAY} />);
}
const columns = () => [...document.querySelectorAll<HTMLElement>("li")];
/** What a sighted reader gets under a column's bar: the weekday and the line below it (the sr-only sentence left out). */
const caption = (li: HTMLElement) => [...li.querySelectorAll<HTMLElement>(".text-center > div")].map((d) => d.textContent);
const spoken = (li: HTMLElement) => li.querySelector(".sr-only")!.textContent;
const barOf = (li: HTMLElement) => li.querySelector<HTMLElement>(".h-14 > div:not(.h-px)");

describe("IntakeStrip", () => {
  it("today's column says 'so far' where a finished day shows its difference, on a hollow bar", () => {
    show({ [TODAY]: { weightLb: 200, calories: 300 }, [addDays(TODAY, -1)]: { weightLb: 200, calories: 1100 } });
    const cols = columns();
    expect(cols).toHaveLength(7);
    expect(cols.map((c) => c.dataset.day)).toEqual(["past", "past", "past", "past", "past", "past", "today"]);
    const [today, yesterday, dayBefore] = [cols[6]!, cols[5]!, cols[4]!];

    // Past days: the difference from that day's target (2,800 here), compact.
    expect(caption(yesterday)).toEqual(["MonM", "−1.7k"]);
    expect(caption(dayBefore)).toEqual(["SunS", "0"]);
    expect(yesterday.textContent).not.toContain("so far");

    // Today: "so far", visibly (not screen-reader-only text), and no difference — −2.5k would read as a day that ended short.
    expect(caption(today)).toEqual(["TueT", "so far"]);
    const soFar = today.querySelector<HTMLElement>("[data-so-far]")!;
    expect(soFar.textContent).toBe("so far");
    expect(soFar.closest(".sr-only")).toBeNull();
    expect(soFar.className).not.toContain("sr-only");
    expect(today.textContent).not.toMatch(/[−+]\d/);

    // The bars: yesterday's is a solid lime fill; today's keeps its partial height but is an outline over a tint.
    const solid = barOf(yesterday)!;
    expect(solid.classList.contains("bg-accent")).toBe(true);
    expect(solid.hasAttribute("data-partial")).toBe(false);
    expect(solid.className).not.toContain("shadow-[inset");
    expect(solid.style.boxShadow).not.toBe("");
    const hollow = barOf(today)!;
    expect(hollow.hasAttribute("data-partial")).toBe(true);
    expect(hollow.classList.contains("bg-accent")).toBe(false);
    expect(hollow.className).toContain("shadow-[inset_0_0_0_1.5px_currentColor]");
    expect(hollow.classList.contains("text-accent")).toBe(true);
    // No glow (it would fill the outline), and not merely dimmed.
    expect(hollow.style.boxShadow).toBe("");
    expect(hollow.className).not.toContain("opacity-");
  });

  it("is read out as a day in progress: what is left, not what it came in under", () => {
    show({ [TODAY]: { weightLb: 200, calories: 300 }, [addDays(TODAY, -1)]: { weightLb: 200, calories: 2400 } });
    const cols = columns();
    // Today's target follows yesterday's short day; whatever it is, what is short of it is "left".
    const [, target, left] = spoken(cols[6]!)!.match(/^Today so far: 300 of ([\d,]+) kcal, ([\d,]+) left$/)!;
    const n = (text: string | undefined) => Number(text!.replace(/,/g, ""));
    expect(n(target)).toBeGreaterThan(2000);
    expect(n(left)).toBe(n(target) - 300);
    expect(spoken(cols[5]!)).toBe("Monday Nov 2: 2,400 of 2,800 kcal, 400 under");
    expect(spoken(cols[4]!)).toBe("Sunday Nov 1: 2,800 of 2,800 kcal, on target");
  });

  it("today over target: still 'so far', the excess outlined in the over-target colour rather than filled", () => {
    show({ [TODAY]: { weightLb: 200, calories: 3600 }, [addDays(TODAY, -1)]: { weightLb: 200, calories: 3600 } });
    const cols = columns();
    const [today, yesterday] = [cols[6]!, cols[5]!];
    expect(caption(today)).toEqual(["TueT", "so far"]);
    expect(spoken(today)).toMatch(/^Today so far: 3,600 of [\d,]+ kcal, [\d,]+ over$/);
    // Yesterday, as over: a filled excess and the difference in its colour.
    const filled = yesterday.querySelector<HTMLElement>("[data-severity]")!;
    expect(filled.getAttribute("data-severity")).toBe("1");
    expect(filled.classList.contains("bg-warn")).toBe(true);
    expect(caption(yesterday)[1]).toBe("+800");
    // Today's: the same severity, as an outline (text colour → currentColor), no fill.
    const outlined = today.querySelector<HTMLElement>("[data-severity]")!;
    expect(Number(outlined.getAttribute("data-severity"))).toBeGreaterThan(0.9);
    expect(outlined.classList.contains("text-warn")).toBe(true);
    expect(outlined.classList.contains("bg-warn")).toBe(false);
    expect(outlined.className).toContain("shadow-[inset_0_0_0_1.5px_currentColor]");
    expect(outlined.style.backgroundColor).toBe("");
    expect(barOf(today)!.hasAttribute("data-partial")).toBe(true);
    expect(barOf(today)!.classList.contains("bg-accent")).toBe(false);
  });

  it("nothing eaten yet today: a dash, no bar, no 'so far'", () => {
    show({ [TODAY]: { weightLb: 200 } });
    const today = columns()[6]!;
    expect(caption(today)).toEqual(["TueT", "—"]);
    expect(today.querySelector("[data-so-far]")).toBeNull();
    expect(barOf(today)).toBeNull();
    expect(spoken(today)).toBe("Today so far: no calories logged");
  });

  it("renders nothing when no day of the week has calories", () => {
    const days = dateRange(addDays(TODAY, -21), TODAY).map((date): DayLog => ({ ...emptyDayLog(date), weightLb: 200 }));
    const data = { settings, days, exercises: [], maxEntries: [], sessions: [], seenAchievements: [] } as unknown as AppData;
    const { container } = render(
      <IntakeStrip data={data} series={computeEnergySeries(days, addDays(TODAY, -60), TODAY, 3500)} today={TODAY} />,
    );
    expect(container.textContent).toBe("");
    expect(screen.queryByText("Intake vs target · 7 days")).toBeNull();
  });
});
