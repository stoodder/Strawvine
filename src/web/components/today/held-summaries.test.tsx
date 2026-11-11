/**
 * Today's checklist while a field is being typed in (wired as Today wires it: `useTyping` →
 * `holding`): every value is saved the moment its field is left, and every row says the day as it
 * is — done or not, its value, the text of its lines, to the eye and to a screen reader. Only what
 * would make a row taller or shorter waits until no field has focus: a second line under the
 * label, the steps bar. e2e/40 measures that no field moves; this is what is shown, and when.
 */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { emptyDayLog } from "../../../shared/empty";
import type { ChecklistItem } from "../../../shared/gamify";
import type { DayLog, DayLogPatch } from "../../../shared/schemas";
import { ToastProvider } from "../Toast";
import { useTyping } from "../useHeldWhileTyping";
import { DayChecklist } from "./Checklist";

const STEP_TARGET = 15000;
const lift = { href: "/train", label: undefined, primaryName: null, setsDone: 0, setsTotal: 0 };

/** The items the way `dayChecklist` derives the ones used here. */
const itemsOf = (day: DayLog): ChecklistItem[] => [
  { key: "morning", label: "Morning check-in", done: day.weightLb !== null, progress: 0 },
  { key: "fuel", label: "Nutrition", done: day.calories !== null, progress: 0 },
  { key: "steps", label: "Steps", done: (day.steps ?? 0) >= STEP_TARGET, progress: Math.min(1, (day.steps ?? 0) / STEP_TARGET) },
  { key: "zone2", label: "Zone 2", done: day.zone2Done, progress: 0 },
];

let syncIn: (p: DayLogPatch) => void = () => {};

function harness(initial: Partial<DayLog> = {}) {
  const patches: DayLogPatch[] = [];
  function Today({ date }: { date: string }) {
    const [day, setDay] = useState<DayLog>({ ...emptyDayLog(date), ...initial });
    syncIn = (p) => setDay((d) => ({ ...d, ...p }));
    const typing = useTyping();
    return (
      <ToastProvider>
        <DayChecklist
          key={date}
          items={itemsOf(day)}
          day={day}
          patch={(p) => {
            patches.push(p);
            setDay((d) => ({ ...d, ...p }));
          }}
          stepTarget={STEP_TARGET}
          zone2Minutes={30}
          lift={lift}
          holding={typing}
        />
        <textarea aria-label="Journal" />
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
const bar = (el: HTMLElement) => el.querySelector(".w-32");
const field = (name: string) => screen.getByRole("textbox", { name });

describe("Today's checklist while typing", () => {
  it("saves each value as its field is left and says it in the row at once; only the row's second line waits for focus to leave", async () => {
    const user = userEvent.setup();
    const { patches } = harness({ sleepMinutes: 450 });
    await user.click(morning());
    expect(lines(morning())).toEqual(["7h 30m"]);
    expect(morning().textContent).toContain("not done");

    // Weight, then on to the score: saved, and the row is done, with its value — to a screen reader too.
    await user.type(field("Morning weight"), "199.4");
    await user.click(field("Sleep score"));
    expect(patches).toEqual([{ weightLb: 199.4 }]);
    expect(value(morning())).toBe("199.4 lb");
    expect(morning().textContent).toContain(", done");
    expect(morning().textContent).not.toContain("not done");
    // The line that is there says what is saved, as it is saved.
    await user.type(field("Sleep score"), "81");
    await user.click(field("HRV"));
    expect(lines(morning())).toEqual(["7h 30m · sleep score 81"]);
    await user.type(field("HRV"), "62");
    await user.click(field("VO2 max"));
    expect(lines(morning())).toEqual(["7h 30m · sleep score 81 · HRV 62"]);

    // VO2 max would give the row a second line: on to another field, it is saved — and the line waits.
    await user.type(field("VO2 max"), "51.6");
    await user.click(field("Resting HR"));
    expect(patches.at(-1)).toEqual({ vo2Max: 51.6 });
    await nextTask();
    expect(lines(morning())).toEqual(["7h 30m · sleep score 81 · HRV 62"]);

    // The keyboard goes down (Enter leaves the field): the second line is there.
    await user.keyboard("{Enter}");
    await nextTask();
    expect(lines(morning())).toEqual(["7h 30m · sleep score 81 · HRV 62", "VO2 51.6"]);
    expect(value(morning())).toBe("199.4 lb");
  });

  it("a line that is there keeps its place when it has nothing left to say, until focus leaves", async () => {
    const user = userEvent.setup();
    harness({ weightLb: 199, sleepMinutes: 450, vo2Max: 51.6 });
    await user.click(morning());
    expect(lines(morning())).toEqual(["7h 30m", "VO2 51.6"]);
    // VO2 max cleared, on to another field: the row has one thing to say — and still two lines, the second empty.
    await user.clear(field("VO2 max"));
    await user.click(field("HRV"));
    expect(lines(morning())).toEqual(["7h 30m", ""]);
    await user.keyboard("{Enter}");
    await nextTask();
    expect(lines(morning())).toEqual(["7h 30m"]);
  });

  it("a rating tapped with focus left in the field is saved and shown on the scale; the row's new line waits for the field to be left", async () => {
    const user = userEvent.setup();
    const { patches } = harness({ weightLb: 199, sleepMinutes: 450 });
    await user.click(morning());
    const vo2 = field("VO2 max");
    await user.click(vo2);
    const four = screen.getByRole("radio", { name: "Energy 4 of 5" });
    // A tap that doesn't move focus (userEvent's click would focus the button).
    act(() => four.click());
    expect(document.activeElement).toBe(vo2);
    expect(patches).toEqual([{ energy: 4 }]);
    expect(four.getAttribute("aria-checked")).toBe("true");
    await nextTask();
    expect(lines(morning())).toEqual(["7h 30m"]);
    act(() => vo2.blur());
    await nextTask();
    expect(lines(morning())).toEqual(["7h 30m", "energy 4/5"]);
  });

  it("a rating tapped with a press that takes focus from the field lands, and the row catches up after it", async () => {
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

  it("steps past the target, then on to the journal: the row is done with its value at once, never 'not done' beside a filled dot", async () => {
    const user = userEvent.setup();
    const { patches } = harness();
    await user.click(steps());
    await user.type(field("Steps"), "16000");
    await user.click(field("Journal"));
    expect(patches).toEqual([{ steps: 16000 }]);
    await nextTask();
    expect(document.activeElement).toBe(field("Journal"));
    expect(value(steps())).toBe("16,000");
    expect(steps().textContent).toContain("Steps, done");
    expect(steps().textContent).not.toContain("not done");
    expect(lines(steps())).toEqual(["Target 15k"]);
    expect(bar(steps())).toBeNull();
  });

  it("steps short of the target: the value at once, the progress bar when no field has focus", async () => {
    const user = userEvent.setup();
    const { patches } = harness();
    await user.click(steps());
    await user.type(field("Steps"), "9000");
    await user.click(field("Journal"));
    expect(patches).toEqual([{ steps: 9000 }]);
    await nextTask();
    expect(value(steps())).toBe("9,000");
    expect(steps().textContent).toContain("not done");
    expect(bar(steps())).toBeNull();
    act(() => field("Journal").blur());
    await nextTask();
    expect(bar(steps())).not.toBeNull();
  });

  it("a bar that is there stays, at what the steps are now, until focus leaves", async () => {
    const user = userEvent.setup();
    harness({ steps: 9000 });
    await user.click(steps());
    expect(bar(steps())).not.toBeNull();
    await user.clear(field("Steps"));
    await user.type(field("Steps"), "16000");
    await user.click(field("Journal"));
    await nextTask();
    // Done, and the bar (still there: nothing moves) is full.
    expect(steps().textContent).toContain("Steps, done");
    expect(bar(steps())).not.toBeNull();
    await act(() => new Promise<void>((r) => setTimeout(r, 900))); // the bar fills over 0.7 s
    expect((bar(steps())!.firstElementChild as HTMLElement).style.width).toBe("100%");
    act(() => field("Journal").blur());
    await nextTask();
    expect(bar(steps())).toBeNull();
  });

  it("a toggle tapped while a field has focus answers at once, in its dot and in its row", async () => {
    const user = userEvent.setup();
    const { patches } = harness();
    await user.click(field("Journal"));
    const zone2 = screen.getByRole("button", { name: "Zone 2 complete" });
    act(() => zone2.click());
    expect(document.activeElement).toBe(field("Journal"));
    expect(patches).toEqual([{ zone2Done: true, zone2Minutes: 30 }]);
    expect(zone2.getAttribute("aria-pressed")).toBe("true");
    expect(value(row(/^Zone 2/))).toBe("30 min");
    expect(row(/^Zone 2/).textContent).toContain("Zone 2");
  });

  it("a sync landing while a field has focus is said at once where a line exists, and gains its new lines when focus leaves", async () => {
    const user = userEvent.setup();
    harness({ weightLb: 199 });
    await user.click(field("Journal"));
    await user.type(field("Journal"), "typing");
    // Another device's entries arrive.
    act(() => syncIn({ hrvMs: 58, energy: 4, calories: 1800, caffeine: true, zone2Done: true, zone2Minutes: 45 }));
    expect(lines(morning())).toEqual(["HRV 58"]);
    expect(value(row(/^Nutrition/))).toBe("1,800 kcal");
    expect(lines(row(/^Nutrition/))).toEqual(["Daily totals"]);
    expect(value(row(/^Zone 2/))).toBe("45 min");
    expect(field("Journal")).toHaveProperty("value", "typing"); // the typing is untouched
    act(() => field("Journal").blur());
    await nextTask();
    expect(lines(morning())).toEqual(["HRV 58", "energy 4/5"]);
    expect(lines(row(/^Nutrition/))).toEqual(["Daily totals", "Had caffeine"]);
  });

  it("another day shows its own rows at once, whatever was waiting", async () => {
    const user = userEvent.setup();
    const { showDay } = harness({ weightLb: 199, sleepMinutes: 450 });
    await user.click(field("Journal"));
    act(() => syncIn({ energy: 4 }));
    expect(lines(morning())).toEqual(["7h 30m"]);
    // The date changes with the field still focused: the checklist is that day's (re-keyed), with all its lines.
    showDay("2026-11-04");
    expect(document.activeElement).toBe(field("Journal"));
    expect(lines(morning())).toEqual(["7h 30m", "energy 4/5"]);
  });
});
