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
  it("commits resting HR as a whole number and VO2 max with one decimal", async () => {
    const user = userEvent.setup();
    const patches = harness(MorningEditor, { weightLb: 200 });
    const rhr = screen.getByRole("textbox", { name: "Resting HR" });
    await user.type(rhr, "47.6{Enter}");
    expect(patches.at(-1)).toEqual({ restingHrBpm: 48 });
    expect(rhr).toHaveProperty("value", "48");

    const vo2 = screen.getByRole("textbox", { name: "VO2 max" });
    await user.type(vo2, "52.34{Enter}");
    expect(patches.at(-1)).toEqual({ vo2Max: 52.34 });
    expect(vo2).toHaveProperty("value", "52.3");

    // Clamped to the server's range; cleared back to not logged.
    await user.clear(rhr);
    await user.type(rhr, "400{Enter}");
    expect(patches.at(-1)).toEqual({ restingHrBpm: 220 });
    await user.clear(vo2);
    await user.type(vo2, "{Enter}");
    expect(patches.at(-1)).toEqual({ vo2Max: null });
  });

  it("shows blanks for a day cached without the fields (an older build's copy)", () => {
    const { restingHrBpm: _r, vo2Max: _v, ...legacy } = emptyDayLog(DATE);
    render(<MorningEditor day={legacy as DayLog} patch={() => {}} />);
    expect(screen.getByRole("textbox", { name: "Resting HR" })).toHaveProperty("value", "");
    expect(screen.getByRole("textbox", { name: "VO2 max" })).toHaveProperty("value", "");
  });
});

describe("Also today chips", () => {
  it("start unpressed (not recorded); a tap marks had, another records none", async () => {
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
    expect(patches.at(-1)).toEqual({ caffeine: false });
    expect(caffeine.getAttribute("aria-pressed")).toBe("false");
    await user.click(caffeine);
    expect(patches.at(-1)).toEqual({ caffeine: true });

    await user.click(within(group).getByRole("button", { name: "THC" }));
    expect(patches.at(-1)).toEqual({ thc: true });
    // Each tap patches only its own flag.
    expect(patches).toEqual([{ caffeine: true }, { caffeine: false }, { caffeine: true }, { thc: true }]);
    // 44px tap targets.
    for (const c of chips) expect(c.className).toContain("min-h-11");
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
    expect(screen.getByText("VO2 max").parentElement!.textContent).toBe("VO2 max52.0mL/kg/min");

    rerender(<Recovery day={emptyDayLog(DATE)} />);
    expect(container.textContent).toBe("");
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
    expect(morning().textContent).toContain("7h 30m · HRV 55 · RHR 48");
    expect(fuel().textContent).toContain("Alcohol · Caffeine");
    expect(fuel().textContent).not.toContain("Nicotine");
    // Still not done: neither counts toward closing the day.
    expect(morning().textContent).toContain("not done");
  });
});
