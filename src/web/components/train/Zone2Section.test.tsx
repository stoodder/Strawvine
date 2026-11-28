/**
 * The Zone 2 section of a Train day (DESIGN A.2, A.4, A.8, B.4; mockups 05, 06, 07): the done check
 * in the head's check column (ticked with the plan's minutes when none are entered, as Today's row
 * does); Not today (`zone2Skipped`) only while nothing is logged — a machine alone isn't — with an
 * Undo toast and Bring back; the one-line summary ("Rowing · 35 min · 320 kcal") a folded section
 * shows, folded only at the fold moments; a minute count typed and not yet left saved when the app
 * is hidden; and nothing moving while a field is typed in.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../../../shared/defaults";
import { emptyDayLog } from "../../../shared/empty";
import type { DayLog, DayLogPatch } from "../../../shared/schemas";
import type { DayData } from "../../../shared/sections";
import { DockProvider } from "../Dock";
import { SectionHarness, type HarnessControl } from "../sections/harness";
import { ToastProvider } from "../Toast";
import { forgetFolds } from "./folds";
import { Zone2Section } from "./Zone2Section";

const store = vi.hoisted(() => ({ data: null as unknown }));
vi.mock("../../lib/store", () => ({ useData: () => ({ data: store.data }) }));
vi.mock("../../lib/sync", () => ({ currentData: () => store.data }));

const TODAY = "2026-11-10"; // a Tuesday: Zone 2 is planned (Mon–Fri), 30 min
const ids = { bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 };
const settings = { ...defaultSettings(ids, "2026-11-01"), onboarded: true };
const day = (date: string, o: Partial<DayLog>): DayLog => ({ ...emptyDayLog(date), ...o });
/** Rowed last Thursday: the machine today starts on. */
const ROWED_THU = day("2026-11-05", { zone2Done: true, zone2Minutes: 30, zone2Machine: "row" });

function setup(o: { days?: DayLog[]; date?: string; today?: string; added?: boolean } = {}) {
  const control: HarnessControl = { patches: [] as DayLogPatch[], external: () => {} };
  const data: DayData = { settings, days: o.days ?? [ROWED_THU], sessions: [], exercises: [], maxEntries: [] };
  render(
    <DockProvider>
      <ToastProvider>
        <SectionHarness
          Section={Zone2Section}
          kind="zone2"
          index={4}
          data={data}
          date={o.date ?? TODAY}
          today={o.today ?? TODAY}
          added={o.added}
          publish={(d) => (store.data = d)}
          control={control}
        />
      </ToastProvider>
    </DockProvider>,
  );
  return control;
}

afterEach(() => {
  cleanup();
  forgetFolds();
});

const section = () => screen.getByRole("region", { name: "Zone 2" });
const meta = () => document.getElementById(section().getAttribute("aria-describedby")!)!.textContent;
const check = () => screen.getByRole("button", { name: "Zone 2 complete" });
const notToday = () => screen.queryByRole("button", { name: "Not today: Zone 2" });
const bringBack = () => screen.queryByRole("button", { name: "Bring back Zone 2" });
const minutes = () => screen.queryByRole("textbox", { name: "Zone 2 minutes" }) as HTMLInputElement | null;
const kcal = () => screen.getByRole("textbox", { name: "Zone 2 machine calories" });
const machine = () => screen.getByRole("combobox", { name: "Machine" }) as HTMLSelectElement;
const live = () =>
  screen
    .getAllByRole("status")
    .map((s) => s.textContent)
    .join(" ");
const hide = () => {
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
};
const show = () => {
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
};

describe("Zone2Section", () => {
  it("is a numbered section: the plan's minutes under the title, the check in the head, then minutes, reading and the machine line", () => {
    setup();
    const s = section();
    expect(s.id).toBe("zone2");
    expect(s.querySelector("[data-index]")!.textContent).toBe("04");
    expect(meta()).toBe("30 min planned");
    const head = s.querySelector("h2")!.parentElement!;
    expect(head.contains(check())).toBe(true);
    expect(head.contains(notToday())).toBe(true);
    expect(head.contains(minutes())).toBe(false);
    // The one machine line (not chips): the last one used.
    expect(machine().value).toBe("row");
    expect(within(s).queryAllByRole("combobox")).toHaveLength(1);
  });

  it("ticks off with its check, with the plan's minutes and the machine shown — through the day's save — and stays open in use", async () => {
    const user = userEvent.setup();
    const control = setup();
    await user.click(check());
    expect(control.patches).toEqual([{ zone2Done: true, zone2Minutes: 30 }]);
    expect(check().getAttribute("aria-pressed")).toBe("true");
    expect(section().dataset.state).toBe("done");
    expect(meta()).toBe("Rowing · 30 min");
    expect(notToday()).toBeNull();
    expect(minutes()).toBeTruthy();
    // Untick: done goes, the minutes stay (logged: In progress, no Not today).
    await user.click(check());
    expect(control.patches.at(-1)).toEqual({ zone2Done: false, zone2Minutes: 30 });
    expect(section().dataset.state).toBe("active");
    expect(notToday()).toBeNull();
  });

  it("summarises machine · minutes · kcal, and folds to that line at a fold moment (never while in use); the chevron opens it", async () => {
    const user = userEvent.setup();
    const control = setup();
    await user.selectOptions(machine(), "bike");
    await user.click(minutes()!);
    await user.type(minutes()!, "35");
    await user.click(kcal());
    await user.type(kcal(), "320");
    await user.tab();
    expect(control.patches).toEqual([{ zone2Machine: "bike" }, { zone2Minutes: 35, zone2Done: true }, { zone2Kcal: 320 }]);
    expect(meta()).toBe("Cycling · 35 min · 320 kcal");
    expect(minutes()).toBeTruthy();
    act(() => {
      hide();
      show();
    });
    expect(minutes()).toBeNull();
    expect(meta()).toBe("Cycling · 35 min · 320 kcal");
    await user.click(screen.getByRole("button", { name: "Show Zone 2" }));
    expect(minutes()!.value).toBe("35");
    expect(screen.getByRole("button", { name: "Fold Zone 2" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("a machine alone is not Zone 2: Not today is still offered; a reading is, and takes it away", async () => {
    const user = userEvent.setup();
    const control = setup();
    await user.selectOptions(machine(), "ski");
    expect(control.patches).toEqual([{ zone2Machine: "ski" }]);
    expect(section().dataset.state).toBe("todo");
    expect(notToday()).toBeTruthy();
    await user.type(kcal(), "200");
    await user.tab();
    expect(section().dataset.state).toBe("active");
    expect(notToday()).toBeNull();
    expect(meta()).toBe("Ski erg · 200 kcal");
  });

  it("Not today: saves zone2Skipped, one muted line and Bring back; Undo (live, own field only) and Bring back clear it", async () => {
    const user = userEvent.setup();
    const control = setup();
    await user.click(notToday()!);
    expect(control.patches).toEqual([{ zone2Skipped: true }]);
    expect(section().dataset.state).toBe("skipped");
    expect(minutes()).toBeNull();
    expect(screen.queryByRole("button", { name: "Zone 2 complete" })).toBeNull();
    expect(meta()).toBe("30 min planned");
    await vi.waitFor(() => expect(document.activeElement).toBe(bringBack()));
    expect(live()).toContain("Zone 2: not today");
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(control.patches.at(-1)).toEqual({ zone2Skipped: false });
    expect(minutes()).toBeTruthy();

    await user.click(notToday()!);
    await user.click(bringBack()!);
    expect(control.patches.slice(-2)).toEqual([{ zone2Skipped: true }, { zone2Skipped: false }]);
    await vi.waitFor(() => expect(document.activeElement).toBe(within(section()).getByRole("heading", { level: 2 })));
  });

  it("commits minutes typed and not yet left when the app is hidden: once, ticking Zone 2 off, with the machine shown", async () => {
    const user = userEvent.setup();
    const control = setup();
    await user.click(minutes()!);
    await user.keyboard("40");
    act(() => hide());
    act(() => show());
    expect(control.patches).toEqual([{ zone2Minutes: 40, zone2Done: true }]);
    expect(store.data && (store.data as DayData).days.find((d) => d.date === TODAY)?.zone2Machine).toBe("row");
    expect(meta()).toBe("Rowing · 40 min");
    // In use when hidden (the field still had focus): back in the foreground, it folds — the field's value was saved first.
    expect(minutes()).toBeNull();
  });

  it("typing stays put: the fields are the same elements as values save, and a skip saved elsewhere waits until no field has focus", async () => {
    const user = userEvent.setup();
    const control = setup();
    const min = minutes()!;
    const k = kcal();
    await user.click(min);
    await user.keyboard("35");
    // Field to field: the minutes are saved as they are left; done now, nothing moved.
    await user.click(k);
    expect(control.patches).toEqual([{ zone2Minutes: 35, zone2Done: true }]);
    expect(minutes()).toBe(min);
    expect(kcal()).toBe(k);
    expect(document.activeElement).toBe(k);
    expect(section().dataset.state).toBe("done");
    expect(minutes()).toBeTruthy();

    // Brought back from done elsewhere and skipped there: the body stays while the reading is typed in.
    act(() => control.external({ zone2Done: false, zone2Minutes: null, zone2Skipped: true }));
    expect(kcal()).toBe(k);
    expect(bringBack()).toBeNull();
    act(() => k.blur());
    fireEvent.click(document.body);
    await vi.waitFor(() => expect(section().dataset.state).toBe("skipped"));
    expect(minutes()).toBeNull();
  });

  it("an added section says so and offers Remove; a preview says the plan and the machine, with nothing to press", async () => {
    const user = userEvent.setup();
    // Sunday: no Zone 2 planned.
    setup({ date: "2026-11-08", today: "2026-11-08", added: true });
    expect(meta()).toBe("Added for today");
    expect(notToday()).toBeNull();
    expect(minutes()).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Remove Zone 2" }));
    expect(screen.queryByRole("region", { name: "Zone 2" })).toBeNull();
    cleanup();

    setup({ date: "2026-11-11" });
    expect(section().dataset.state).toBe("planned");
    expect(meta()).toBe("30 min planned · Rowing");
    expect(screen.queryByRole("button", { name: "Zone 2 complete" })).toBeNull();
    expect(notToday()).toBeNull();
    expect(minutes()).toBeNull();
  });
});
