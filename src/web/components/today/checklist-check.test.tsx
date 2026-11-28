/**
 * Today's checklist rows with a real check (Metcon, Zone 2): a value typed in the row's editor is
 * saved as its field is left — and a tap on the check leaves it. The tap sets what the finger
 * meant (decided as it lands, on the day as it is then), so the blur commit that ticks the row off
 * first is never undone by the click that follows; with the field still focused (iOS: the click
 * first, the blur after) it ends the same. The keyboard (Enter / Space) toggles as ever.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { emptyDayLog } from "../../../shared/empty";
import type { ChecklistItem } from "../../../shared/gamify";
import type { DayLog, DayLogPatch } from "../../../shared/schemas";
import { DayChecklist } from "./Checklist";

// The Metcon editor reads the day logs (its best so far, recent names): none here.
vi.mock("../../lib/store", () => ({ useData: () => ({ data: { days: [] } }) }));

const DATE = "2026-11-03"; // a Tuesday
const lift = { href: "/train", label: undefined, primaryName: null, setsDone: 0, setsTotal: 0 };

/** The checklist's metcon and Zone 2 rows over a day that takes its own patches (as the day's save does), recording each. */
function harness() {
  const patches: DayLogPatch[] = [];
  function Harness() {
    const [day, setDay] = useState<DayLog>(emptyDayLog(DATE));
    const items: ChecklistItem[] = [
      { key: "zone2", label: "Zone 2", done: day.zone2Done, progress: day.zone2Done ? 1 : 0 },
      { key: "metcon", label: "Metcon", done: day.metconDone, progress: day.metconDone ? 1 : 0 },
    ];
    return (
      <DayChecklist
        items={items}
        day={day}
        patch={(p) => {
          patches.push(p);
          setDay((d) => ({ ...d, ...p }));
        }}
        stepTarget={15000}
        zone2Minutes={30}
        lift={lift}
      />
    );
  }
  render(<Harness />);
  return patches;
}

const check = (name: string) => screen.getByRole("button", { name: `${name} complete` });
const openRow = async (user: ReturnType<typeof userEvent.setup>, name: string) =>
  user.click(screen.getByRole("button", { name: new RegExp(`^${name}(?! complete)`) }));

describe("a checklist row's check after typing in its editor", () => {
  it("Zone 2: minutes typed, then the check (the blur commit first) — done, with the minutes typed", async () => {
    const user = userEvent.setup();
    const patches = harness();
    await openRow(user, "Zone 2");
    const minutes = screen.getByRole("textbox", { name: "Zone 2 minutes" });
    await user.click(minutes);
    await user.type(minutes, "35");
    await user.click(check("Zone 2"));
    expect(patches).toEqual([{ zone2Minutes: 35, zone2Done: true }]);
    expect(check("Zone 2").getAttribute("aria-pressed")).toBe("true");
  });

  it("Zone 2: the check tapped with the field still focused (iOS: the click first, the blur after) — done, with the minutes typed", async () => {
    const user = userEvent.setup();
    const patches = harness();
    await openRow(user, "Zone 2");
    const minutes = screen.getByRole("textbox", { name: "Zone 2 minutes" });
    act(() => minutes.focus());
    fireEvent.change(minutes, { target: { value: "35" } });
    fireEvent.pointerDown(check("Zone 2"));
    fireEvent.click(check("Zone 2"));
    act(() => minutes.blur());
    expect(patches).toEqual([
      { zone2Done: true, zone2Minutes: 30 },
      { zone2Minutes: 35, zone2Done: true },
    ]);
    expect(check("Zone 2").getAttribute("aria-pressed")).toBe("true");
  });

  it("Metcon: notes written, then the check (the blur commit first) — done, with the notes", async () => {
    const user = userEvent.setup();
    const patches = harness();
    await openRow(user, "Metcon");
    const notes = screen.getByRole("textbox", { name: "Metcon notes" });
    await user.click(notes);
    await user.type(notes, "Cindy");
    await user.click(check("Metcon"));
    expect(patches).toEqual([{ metconNotes: "Cindy", metconDone: true }]);
    expect(check("Metcon").getAttribute("aria-pressed")).toBe("true");
  });

  it("Metcon: the check tapped with the notes still focused (the click first) — done once, the notes saved after", async () => {
    const user = userEvent.setup();
    const patches = harness();
    await openRow(user, "Metcon");
    const notes = screen.getByRole("textbox", { name: "Metcon notes" });
    act(() => notes.focus());
    fireEvent.change(notes, { target: { value: "Cindy" } });
    fireEvent.pointerDown(check("Metcon"));
    fireEvent.click(check("Metcon"));
    act(() => notes.blur());
    expect(patches).toEqual([{ metconDone: true }, { metconNotes: "Cindy", metconDone: true }]);
    expect(check("Metcon").getAttribute("aria-pressed")).toBe("true");
  });

  it("a plain tap still toggles, and so do Enter and Space", async () => {
    const user = userEvent.setup();
    const patches = harness();
    await user.click(check("Metcon"));
    await user.click(check("Metcon"));
    expect(patches).toEqual([{ metconDone: true }, { metconDone: false }]);
    check("Zone 2").focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(patches.slice(2)).toEqual([{ zone2Done: true, zone2Minutes: 30 }, { zone2Done: false }]);
  });
});
