/**
 * The weekly check-in's optional recovery tiles (SPEC §3.3, §4.6): resting HR only once the week
 * has some, and a VO2 max from before the week dated rather than shown as this week's.
 */
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, dateRange } from "../../shared/dates";
import { defaultSettings } from "../../shared/defaults";
import { emptyDayLog } from "../../shared/empty";
import type { AppData } from "../../shared/gamify";
import { buildModel } from "../../shared/insights";
import type { DayLog } from "../../shared/schemas";
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

const settings = { ...defaultSettings({ bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 }, "2026-10-01"), onboarded: true };
/** Three weeks of weights and calories up to yesterday (the check-in week is Oct 27 – Nov 2), plus `extra`. */
const withDays = (extra: (date: string) => Partial<DayLog> = () => ({})) => {
  store.data = {
    settings,
    days: dateRange(addDays(TODAY, -21), addDays(TODAY, -1)).map((date) => ({ ...emptyDayLog(date), weightLb: 200, calories: 2800, ...extra(date) })),
    exercises: [],
    maxEntries: [],
    sessions: [],
    seenAchievements: [],
  } as AppData;
};
const tile = (label: string) => screen.getByText(label, { exact: true }).parentElement!.textContent;
const show = () =>
  render(
    <MemoryRouter>
      <ProgressScreen />
    </MemoryRouter>,
  );

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
      days: [{ ...emptyDayLog("2026-10-01"), vo2Max: 48 }, ...store.data.days.map((d) => (d.date === "2026-10-20" ? { ...d, vo2Max: 50 } : d))],
    };
    show();
    expect(tile("VO2 max")).toBe("VO2 max50.0mL/kg/minas of Oct 20");
    // Logged this week: its change.
    store.data = { ...store.data, days: store.data.days.map((d) => (d.date === "2026-10-30" ? { ...d, vo2Max: 51 } : d)) };
    show();
    expect(screen.getAllByText("VO2 max", { exact: true }).at(-1)!.parentElement!.textContent).toBe("VO2 max51.0mL/kg/min+3.0 since Oct 1");
  });
});
