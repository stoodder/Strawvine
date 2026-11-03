/**
 * The morning editor's resting HR and VO2 max, the Nutrition editor's "Also today" chips, and how
 * Today shows them (Recovery section, checklist summaries).
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ChecklistItem } from "../../../shared/gamify";
import { emptyDayLog } from "../../../shared/empty";
import type { DayLog, DayLogPatch } from "../../../shared/schemas";
import { Recovery } from "../../screens/Today";
import { ToastProvider } from "../Toast";
import { DayChecklist } from "./Checklist";
import { FuelEditor, MorningEditor, substancesHad } from "./editors";

const DATE = "2026-11-03";

/** Renders an editor over a day that takes its own patches, recording each one. */
function harness(Editor: typeof MorningEditor, initial: Partial<DayLog> = {}) {
  const patches: DayLogPatch[] = [];
  function Harness() {
    const [day, setDay] = useState<DayLog>({ ...emptyDayLog(DATE), ...initial });
    return (
      <ToastProvider>
        <Editor
          day={day}
          patch={(p) => {
            patches.push(p);
            setDay((d) => ({ ...d, ...p }));
          }}
        />
      </ToastProvider>
    );
  }
  render(<Harness />);
  return patches;
}

describe("MorningEditor", () => {
  it("commits resting HR as a whole number and VO2 max with one decimal (saved as shown)", async () => {
    const user = userEvent.setup();
    const patches = harness(MorningEditor, { weightLb: 200 });
    const rhr = screen.getByRole("textbox", { name: "Resting HR" });
    await user.type(rhr, "47.6{Enter}");
    expect(patches.at(-1)).toEqual({ restingHrBpm: 48 });
    expect(rhr).toHaveProperty("value", "48");

    const vo2 = screen.getByRole("textbox", { name: "VO2 max" });
    await user.type(vo2, "52.34{Enter}");
    expect(patches.at(-1)).toEqual({ vo2Max: 52.3 });
    expect(vo2).toHaveProperty("value", "52.3");

    // Cleared back to not logged.
    await user.clear(vo2);
    await user.type(vo2, "{Enter}");
    expect(patches.at(-1)).toEqual({ vo2Max: null });
  });

  it("refuses readings out of range instead of clamping them to a believable limit", async () => {
    const user = userEvent.setup();
    const patches = harness(MorningEditor, { weightLb: 200, restingHrBpm: 48, vo2Max: 50, hrvMs: 60, sleepScore: 80 });
    const cases: Array<[string, string, string, string]> = [
      ["Resting HR", "5", "48", "20–220 bpm"],
      ["Resting HR", "400", "48", "20–220 bpm"],
      ["VO2 max", "520", "50", "10–100"],
      ["VO2 max", "5", "50", "10–100"],
      ["HRV", "900", "60", "0–500 ms"],
      ["Sleep score", "120", "80", "0–100"],
    ];
    for (const [name, typed, kept, range] of cases) {
      const input = screen.getByRole("textbox", { name });
      await user.clear(input);
      await user.type(input, `${typed}{Enter}`);
      expect(input, `${name} ${typed}`).toHaveProperty("value", kept);
      expect(input.getAttribute("aria-invalid")).toBe("true");
      const hint = document.getElementById(input.getAttribute("aria-describedby")!)!;
      expect(hint.textContent).toBe(`${name} not saved: use ${range}`);
      expect(hint.getAttribute("aria-live")).toBe("polite");
    }
    expect(patches).toEqual([]);

    // The next accepted entry saves and clears the hint.
    const rhr = screen.getByRole("textbox", { name: "Resting HR" });
    await user.clear(rhr);
    await user.type(rhr, "52{Enter}");
    expect(patches).toEqual([{ restingHrBpm: 52 }]);
    expect(rhr.getAttribute("aria-invalid")).toBeNull();
    expect(screen.queryByText("20–220 bpm", { exact: false })).toBeNull();
  });

  it("shows the units in the Resting HR and HRV boxes (VO2 max is named by its label alone)", () => {
    render(<MorningEditor day={{ ...emptyDayLog(DATE), hrvMs: 60, restingHrBpm: 48, vo2Max: 51 }} patch={() => {}} />);
    expect(screen.getByRole("textbox", { name: "Resting HR" }).closest("label")!.textContent).toBe("bpm");
    expect(screen.getByRole("textbox", { name: "HRV" }).closest("label")!.textContent).toBe("ms");
    expect(screen.getByRole("textbox", { name: "VO2 max" }).closest("label")!.textContent).toBe("");
  });

  it("shows blanks for a day cached without the fields (an older build's copy)", () => {
    const { restingHrBpm: _r, vo2Max: _v, ...legacy } = emptyDayLog(DATE);
    render(<MorningEditor day={legacy as DayLog} patch={() => {}} />);
    expect(screen.getByRole("textbox", { name: "Resting HR" })).toHaveProperty("value", "");
    expect(screen.getByRole("textbox", { name: "VO2 max" })).toHaveProperty("value", "");
  });
});

describe("Also today chips", () => {
  it("start unpressed (not recorded); a tap marks had, another clears it back to not recorded", async () => {
    const user = userEvent.setup();
    const patches = harness(FuelEditor);
    const group = screen.getByRole("group", { name: "Also today" });
    const chips = within(group).getAllByRole("button");
    expect(chips.map((c) => c.textContent)).toEqual(["Alcohol", "Nicotine", "THC", "Caffeine"]);
    expect(chips.map((c) => c.getAttribute("aria-pressed"))).toEqual(["false", "false", "false", "false"]);

    const caffeine = within(group).getByRole("button", { name: "Caffeine" });
    await user.click(caffeine);
    expect(patches.at(-1)).toEqual({ caffeine: true });
    expect(caffeine.getAttribute("aria-pressed")).toBe("true");
    await user.click(caffeine);
    expect(patches.at(-1)).toEqual({ caffeine: null });
    expect(caffeine.getAttribute("aria-pressed")).toBe("false");
    await user.click(caffeine);
    expect(patches.at(-1)).toEqual({ caffeine: true });

    await user.click(within(group).getByRole("button", { name: "THC" }));
    expect(patches.at(-1)).toEqual({ thc: true });
    // Each tap patches only its own flag; false is never written.
    expect(patches).toEqual([{ caffeine: true }, { caffeine: null }, { caffeine: true }, { thc: true }]);
    // 44px tap targets, pressed in the neutral tone (no lime, no check: not an achievement).
    for (const c of chips) expect(c.className).toContain("min-h-11");
    expect(caffeine.className).not.toContain("bg-accent");
    expect(caffeine.querySelector("svg")).toBeNull();
  });

  it("a day recorded as none (false, by an earlier build) shows unpressed and a tap marks it had", async () => {
    const user = userEvent.setup();
    const patches = harness(FuelEditor, { alcohol: false });
    const alcohol = within(screen.getByRole("group", { name: "Also today" })).getByRole("button", { name: "Alcohol" });
    expect(alcohol.getAttribute("aria-pressed")).toBe("false");
    await user.click(alcohol);
    expect(patches).toEqual([{ alcohol: true }]);
  });

  it("lists the ones had, in display order", () => {
    expect(substancesHad({ ...emptyDayLog(DATE), caffeine: true, alcohol: true, thc: false })).toEqual(["Alcohol", "Caffeine"]);
    expect(substancesHad({ ...emptyDayLog(DATE), nicotine: false })).toEqual([]);
  });
});

describe("Today", () => {
  it("Recovery shows resting HR and VO2 max with units once logged", () => {
    const { container, rerender } = render(<Recovery day={{ ...emptyDayLog(DATE), hrvMs: 55 }} />);
    expect(container.textContent).toContain("HRV55ms");
    expect(screen.queryByText("Resting HR")).toBeNull();
    expect(screen.queryByText("VO2 max")).toBeNull();

    rerender(<Recovery day={{ ...emptyDayLog(DATE), restingHrBpm: 48, vo2Max: 52 }} />);
    expect(screen.getByText("Resting HR").parentElement!.textContent).toBe("Resting HR48bpm");
    // No unit on Today (it would wrap onto a line of its own on a narrow phone).
    expect(screen.getByText("VO2 max").parentElement!.textContent).toBe("VO2 max52.0");

    rerender(<Recovery day={emptyDayLog(DATE)} />);
    expect(container.textContent).toBe("");
  });

  it("Recovery appears for resting HR alone, or VO2 max alone", () => {
    const { container, rerender } = render(<Recovery day={{ ...emptyDayLog(DATE), restingHrBpm: 48 }} />);
    expect(screen.getByRole("heading", { name: "Recovery" })).toBeTruthy();
    expect(screen.getByText("Resting HR")).toBeTruthy();
    expect(screen.queryByText("VO2 max")).toBeNull();
    rerender(<Recovery day={{ ...emptyDayLog(DATE), vo2Max: 51.5 }} />);
    expect(screen.getByRole("heading", { name: "Recovery" })).toBeTruthy();
    expect(screen.getByText("VO2 max").parentElement!.textContent).toBe("VO2 max51.5");
    expect(screen.queryByText("Resting HR")).toBeNull();
    expect(container.textContent).not.toBe("");
  });

  it("a day cached by an older build (no resting HR / VO2 fields) shows its HRV and nothing of the rest", () => {
    const { restingHrBpm: _r, vo2Max: _v, alcohol: _a, nicotine: _n, thc: _t, caffeine: _c, ...rest } = emptyDayLog(DATE);
    const day = { ...rest, hrvMs: 55, sleepMinutes: 450 } as DayLog;
    const { container } = render(<Recovery day={day} />);
    expect(container.textContent).toContain("HRV55ms");
    expect(container.textContent).not.toContain("Resting HR");
    expect(container.textContent).not.toContain("VO2");
    container.remove();

    const items: ChecklistItem[] = [
      { key: "morning", label: "Weigh-in", done: false, progress: 0 },
      { key: "fuel", label: "Nutrition", done: false, progress: 0 },
    ];
    const lift = { href: "/train", label: undefined, primaryName: null, setsDone: 0, setsTotal: 0 };
    render(<DayChecklist items={items} patch={vi.fn()} stepTarget={15000} zone2Minutes={30} lift={lift} day={day} />);
    const morning = screen.getByRole("button", { name: /^Weigh-in/ });
    expect(morning.textContent).toContain("7h 30m · HRV 55");
    expect(morning.textContent).not.toContain("RHR");
    expect(morning.textContent).not.toContain("resting heart rate");
    expect(screen.getByRole("button", { name: /^Nutrition/ }).textContent).toContain("Daily totals");
  });

  it("checklist rows summarise RHR and the Also today flags (the Weigh-in stays the weight alone)", () => {
    const items: ChecklistItem[] = [
      { key: "morning", label: "Weigh-in", done: false, progress: 0 },
      { key: "fuel", label: "Nutrition", done: false, progress: 0 },
    ];
    const lift = { href: "/train", label: undefined, primaryName: null, setsDone: 0, setsTotal: 0 };
    const props = { items, patch: vi.fn(), stepTarget: 15000, zone2Minutes: 30, lift };
    const { rerender } = render(<DayChecklist {...props} day={emptyDayLog(DATE)} />);
    const morning = () => screen.getByRole("button", { name: /^Weigh-in/ });
    const fuel = () => screen.getByRole("button", { name: /^Nutrition/ });
    expect(morning().textContent).toContain("Weight · sleep · HRV");
    expect(fuel().textContent).toContain("Daily totals");

    rerender(
      <DayChecklist
        {...props}
        day={{
          ...emptyDayLog(DATE),
          sleepMinutes: 450,
          hrvMs: 55,
          restingHrBpm: 48,
          vo2Max: 52,
          caffeine: true,
          alcohol: true,
          nicotine: false,
        }}
      />,
    );
    // "RHR" on screen; "resting heart rate" for a screen reader (which spells the abbreviation out).
    const rhr = within(morning()).getByText("RHR");
    expect(rhr.getAttribute("aria-hidden")).toBe("true");
    expect(rhr.nextElementSibling).toMatchObject({ className: "sr-only", textContent: "resting heart rate" });
    expect(morning().textContent).toContain("7h 30m · HRV 55 · RHRresting heart rate 48");
    expect(screen.getByRole("button", { name: /HRV 55 · resting heart rate 48/ })).toBe(morning());
    expect(fuel().textContent).toContain("Alcohol · Caffeine");
    expect(fuel().textContent).not.toContain("Nicotine");
    // Still not done: neither counts toward closing the day.
    expect(morning().textContent).toContain("not done");
  });
});
