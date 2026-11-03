/**
 * Today's Fuel section against the Zone 2 machine kcal reading (SPEC §3.5): a reading only — the
 * day's calories, target, bars, macros and TDEE read exactly the same with or without it.
 */
import { render, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { addDays, dateRange } from "../../shared/dates";
import { defaultSettings } from "../../shared/defaults";
import { emptyDayLog } from "../../shared/empty";
import { streaks, type AppData } from "../../shared/gamify";
import { buildModel } from "../../shared/insights";
import type { DayLog } from "../../shared/schemas";
import { TodayScreen } from "./Today";

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
