/**
 * The Zone 2 editor and row (SPEC §3, §3.5): the machine (chips, the last one used, written with the
 * day's first Zone 2 value), and the machine kcal reading — a reading only: it doesn't tick the
 * session off, and nothing but this row and the check-in reads it.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { emptyDayLog } from "../../../shared/empty";
import type { ChecklistItem } from "../../../shared/gamify";
import type { DayLog, DayLogPatch } from "../../../shared/schemas";
import type { LastZone2Machine } from "../../../shared/zone2";
import { DayChecklist, type Zone2Machines } from "./Checklist";
import { Zone2Editor } from "./editors";

const DATE = "2026-11-03"; // a Tuesday
const ROWED_THU: LastZone2Machine = { machine: "row", from: "2026-10-29" };
const PRESETS = ["bike", "row", "elliptical", "ski"];

/** Renders the editor over a day that takes its own patches, recording each one. */
function harness(initial: Partial<DayLog> = {}, machines: { last?: LastZone2Machine; chips?: string[] } = {}) {
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
        today={DATE}
        {...machines}
      />
    );
  }
  render(<Harness />);
  return patches;
}

const radio = (name: string) => screen.getByRole("radio", { name });
const checkedName = () => screen.getAllByRole("radio").find((r) => r.getAttribute("aria-checked") === "true")?.textContent;
const caption = () => document.getElementById(screen.getByRole("radiogroup", { name: "Machine" }).getAttribute("aria-describedby")!)!;

describe("Zone2Editor", () => {
  it("commits the machine kcal as a whole number, on its own (the session isn't ticked off by it)", async () => {
    const user = userEvent.setup();
    const patches = harness();
    const kcal = screen.getByRole("textbox", { name: "Zone 2 machine calories" });
    expect(kcal.parentElement!.parentElement!.parentElement!.textContent).toContain("kcal");
    await user.type(kcal, "320.4{Enter}");
    // The day's first Zone 2 value: the machine shown (nothing before: the bike) goes with it.
    expect(patches.at(-1)).toEqual({ zone2Kcal: 320, zone2Machine: "bike" });
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
    const { zone2Kcal: _z, zone2Machine: _m, ...legacy } = { ...emptyDayLog(DATE), zone2Done: true, zone2Minutes: 30 };
    render(<Zone2Editor day={legacy as DayLog} patch={vi.fn()} last={ROWED_THU} />);
    expect(screen.getByRole("textbox", { name: "Zone 2 machine calories" })).toHaveProperty("value", "");
    expect(screen.getByRole("textbox", { name: "Zone 2 minutes" })).toHaveProperty("value", "30");
    // Logged before machines were: the bike, whatever was used last.
    expect(checkedName()).toBe("Bike");
  });
});

describe("Zone2Editor: the machine", () => {
  it("offers the machines as a radio group, the last one used chosen, and says so", () => {
    harness({}, { last: ROWED_THU, chips: [...PRESETS, "Assault bike"] });
    expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual(["Bike", "Row", "Elliptical", "Ski", "Assault bike", "Other"]);
    expect(checkedName()).toBe("Row");
    expect(caption().textContent).toBe("Same as last time · Thu");
    // Nothing earlier: the bike, said as the default.
    cleanup();
    harness();
    expect(checkedName()).toBe("Bike");
    expect(caption().textContent).toBe("Bike unless you pick another");
  });

  it("a chip alone writes nothing; the first Zone 2 value carries it", async () => {
    const user = userEvent.setup();
    const patches = harness({}, { last: ROWED_THU });
    await user.click(radio("Ski"));
    expect(patches).toEqual([]);
    expect(checkedName()).toBe("Ski");
    expect(caption().textContent).toBe("Your choice today");
    // Back to the last one: so it says.
    await user.click(radio("Row"));
    expect(caption().textContent).toBe("Same as last time · Thu");
    await user.click(radio("Elliptical"));
    await user.type(screen.getByRole("textbox", { name: "Zone 2 minutes" }), "40{Enter}");
    expect(patches).toEqual([{ zone2Minutes: 40, zone2Done: true, zone2Machine: "elliptical" }]);
    // Logged: a chip now writes at once.
    await user.click(radio("Bike"));
    expect(patches.at(-1)).toEqual({ zone2Machine: "bike" });
    expect(checkedName()).toBe("Bike");
    // The one already written: nothing to write.
    await user.click(radio("Bike"));
    expect(patches).toHaveLength(2);
  });

  it("on a day logged before machines were, a chip writes the machine (it read as the bike)", async () => {
    const user = userEvent.setup();
    const patches = harness({ zone2Done: true, zone2Minutes: 30 }, { last: ROWED_THU });
    expect(checkedName()).toBe("Bike");
    expect(caption().textContent).toBe("Your choice today");
    await user.click(radio("Row"));
    expect(patches).toEqual([{ zone2Machine: "row" }]);
    expect(caption().textContent).toBe("Same as last time · Thu");
  });

  it("works by keyboard: one tab stop, the arrows move and choose, wrapping", async () => {
    const user = userEvent.setup();
    harness({}, { last: ROWED_THU });
    expect(screen.getAllByRole("radio").map((r) => r.tabIndex)).toEqual([-1, 0, -1, -1, -1]);
    radio("Row").focus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(radio("Elliptical"));
    expect(checkedName()).toBe("Elliptical");
    expect(radio("Elliptical").tabIndex).toBe(0);
    await user.keyboard("{ArrowLeft}{ArrowLeft}{ArrowLeft}");
    expect(document.activeElement).toBe(radio("Other"));
    expect(checkedName()).toBe("Other");
    // By the keys, Other shows its name field but leaves focus on the chip.
    expect(screen.getByRole("textbox", { name: "Machine name" })).toBeTruthy();
    expect(document.activeElement).toBe(radio("Other"));
    expect(caption().textContent).toBe("Name it below");
    await user.keyboard("{Home}");
    expect(checkedName()).toBe("Bike");
    expect(screen.queryByRole("textbox", { name: "Machine name" })).toBeNull();
    await user.keyboard("{End}");
    expect(checkedName()).toBe("Other");
  });

  it("Other names a machine of the owner's own: written with the first value; the field stays", async () => {
    const user = userEvent.setup();
    const patches = harness({}, { last: ROWED_THU });
    await user.click(radio("Other"));
    const name = screen.getByRole("textbox", { name: "Machine name" });
    // The tap that chose Other put the caret in its name.
    expect(document.activeElement).toBe(name);
    await user.type(name, "  Assault   bike {Enter}");
    expect(patches).toEqual([]);
    expect(checkedName()).toBe("Other");
    expect(caption().textContent).toBe("Your choice today");
    expect(screen.getByRole("textbox", { name: "Machine name" })).toHaveProperty("value", "Assault   bike");
    await user.type(screen.getByRole("textbox", { name: "Zone 2 machine calories" }), "280{Enter}");
    expect(patches).toEqual([{ zone2Kcal: 280, zone2Machine: "Assault bike" }]);
    // Renamed on a logged day: written at once. A common machine's name is stored as that machine.
    await user.clear(screen.getByRole("textbox", { name: "Machine name" }));
    await user.type(screen.getByRole("textbox", { name: "Machine name" }), "Rowing{Enter}");
    expect(patches.at(-1)).toEqual({ zone2Machine: "row" });
    // Its field stays while Other is chosen, whatever was named.
    expect(screen.getByRole("textbox", { name: "Machine name" })).toBeTruthy();
    // An empty name changes nothing, and shows what is in force again.
    await user.clear(screen.getByRole("textbox", { name: "Machine name" }));
    await user.type(screen.getByRole("textbox", { name: "Machine name" }), "{Enter}");
    expect(patches).toHaveLength(2);
    expect(screen.getByRole("textbox", { name: "Machine name" })).toHaveProperty("value", "Rowing");
  });

  it("a day whose own name has no chip shows it under Other", () => {
    harness({ zone2Done: true, zone2Machine: "Stair climber" }, { last: ROWED_THU });
    expect(checkedName()).toBe("Other");
    expect(screen.getByRole("textbox", { name: "Machine name" })).toHaveProperty("value", "Stair climber");
    expect(caption().textContent).toBe("Your choice today");
  });

  it("a name another device writes meanwhile brings no field (nothing appears by itself above the fields)", () => {
    const logged = { ...emptyDayLog(DATE), zone2Done: true, zone2Minutes: 30, zone2Machine: "row" };
    const { rerender } = render(<Zone2Editor day={logged} patch={vi.fn()} last={ROWED_THU} />);
    expect(checkedName()).toBe("Row");
    rerender(<Zone2Editor day={{ ...logged, zone2Machine: "Stair climber" }} patch={vi.fn()} last={ROWED_THU} />);
    expect(checkedName()).toBeUndefined();
    expect(screen.queryByRole("textbox", { name: "Machine name" })).toBeNull();
    // Still one tab stop.
    expect(screen.getAllByRole("radio").filter((r) => r.tabIndex === 0)).toHaveLength(1);
  });

  it("on another day than today, a choice is that day's", async () => {
    const user = userEvent.setup();
    render(<Zone2Editor day={emptyDayLog(DATE)} patch={vi.fn()} last={ROWED_THU} today="2026-11-05" />);
    await user.click(radio("Ski"));
    expect(caption().textContent).toBe("Your choice that day");
  });
});

describe("Zone 2 row", () => {
  const items: ChecklistItem[] = [{ key: "zone2", label: "Zone 2", done: false, progress: 0 }];
  const done = [{ ...items[0]!, done: true, progress: 1 }];
  const lift = { href: "/train", label: undefined, primaryName: null, setsDone: 0, setsTotal: 0 };
  const props = { patch: vi.fn(), stepTarget: 15000, zone2Minutes: 30, lift };
  /** The row's text button (the dot beside it is "Zone 2 complete"). */
  const row = () => screen.getByRole("button", { name: /^Zone 2(?! complete)/ });

  it("summarises the machine kcal once logged, beside the minutes", () => {
    const { rerender } = render(<DayChecklist {...props} items={items} day={emptyDayLog(DATE)} />);
    expect(row().textContent).toBe("Zone 2Cycling");

    rerender(<DayChecklist {...props} items={done} day={{ ...emptyDayLog(DATE), zone2Done: true, zone2Minutes: 30, zone2Kcal: 1320 }} />);
    // The minutes sit beside the label (read first), the summary line under both.
    expect(row().textContent).toBe("Zone 230 minCycling · 1,320 kcal");

    // Without a reading (or a day cached by an older build): as before.
    const { zone2Kcal: _z, zone2Machine: _m, ...legacy } = { ...emptyDayLog(DATE), zone2Done: true, zone2Minutes: 30 };
    rerender(<DayChecklist {...props} items={done} day={legacy as DayLog} />);
    expect(row().textContent).toBe("Zone 230 minCycling");
    expect(row().textContent).not.toContain("kcal");
  });

  it("names the day's machine: its own once logged (none recorded: cycling), else the one it would be logged on", () => {
    const machines: Zone2Machines = { last: ROWED_THU, chips: PRESETS, today: DATE };
    const { rerender } = render(<DayChecklist {...props} items={items} day={emptyDayLog(DATE)} zone2Machines={machines} />);
    expect(row().textContent).toBe("Zone 2Rowing");
    const logged = { ...emptyDayLog(DATE), zone2Done: true, zone2Minutes: 30, zone2Kcal: 320 };
    rerender(<DayChecklist {...props} items={done} day={{ ...logged, zone2Machine: "row" }} zone2Machines={machines} />);
    expect(row().textContent).toBe("Zone 230 minRowing · 320 kcal");
    rerender(<DayChecklist {...props} items={done} day={{ ...logged, zone2Machine: "Assault bike" }} zone2Machines={machines} />);
    expect(row().textContent).toBe("Zone 230 minAssault bike · 320 kcal");
    rerender(<DayChecklist {...props} items={done} day={{ ...logged, zone2Machine: null }} zone2Machines={machines} />);
    expect(row().textContent).toBe("Zone 230 minCycling · 320 kcal");
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

  it("the dot logs the machine shown: the last one, or the one picked in the editor (even closed again)", async () => {
    const user = userEvent.setup();
    const patches: DayLogPatch[] = [];
    function Harness() {
      const [day, setDay] = useState<DayLog>(emptyDayLog(DATE));
      const logged = day.zone2Done;
      return (
        <DayChecklist
          {...props}
          items={logged ? done : items}
          day={day}
          patch={(p) => {
            patches.push(p);
            setDay((d) => ({ ...d, ...p }));
          }}
          zone2Machines={{ last: ROWED_THU, chips: PRESETS, today: DATE }}
        />
      );
    }
    render(<Harness />);
    await user.click(row());
    await user.click(radio("Ski"));
    expect(row().textContent).toBe("Zone 2Ski erg");
    await user.click(row()); // closed
    expect(patches).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Zone 2 complete" }));
    expect(patches).toEqual([{ zone2Done: true, zone2Minutes: 30, zone2Machine: "ski" }]);
    expect(row().textContent).toBe("Zone 230 minSki erg");
    // Un-ticked: nothing about the machine.
    await user.click(screen.getByRole("button", { name: "Zone 2 complete" }));
    expect(patches.at(-1)).toEqual({ zone2Done: false, zone2Minutes: 30 });
    // On a day with nothing picked, the dot logs the last one used.
    cleanup();
    const patch = vi.fn();
    render(
      <DayChecklist {...props} patch={patch} items={items} day={emptyDayLog(DATE)} zone2Machines={{ last: ROWED_THU, chips: PRESETS }} />,
    );
    await act(async () => screen.getByRole("button", { name: "Zone 2 complete" }).click());
    expect(patch).toHaveBeenCalledWith({ zone2Done: true, zone2Minutes: 30, zone2Machine: "row" });
  });
});
