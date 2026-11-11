/**
 * What comes and goes in a Today editor as a value is saved — when its field is left, often for
 * the next one, a phone's keyboard still up — sits under every field it could move (e2e/40
 * measures that nothing moves; this is the order on the page):
 * - Nutrition: the "Use N from macros" chip is the last thing in the editor, under the calories,
 *   the macros, "Also today" and the micronutrients, open or not;
 * - Metcon: the best-so-far line and the recent names are under the notes;
 * and a macro past the day log's limit is refused in its field, with the range, not sent.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { emptyDayLog } from "../../../shared/empty";
import { dayLogPatchSchema, type DayLog, type DayLogPatch } from "../../../shared/schemas";
import { ToastProvider } from "../Toast";
import { FuelEditor, MetconEditor } from "./editors";

const DATE = "2026-11-03";
/** The days the Metcon editor reads its past benchmarks from. */
const store = vi.hoisted(() => ({ days: [] as unknown[] }));
vi.mock("../../lib/store", () => ({ useData: () => ({ data: { days: store.days } }) }));

function harness(Editor: typeof FuelEditor, initial: Partial<DayLog>, days: DayLog[] = []) {
  const patches: DayLogPatch[] = [];
  store.days = days;
  function Harness() {
    const [day, setDay] = useState<DayLog>({ ...emptyDayLog(DATE), ...initial });
    return (
      <ToastProvider>
        <div data-testid="editor">
          <Editor
            day={day}
            patch={(p) => {
              patches.push(p);
              setDay((d) => ({ ...d, ...p }));
            }}
          />
        </div>
      </ToastProvider>
    );
  }
  render(<Harness />);
  return patches;
}

/** `b` comes after `a` on the page. */
const after = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
const chip = () => screen.queryByRole("button", { name: /from macros$/ });
/** A field by its name (the benchmark name, with its list of suggestions, is a combobox). */
const field = (name: string) => screen.getByLabelText(name, { selector: "input, textarea" });
const fields = () => within(screen.getByTestId("editor")).getAllByRole("textbox");

describe('FuelEditor\'s "Use N from macros"', () => {
  it("appears under every field and control when a saved macro no longer adds up to the calories — and goes the same way", async () => {
    const user = userEvent.setup();
    // 200·4 + 200·4 + 60·9 = 2140: nothing to offer.
    const patches = harness(FuelEditor, { calories: 2140, proteinG: 200, carbsG: 200, fatG: 60 });
    expect(chip()).toBeNull();
    const before = fields();
    expect(before.map((el) => el.getAttribute("aria-label"))).toEqual(["Calories", "Protein", "Carbs", "Fat"]);

    // Protein 260, then on to Carbs: the chip is there, after all four fields, "Also today" and "+ Micronutrients".
    await user.clear(field("Protein"));
    await user.type(field("Protein"), "260");
    await user.click(field("Carbs"));
    expect(patches).toEqual([{ proteinG: 260 }]);
    expect(document.activeElement).toBe(field("Carbs"));
    const offered = chip()!;
    expect(offered.textContent).toBe("Use 2,380 from macros");
    for (const el of fields()) expect(after(el, offered), `the chip comes after ${el.getAttribute("aria-label")}`).toBe(true);
    expect(after(screen.getByRole("group", { name: "Also today" }), offered)).toBe(true);
    expect(after(screen.getByRole("button", { name: "+ Micronutrients" }), offered)).toBe(true);
    expect(screen.getByTestId("editor").firstElementChild!.lastElementChild).toBe(offered);
    // The fields are the same elements (nothing re-mounted): focus and the keyboard stay.
    expect(fields()).toEqual(before);

    // Taking the offer saves the calories and the chip goes.
    await user.click(offered);
    expect(patches.at(-1)).toEqual({ calories: 2380 });
    expect(chip()).toBeNull();
  });

  it("with the micronutrients open, sits under them too: Fat → Fiber moves no micronutrient field", async () => {
    const user = userEvent.setup();
    harness(FuelEditor, { calories: 2140, proteinG: 200, carbsG: 200, fatG: 60, micros: { "Fiber g": 30 } });
    expect(chip()).toBeNull();
    await user.clear(field("Fat"));
    await user.type(field("Fat"), "70");
    await user.click(field("Fiber g"));
    const offered = chip()!;
    expect(offered.textContent).toBe("Use 2,230 from macros");
    const all = fields();
    expect(all.length).toBeGreaterThan(8); // the four numbers and the micronutrients
    for (const el of all) expect(after(el, offered), `the chip comes after ${el.getAttribute("aria-label")}`).toBe(true);
    expect(screen.getByTestId("editor").firstElementChild!.lastElementChild).toBe(offered);
  });

  it("refuses a macro past the day log's limit in its field, with the range — nothing is sent", async () => {
    const user = userEvent.setup();
    const patches = harness(FuelEditor, { proteinG: 150 });
    for (const [name, max, over] of [
      ["Protein", 2000, "2001"],
      ["Carbs", 3000, "201500"],
      ["Fat", 1000, "1001"],
    ] as const) {
      const key = name === "Protein" ? "proteinG" : name === "Carbs" ? "carbsG" : "fatG";
      // The limit said here is the schema's own.
      expect(dayLogPatchSchema.safeParse({ [key]: max }).success).toBe(true);
      expect(dayLogPatchSchema.safeParse({ [key]: max + 1 }).success).toBe(false);
      const input = field(name);
      await user.clear(input);
      await user.type(input, `${over}{Enter}`);
      expect(patches, `${name} ${over} is not saved`).toEqual([]);
      expect(input.getAttribute("aria-invalid")).toBe("true");
      const hint = document.getElementById(input.getAttribute("aria-describedby")!)!;
      expect(hint.textContent).toBe(`${name} not saved: use 0–${max} g`);
      // The hint hangs under the field without taking room: it pushes nothing that follows.
      expect(hint.className).toContain("absolute");
    }
    // The field shows what is saved; the limit itself is accepted.
    expect(field("Protein")).toHaveProperty("value", "150");
    await user.clear(field("Protein"));
    await user.type(field("Protein"), "2000{Enter}");
    expect(patches).toEqual([{ proteinG: 2000 }]);
    expect(field("Protein").getAttribute("aria-invalid")).toBeNull();
  });
});

describe("MetconEditor", () => {
  const past: DayLog = { ...emptyDayLog("2026-10-20"), metconBenchmark: "Fran", metconScore: "4:10", metconDone: true };

  it("keeps the notes directly under the fields: the best so far and the recent names come and go under them", async () => {
    const user = userEvent.setup();
    const patches = harness(MetconEditor, {}, [past]);
    const notes = field("Metcon notes");
    // No name yet: the recent names are offered — under the notes.
    const recent = screen.getByRole("group", { name: "Recent benchmarks" });
    expect(after(field("Benchmark name"), notes)).toBe(true);
    expect(after(field("Benchmark score"), notes)).toBe(true);
    expect(after(notes, recent)).toBe(true);

    // The name typed, then on to the notes: the recent names go, the best so far comes — under the notes too.
    await user.type(field("Benchmark name"), "Fran");
    await user.click(notes);
    expect(patches).toEqual([{ metconBenchmark: "Fran", metconDone: true }]);
    expect(document.activeElement).toBe(field("Metcon notes"));
    expect(field("Metcon notes")).toBe(notes);
    expect(screen.queryByRole("group", { name: "Recent benchmarks" })).toBeNull();
    const best = screen.getByRole("button", { name: /^Best 4:10/ });
    expect(after(notes, best)).toBe(true);
    // It still describes the fields it is about.
    expect(field("Benchmark score").getAttribute("aria-describedby")).toBe(best.parentElement!.id);
  });
});
