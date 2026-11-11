/**
 * Today's checklist while a field is being typed in: the rows' text — value, the lines under the
 * label, the steps bar — holds at what it showed when typing began (`useHeldWhileTyping`, wired
 * as Today wires it), every value is saved the moment its field is left, the editors and the dots
 * are of the day as it is, and the rows catch up when no field has focus. e2e/40 measures that no
 * field moves; this is what is shown, and when.
 */
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { emptyDayLog } from "../../../shared/empty";
import type { ChecklistItem } from "../../../shared/gamify";
import type { DayLog, DayLogPatch } from "../../../shared/schemas";
import { ToastProvider } from "../Toast";
import { useHeldWhileTyping } from "../useHeldWhileTyping";
import { DayChecklist } from "./Checklist";

const STEP_TARGET = 15000;
const lift = { href: "/train", label: undefined, primaryName: null, setsDone: 0, setsTotal: 0 };

/** The items the way `dayChecklist` derives the ones used here. */
const itemsOf = (day: DayLog): ChecklistItem[] => [
  { key: "morning", label: "Morning check-in", done: day.weightLb !== null, progress: 0 },
  { key: "steps", label: "Steps", done: (day.steps ?? 0) >= STEP_TARGET, progress: Math.min(1, (day.steps ?? 0) / STEP_TARGET) },
  { key: "zone2", label: "Zone 2", done: day.zone2Done, progress: 0 },
];

let syncIn: (p: DayLogPatch) => void = () => {};

function harness(initial: Partial<DayLog> = {}) {
  const patches: DayLogPatch[] = [];
  function Today({ date }: { date: string }) {
    const [day, setDay] = useState<DayLog>({ ...emptyDayLog(date), ...initial });
    syncIn = (p) => setDay((d) => ({ ...d, ...p }));
    const items = itemsOf(day);
    const still = useHeldWhileTyping({ items, day, lift }, date);
    return (
      <ToastProvider>
        <DayChecklist
          key={date}
          items={items}
          day={day}
          patch={(p) => {
            patches.push(p);
            setDay((d) => ({ ...d, ...p }));
          }}
          stepTarget={STEP_TARGET}
          zone2Minutes={30}
          lift={lift}
          shown={still}
        />
      </ToastProvider>
    );
  }
  const view = render(<Today date="2026-11-03" />);
  return { patches, showDay: (date: string) => view.rerender(<Today date={date} />) };
}

const nextTask = () => act(() => new Promise<void>((r) => setTimeout(r, 5)));
/** A row's own button (it opens the editor), not the toggle dot beside it. */
const row = (name: RegExp) => screen.getAllByRole("button", { name }).find((el) => el.hasAttribute("aria-expanded"))!;
const morning = () => row(/^Morning check-in/);
const steps = () => row(/^Steps/);
/** The lines under a row's label. */
const lines = (el: HTMLElement) => [...el.querySelectorAll(".truncate")].map((l) => l.textContent);
const value = (el: HTMLElement) => el.querySelector(".num")?.textContent ?? null;
const field = (name: string) => screen.getByRole("textbox", { name });

describe("Today's checklist while typing", () => {
  it("saves each value as its field is left, and keeps the row's summary as it was until no field has focus", async () => {
    const user = userEvent.setup();
    const { patches } = harness({ sleepMinutes: 450 });
    await user.click(morning());
    expect(lines(morning())).toEqual(["7h 30m"]);

    // Weight, then on to the score, HRV and VO2 max, field to field.
    await user.type(field("Morning weight"), "199.4");
    await user.click(field("Sleep score"));
    expect(patches).toEqual([{ weightLb: 199.4 }]); // saved at once, as ever
    await user.type(field("Sleep score"), "81");
    await user.click(field("HRV"));
    await user.type(field("HRV"), "62");
    await user.click(field("VO2 max"));
    await user.type(field("VO2 max"), "51.6");
    expect(patches).toEqual([{ weightLb: 199.4 }, { sleepScore: 81 }, { hrvMs: 62 }]);
    await nextTask();
    // The fields show what was saved…
    expect(field("Morning weight")).toHaveProperty("value", "199.4");
    expect(field("Sleep score")).toHaveProperty("value", "81");
    // …the row above them still what it showed when typing began: no value, one line.
    expect(value(morning())).toBeNull();
    expect(lines(morning())).toEqual(["7h 30m"]);
    expect(morning().textContent).toContain("not done");

    // The keyboard goes down (Enter leaves the field): everything typed is there, the second line with it.
    await user.keyboard("{Enter}");
    expect(patches.at(-1)).toEqual({ vo2Max: 51.6 });
    await nextTask();
    expect(value(morning())).toBe("199.4 lb");
    expect(lines(morning())).toEqual(["7h 30m · sleep score 81 · HRV 62", "VO2 51.6"]);
    expect(morning().textContent).toContain(", done");
  });

  it("a rating tapped while the keyboard is up (focus stays in the field, as on iOS) is saved and shown in the editor, not yet in the row", async () => {
    const user = userEvent.setup();
    const { patches } = harness({ weightLb: 199, sleepMinutes: 450 });
    await user.click(morning());
    const vo2 = field("VO2 max");
    await user.click(vo2);
    const four = screen.getByRole("radio", { name: "Energy 4 of 5" });
    // A tap that doesn't move focus (userEvent's click would focus the button, as Android and desktop do).
    act(() => four.click());
    expect(document.activeElement).toBe(vo2);
    expect(patches).toEqual([{ energy: 4 }]);
    expect(four.getAttribute("aria-checked")).toBe("true");
    await nextTask();
    expect(lines(morning())).toEqual(["7h 30m"]);
    // Leaving the field: the row gains its second line.
    act(() => vo2.blur());
    await nextTask();
    expect(lines(morning())).toEqual(["7h 30m", "energy 4/5"]);
  });

  it("a rating tapped with a press that takes focus (Android, desktop) lands, and the row catches up after it", async () => {
    const user = userEvent.setup();
    const { patches } = harness({ weightLb: 199, sleepMinutes: 450 });
    await user.click(morning());
    await user.click(field("VO2 max"));
    await user.click(screen.getByRole("radio", { name: "Soreness 2 of 5" }));
    expect(patches).toEqual([{ soreness: 2 }]);
    expect(screen.getByRole("radio", { name: "Soreness 2 of 5" }).getAttribute("aria-checked")).toBe("true");
    await nextTask();
    expect(lines(morning())).toEqual(["7h 30m", "soreness 2/5"]);
  });

  it("holds the steps bar and value while a field has focus; a dot that is a real toggle answers at once", async () => {
    const user = userEvent.setup();
    const { patches } = harness();
    await user.click(steps());
    const bar = () => steps().querySelector(".w-32");
    await user.type(field("Steps"), "9000");
    // On to another row's field without closing the keyboard: the Zone 2 editor isn't open, so stay in this one and tap a toggle.
    const zone2 = screen.getByRole("button", { name: "Zone 2 complete" });
    act(() => zone2.click());
    expect(patches).toEqual([{ zone2Done: true, zone2Minutes: 30 }]);
    // The toggle shows its new state though the display is held (it is the control just pressed)…
    expect(zone2.getAttribute("aria-pressed")).toBe("true");
    // …while the rows' text waits: Zone 2 has no minutes yet, Steps no value and no bar.
    expect(value(row(/^Zone 2/))).toBeNull();
    expect(bar()).toBeNull();
    await user.keyboard("{Enter}");
    expect(patches.at(-1)).toEqual({ steps: 9000 });
    await nextTask();
    expect(value(steps())).toBe("9,000");
    expect(bar()).not.toBeNull();
    expect(value(row(/^Zone 2/))).toBe("30 min");
  });

  it("a sync landing while a field has focus is shown when focus leaves, with nothing lost", async () => {
    const user = userEvent.setup();
    harness({ weightLb: 199 });
    await user.click(steps());
    await user.type(field("Steps"), "4000");
    // Another device's readings arrive.
    act(() => syncIn({ hrvMs: 58, zone2Done: true, zone2Minutes: 45 }));
    expect(lines(morning())).toEqual(["Weight · sleep · recovery"]);
    expect(value(row(/^Zone 2/))).toBeNull();
    expect(field("Steps")).toHaveProperty("value", "4000"); // the typing is untouched
    await user.keyboard("{Enter}");
    await nextTask();
    expect(lines(morning())).toEqual(["HRV 58"]);
    expect(value(row(/^Zone 2/))).toBe("45 min");
    expect(value(steps())).toBe("4,000");
  });

  it("another day shows its own rows at once, whatever was held", async () => {
    const user = userEvent.setup();
    const { showDay } = harness({ weightLb: 199 });
    await user.click(steps());
    await user.type(field("Steps"), "4000");
    act(() => syncIn({ hrvMs: 58 }));
    expect(lines(morning())).toEqual(["Weight · sleep · recovery"]);
    // The date changes (the checklist is re-keyed: the field goes with the old day's editor).
    showDay("2026-11-04");
    await nextTask();
    expect(lines(morning())).toEqual(["HRV 58"]); // this harness keeps its day's values; what matters: nothing is held over
    expect(within(steps()).queryByText("4,000")).toBeNull();
  });
});
