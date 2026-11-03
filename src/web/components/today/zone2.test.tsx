/**
 * The Zone 2 editor's machine kcal reading and the Zone 2 row's summary (SPEC §3, §3.5): a reading
 * only — it doesn't tick the session off, and nothing but this row reads it.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { emptyDayLog } from "../../../shared/empty";
import type { ChecklistItem } from "../../../shared/gamify";
import type { DayLog, DayLogPatch } from "../../../shared/schemas";
import { DayChecklist } from "./Checklist";
import { Zone2Editor } from "./editors";

const DATE = "2026-11-03";

/** Renders the editor over a day that takes its own patches, recording each one. */
function harness(initial: Partial<DayLog> = {}) {
  const patches: DayLogPatch[] = [];
  function Harness() {
    const [day, setDay] = useState<DayLog>({ ...emptyDayLog(DATE), ...initial });
    return (
      <Zone2Editor
        day={day}
        patch={(p) => {
          patches.push(p);
          setDay((d) => ({ ...d, ...p }));
        }}
      />
    );
  }
  render(<Harness />);
  return patches;
}

describe("Zone2Editor", () => {
  it("commits the machine kcal as a whole number, on its own (the session isn't ticked off by it)", async () => {
    const user = userEvent.setup();
    const patches = harness();
    const kcal = screen.getByRole("textbox", { name: "Zone 2 machine calories" });
    expect(kcal.parentElement!.parentElement!.parentElement!.textContent).toContain("kcal");
    await user.type(kcal, "320.4{Enter}");
    expect(patches.at(-1)).toEqual({ zone2Kcal: 320 });
    expect(kcal).toHaveProperty("value", "320");

    // Minutes still tick it off, as before.
    await user.type(screen.getByRole("textbox", { name: "Zone 2 minutes" }), "30{Enter}");
    expect(patches.at(-1)).toEqual({ zone2Minutes: 30, zone2Done: true });

    // Cleared back to not logged.
    await user.clear(kcal);
    await user.type(kcal, "{Enter}");
    expect(patches.at(-1)).toEqual({ zone2Kcal: null });
    expect(screen.getByText("Machine reading · not added to intake")).toBeTruthy();
  });

  it("refuses a reading out of range instead of clamping it, and says the range", async () => {
    const user = userEvent.setup();
    const patches = harness({ zone2Done: true, zone2Minutes: 30, zone2Kcal: 320 });
    const kcal = screen.getByRole("textbox", { name: "Zone 2 machine calories" });
    expect(kcal).toHaveProperty("value", "320");
    for (const typed of ["4000", "-5"]) {
      await user.clear(kcal);
      await user.type(kcal, `${typed}{Enter}`);
      expect(kcal, typed).toHaveProperty("value", "320");
      expect(kcal.getAttribute("aria-invalid")).toBe("true");
      const hint = document.getElementById(kcal.getAttribute("aria-describedby")!)!;
      expect(hint.textContent).toBe("Zone 2 machine calories not saved: use 0–3000 kcal");
      expect(hint.getAttribute("aria-live")).toBe("polite");
    }
    expect(patches).toEqual([]);
    // The next accepted entry clears it.
    await user.clear(kcal);
    await user.type(kcal, "3000{Enter}");
    expect(patches.at(-1)).toEqual({ zone2Kcal: 3000 });
    expect(kcal.getAttribute("aria-invalid")).toBeNull();
    expect(screen.queryByText(/0–3000 kcal/)).toBeNull();
  });

  it("shows a blank reading for a day cached by an older build (no such field)", () => {
    const { zone2Kcal: _z, ...legacy } = { ...emptyDayLog(DATE), zone2Done: true, zone2Minutes: 30 };
    render(<Zone2Editor day={legacy as DayLog} patch={vi.fn()} />);
    expect(screen.getByRole("textbox", { name: "Zone 2 machine calories" })).toHaveProperty("value", "");
    expect(screen.getByRole("textbox", { name: "Zone 2 minutes" })).toHaveProperty("value", "30");
  });
});

describe("Zone 2 row", () => {
  const items: ChecklistItem[] = [{ key: "zone2", label: "Zone 2", done: false, progress: 0 }];
  const lift = { href: "/train", label: undefined, primaryName: null, setsDone: 0, setsTotal: 0 };
  const props = { patch: vi.fn(), stepTarget: 15000, zone2Minutes: 30, lift };
  /** The row's text button (the dot beside it is "Zone 2 complete"). */
  const row = () => screen.getByRole("button", { name: /^Zone 2(?! complete)/ });

  it("summarises the machine kcal once logged, beside the minutes", () => {
    const { rerender } = render(<DayChecklist {...props} items={items} day={emptyDayLog(DATE)} />);
    expect(row().textContent).toBe("Zone 2Cycling");

    const done = [{ ...items[0]!, done: true, progress: 1 }];
    rerender(<DayChecklist {...props} items={done} day={{ ...emptyDayLog(DATE), zone2Done: true, zone2Minutes: 30, zone2Kcal: 1320 }} />);
    expect(row().textContent).toBe("Zone 2Cycling · 1,320 kcal30 min");

    // Without a reading (or a day cached by an older build): as before.
    const { zone2Kcal: _z, ...legacy } = { ...emptyDayLog(DATE), zone2Done: true, zone2Minutes: 30 };
    rerender(<DayChecklist {...props} items={done} day={legacy as DayLog} />);
    expect(row().textContent).toBe("Zone 2Cycling30 min");
    expect(row().textContent).not.toContain("kcal");
  });

  it("shows the reading on a day not ticked off (a reading doesn't depend on done), with no minutes", () => {
    render(<DayChecklist {...props} items={items} day={{ ...emptyDayLog(DATE), zone2Done: false, zone2Kcal: 320 }} />);
    expect(row().textContent).toBe("Zone 2Cycling · 320 kcal");
    expect(screen.getByRole("button", { name: "Zone 2 complete" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("toggling the dot still completes the item (with the default duration), leaving the reading alone", async () => {
    const user = userEvent.setup();
    const patch = vi.fn();
    render(<DayChecklist {...props} patch={patch} items={items} day={{ ...emptyDayLog(DATE), zone2Kcal: 300 }} />);
    await user.click(screen.getByRole("button", { name: "Zone 2 complete" }));
    expect(patch).toHaveBeenCalledWith({ zone2Done: true, zone2Minutes: 30 });
  });
});
