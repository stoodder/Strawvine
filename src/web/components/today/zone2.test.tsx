/**
 * The Zone 2 editor and row (SPEC §3, §3.5): the machine (one line with a native select, the last one used shown,
 * written at once when chosen), and the machine kcal reading — a reading only: it doesn't tick the session off, and
 * nothing but this row and the check-in reads it. (The machine a first Zone 2 value is saved with when none was chosen
 * is the day's save's: lib/store.test.tsx.)
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { emptyDayLog } from "../../../shared/empty";
import type { ChecklistItem } from "../../../shared/gamify";
import type { DayLog, DayLogPatch } from "../../../shared/schemas";
import { fillZone2Machine, type LastZone2Machine } from "../../../shared/zone2";
import { DayChecklist, type Zone2Machines } from "./Checklist";
import { Zone2Editor } from "./editors";

const DATE = "2026-11-03"; // a Tuesday
const ROWED_THU: LastZone2Machine = { machine: "row", from: "2026-10-29" };
const PRESETS = ["bike", "row", "elliptical", "ski"];

/** Renders the editor over a day that takes its own patches, recording each one. */
function harness(initial: Partial<DayLog> = {}, machines: { last?: LastZone2Machine; machines?: string[] } = {}) {
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
        {...machines}
      />
    );
  }
  const view = render(<Harness />);
  return { patches, ...view };
}

const select = () => screen.getByRole("combobox", { name: "Machine" }) as HTMLSelectElement;
/** What the machine's line says, as drawn ("Machine · Rowing"). */
const line = () => [...select().parentElement!.querySelectorAll("span[aria-hidden]")].map((s) => s.textContent).join(" ");
const options = () =>
  within(select())
    .getAllByRole("option")
    .map((o) => o.textContent);
const nameField = () => screen.queryByRole("textbox", { name: "Machine name" });
const hide = () => {
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
};

describe("Zone2Editor", () => {
  it("commits the machine kcal as a whole number, on its own (the session isn't ticked off by it)", async () => {
    const user = userEvent.setup();
    const { patches } = harness();
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
    const { patches } = harness({ zone2Done: true, zone2Minutes: 30, zone2Kcal: 320 });
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
    expect(select().value).toBe("bike");
    expect(line()).toBe("Machine · Cycling");
  });
});

describe("Zone2Editor: the machine", () => {
  it("is one line under the minutes and the reading: a select, the last one used shown", () => {
    harness({}, { last: ROWED_THU, machines: [...PRESETS, "Assault bike"] });
    // The minutes are the editor's first field; the machine comes after the reading.
    const fields = screen.getAllByRole("textbox").concat(select());
    expect(fields[0]).toBe(screen.getByRole("textbox", { name: "Zone 2 minutes" }));
    const caption = screen.getByText("Machine reading · not added to intake");
    expect(caption.compareDocumentPosition(select()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(options()).toEqual(["Bike", "Row", "Elliptical", "Ski", "Assault bike", "Other…"]);
    expect(select().value).toBe("row");
    expect(line()).toBe("Machine · Rowing");
    // Nothing earlier: the bike.
    cleanup();
    harness();
    expect(line()).toBe("Machine · Cycling");
    expect(options()).toEqual(["Bike", "Row", "Elliptical", "Ski", "Other…"]);
  });

  it("a choice is written at once, even on a day with nothing else logged", async () => {
    const user = userEvent.setup();
    const { patches } = harness({}, { last: ROWED_THU });
    await user.selectOptions(select(), "Ski");
    expect(patches).toEqual([{ zone2Machine: "ski" }]);
    expect(line()).toBe("Machine · Ski erg");
    // The last one again: chosen, so written too (the day's own from now on).
    await user.selectOptions(select(), "Row");
    expect(patches.at(-1)).toEqual({ zone2Machine: "row" });
    // A later value is a value only: the day has its machine.
    await user.type(screen.getByRole("textbox", { name: "Zone 2 minutes" }), "40{Enter}");
    expect(patches.at(-1)).toEqual({ zone2Minutes: 40, zone2Done: true });
    expect(line()).toBe("Machine · Rowing");
  });

  it("on a day logged before machines were, a choice writes the machine (it read as the bike)", async () => {
    const user = userEvent.setup();
    const { patches } = harness({ zone2Done: true, zone2Minutes: 30 }, { last: ROWED_THU });
    expect(select().value).toBe("bike");
    await user.selectOptions(select(), "Row");
    expect(patches).toEqual([{ zone2Machine: "row" }]);
  });

  it("Other… shows a name field under the line, the last thing in the editor, and changes nothing until a name is given", async () => {
    const user = userEvent.setup();
    const { patches, container } = harness({}, { last: ROWED_THU });
    expect(nameField()).toBeNull();
    await user.selectOptions(select(), "Other…");
    const name = nameField()!;
    expect(document.activeElement).toBe(name);
    // Under everything: the last field of the editor.
    expect(container.querySelectorAll("input, select")[container.querySelectorAll("input, select").length - 1]).toBe(name);
    // The line still says the machine in force; nothing is written.
    expect(select().value).toBe("row");
    expect(line()).toBe("Machine · Rowing");
    expect(patches).toEqual([]);
    // An empty name, or one of spaces: nothing.
    await user.type(name, "   {Enter}");
    expect(patches).toEqual([]);
    // Named: written at once, the line and the options say it; the field stays (leaving it moves nothing below).
    await user.type(name, "  Assault   bike {Enter}");
    expect(patches).toEqual([{ zone2Machine: "Assault bike" }]);
    expect(line()).toBe("Machine · Assault bike");
    expect(options()).toEqual(["Bike", "Row", "Elliptical", "Ski", "Assault bike", "Other…"]);
    expect(select().value).toBe("Assault bike");
    expect(nameField()).toBeTruthy();
    // A common machine's name is that machine.
    await user.clear(name);
    await user.type(name, "Rowing{Enter}");
    expect(patches.at(-1)).toEqual({ zone2Machine: "row" });
    // A machine chosen in the select takes the name field away.
    await user.selectOptions(select(), "Ski");
    expect(nameField()).toBeNull();
    expect(patches.at(-1)).toEqual({ zone2Machine: "ski" });
  });

  it("a name spelt like one offered is that one", async () => {
    const user = userEvent.setup();
    const { patches } = harness({}, { machines: [...PRESETS, "Assault bike"] });
    await user.selectOptions(select(), "Other…");
    await user.type(nameField()!, "assault-BIKE{Enter}");
    expect(patches).toEqual([{ zone2Machine: "Assault bike" }]);
    expect(options()).toEqual(["Bike", "Row", "Elliptical", "Ski", "Assault bike", "Other…"]);
  });

  it("a name typed is saved when the app is hidden, or the editor closes, before it is left — once", async () => {
    const user = userEvent.setup();
    const { patches, unmount } = harness({}, { last: ROWED_THU });
    await user.selectOptions(select(), "Other…");
    await user.type(nameField()!, "Stair climber");
    hide();
    expect(patches).toEqual([{ zone2Machine: "Stair climber" }]);
    act(() => nameField()!.blur());
    expect(patches).toHaveLength(1);
    // Typed again and the editor closed with it focused.
    await user.clear(nameField()!);
    await user.type(nameField()!, "Air bike");
    unmount();
    expect(patches.at(-1)).toEqual({ zone2Machine: "Air bike" });
    expect(patches).toHaveLength(2);
  });

  it("a day's own name older than the names offered is offered still, and shown", () => {
    harness({ zone2Done: true, zone2Machine: "Stair climber" }, { last: ROWED_THU });
    expect(options()).toEqual(["Bike", "Row", "Elliptical", "Ski", "Stair climber", "Other…"]);
    expect(select().value).toBe("Stair climber");
    expect(line()).toBe("Machine · Stair climber");
    expect(nameField()).toBeNull();
  });

  it("a machine another device writes meanwhile is said in the line, and brings no field", () => {
    const logged = { ...emptyDayLog(DATE), zone2Done: true, zone2Minutes: 30, zone2Machine: "row" };
    const { rerender } = render(<Zone2Editor day={logged} patch={vi.fn()} last={ROWED_THU} />);
    rerender(<Zone2Editor day={{ ...logged, zone2Machine: "Stair climber" }} patch={vi.fn()} last={ROWED_THU} />);
    expect(line()).toBe("Machine · Stair climber");
    expect(nameField()).toBeNull();
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

  it("names the day's machine: its own (none recorded with Zone 2 logged: cycling), else the last one used", () => {
    const machines: Zone2Machines = { last: ROWED_THU, machines: PRESETS };
    const { rerender } = render(<DayChecklist {...props} items={items} day={emptyDayLog(DATE)} zone2Machines={machines} />);
    expect(row().textContent).toBe("Zone 2Rowing");
    // Chosen, nothing logged yet.
    rerender(<DayChecklist {...props} items={items} day={{ ...emptyDayLog(DATE), zone2Machine: "ski" }} zone2Machines={machines} />);
    expect(row().textContent).toBe("Zone 2Ski erg");
    const logged = { ...emptyDayLog(DATE), zone2Done: true, zone2Minutes: 30, zone2Kcal: 320 };
    rerender(<DayChecklist {...props} items={done} day={{ ...logged, zone2Machine: "row" }} zone2Machines={machines} />);
    expect(row().textContent).toBe("Zone 230 minRowing · 320 kcal");
    rerender(<DayChecklist {...props} items={done} day={{ ...logged, zone2Machine: "Assault bike" }} zone2Machines={machines} />);
    expect(row().textContent).toBe("Zone 230 minAssault bike · 320 kcal");
    rerender(<DayChecklist {...props} items={done} day={{ ...logged, zone2Machine: null }} zone2Machines={machines} />);
    expect(row().textContent).toBe("Zone 230 minCycling · 320 kcal");
  });

  it("a long name gives way, never the reading", () => {
    const name = "A very long machine name, longer than it";
    render(
      <DayChecklist
        {...props}
        items={done}
        day={{ ...emptyDayLog(DATE), zone2Done: true, zone2Minutes: 30, zone2Kcal: 320, zone2Machine: name }}
      />,
    );
    const activity = within(row()).getByText(name);
    expect(activity.className).toContain("truncate");
    const reading = within(row()).getByText("· 320 kcal", { exact: false });
    expect(reading.className).toContain("shrink-0");
    expect(reading.className).not.toContain("truncate");
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

  it("a machine chosen, the editor closed, then the dot: the day is logged on the machine chosen", async () => {
    const user = userEvent.setup();
    const patches: DayLogPatch[] = [];
    function Harness() {
      const [day, setDay] = useState<DayLog>(emptyDayLog(DATE));
      return (
        <DayChecklist
          {...props}
          items={day.zone2Done ? done : items}
          day={day}
          // As the day's save does (`useSaveDay`): a first value without a machine gets the last one used.
          patch={(p) => {
            const filled = fillZone2Machine(day, p, ROWED_THU.machine);
            patches.push(filled);
            setDay((d) => ({ ...d, ...filled }));
          }}
          zone2Machines={{ last: ROWED_THU, machines: PRESETS }}
        />
      );
    }
    render(<Harness />);
    await user.click(row());
    await user.selectOptions(select(), "Ski");
    expect(patches).toEqual([{ zone2Machine: "ski" }]);
    await user.click(row()); // closed
    await user.click(screen.getByRole("button", { name: "Zone 2 complete" }));
    expect(patches.at(-1)).toEqual({ zone2Done: true, zone2Minutes: 30 });
    expect(row().textContent).toBe("Zone 230 minSki erg");
    // Un-ticked: the machine stays the day's.
    await user.click(screen.getByRole("button", { name: "Zone 2 complete" }));
    expect(patches.at(-1)).toEqual({ zone2Done: false, zone2Minutes: 30 });
    expect(row().textContent).toBe("Zone 2Ski erg");
    // Nothing chosen: the dot's value is saved with the last one used.
    cleanup();
    patches.length = 0;
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Zone 2 complete" }));
    expect(patches).toEqual([{ zone2Done: true, zone2Minutes: 30, zone2Machine: "row" }]);
    expect(row().textContent).toBe("Zone 230 minRowing");
  });
});
