/**
 * The Nutrition editor's "Use N from macros" chip comes and goes as a number is saved — when its
 * field is left, often for the next one, with a phone's keyboard still up. It sits under the
 * calories and the macros, so that neither moves any of those fields (e2e/40 measures it).
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { emptyDayLog } from "../../../shared/empty";
import type { DayLog, DayLogPatch } from "../../../shared/schemas";
import { ToastProvider } from "../Toast";
import { FuelEditor } from "./editors";

function harness(initial: Partial<DayLog>) {
  const patches: DayLogPatch[] = [];
  function Harness() {
    const [day, setDay] = useState<DayLog>({ ...emptyDayLog("2026-11-03"), ...initial });
    return (
      <ToastProvider>
        <div data-testid="editor">
          <FuelEditor
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

const after = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
const chip = () => screen.queryByRole("button", { name: /from macros$/ });
const field = (name: string) => screen.getByRole("textbox", { name });

describe('FuelEditor\'s "Use N from macros"', () => {
  it("appears under every number field when a saved macro no longer adds up to the calories — and goes the same way", async () => {
    const user = userEvent.setup();
    // 200·4 + 200·4 + 60·9 = 2140: nothing to offer.
    const patches = harness({ calories: 2140, proteinG: 200, carbsG: 200, fatG: 60 });
    expect(chip()).toBeNull();
    const fields = within(screen.getByTestId("editor")).getAllByRole("textbox");
    expect(fields.map((el) => el.getAttribute("aria-label"))).toEqual(["Calories", "Protein", "Carbs", "Fat"]);

    // Protein 260, then on to Carbs: the chip is there, after all four fields and before "Also today".
    await user.clear(field("Protein"));
    await user.type(field("Protein"), "260");
    await user.click(field("Carbs"));
    expect(patches).toEqual([{ proteinG: 260 }]);
    expect(document.activeElement).toBe(field("Carbs"));
    const offered = chip()!;
    expect(offered.textContent).toBe("Use 2,380 from macros");
    for (const name of ["Calories", "Protein", "Carbs", "Fat"])
      expect(after(field(name), offered), `the chip comes after ${name}`).toBe(true);
    expect(after(offered, screen.getByRole("group", { name: "Also today" }))).toBe(true);
    // The fields are the same elements (nothing re-mounted): focus and the keyboard stay.
    expect(within(screen.getByTestId("editor")).getAllByRole("textbox")).toEqual(fields);

    // Taking the offer saves the calories and the chip goes.
    await user.click(offered);
    expect(patches.at(-1)).toEqual({ calories: 2380 });
    expect(chip()).toBeNull();
  });
});
