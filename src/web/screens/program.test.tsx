/**
 * Program and the slimmed Settings: the training program's controls live on Program and save
 * exactly what they saved on Settings (one settings document, one save path); the cycle is
 * delayed / skipped ahead a week with one folded, conditional Undo; every Undo works on the
 * settings as they are when it is tapped (also after leaving the screen); a lifting day switched
 * off comes back as it was; Settings keeps the preferences and a link to Program; old Settings
 * anchors of moved sections land on Program.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../../shared/defaults";
import { settingsSchema, type Exercise, type Program, type Settings } from "../../shared/schemas";
import { shiftEffect, SHIFT_GUARD_MS } from "../components/program/ProgramSections";
import { programPathForSettingsHash } from "../components/program/sections";
import { UNDO_MS } from "../components/settings/undo";
import { readableIssue } from "../components/settings/useSettingsEditor";
import { programBackTarget, ProgramScreen } from "./Program";
import { SettingsScreen } from "./Settings";

// Wednesday of week 1 (the cycle starts Monday Nov 2).
const TODAY = "2026-11-04";

type Toast = { message: string; tone?: string; duration?: number; action?: { label: string; onAction: () => void } };

/**
 * A tiny stand-in for the data layer. `data` is its current copy — what `currentData()` returns
 * and what the screens render after `save` (or `remote`) notifies them; `arrive` changes it
 * without a render, as an edit does in the moment before the screen catches up.
 */
const store = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  type S = import("../../shared/schemas").Settings;
  type E = import("../../shared/schemas").Exercise;
  const state = {
    data: null as unknown as { settings: S; exercises: E[] },
    today: "",
    listeners,
    saved: [] as S[],
    /** When set, the next save is stored but its promise rejects with this. */
    failNext: undefined as unknown,
    toasts: [] as Array<{ message: string; tone?: string; duration?: number; action?: { label: string; onAction: () => void } }>,
    dismissed: [] as number[],
    created: [] as unknown[],
    reset(settings: S, exercises: E[], today: string) {
      state.saved = [];
      state.toasts = [];
      state.dismissed = [];
      state.created = [];
      state.failNext = undefined;
      state.today = today;
      state.data = { settings, exercises };
    },
    arrive(next: S) {
      state.data = { ...state.data, settings: next };
    },
    remote(next: S) {
      state.arrive(next);
      for (const l of listeners) l();
    },
    save(next: S) {
      state.saved.push(next);
      state.remote(next);
      if (state.failNext === undefined) return Promise.resolve(next);
      const reason = state.failNext;
      state.failNext = undefined;
      return Promise.reject(reason);
    },
  };
  return state;
});
vi.mock("../lib/store", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (l: () => void) => {
    store.listeners.add(l);
    return () => store.listeners.delete(l);
  };
  return {
    useData: () => ({ data: useSyncExternalStore(subscribe, () => store.data), today: store.today }),
    useSaveSettings: () => store.save,
    useCreateExercise: () => (input: unknown) => {
      store.created.push(input);
      return Promise.resolve(input);
    },
    useEditExercise: () => vi.fn(),
    useSyncInfo: () => ({
      online: true,
      pending: 0,
      failed: 0,
      unsynced: 0,
      lastSyncedAt: null,
      items: [],
      refused: [],
      syncNow: vi.fn(),
      retryFailed: vi.fn(),
      discardFailed: vi.fn(),
      clearRefused: vi.fn(),
    }),
    signOut: vi.fn(),
    forgetDevice: vi.fn(),
  };
});
vi.mock("../lib/sync", () => ({ currentData: () => store.data }));
vi.mock("../components/Toast", () => ({
  useToast: () => ({
    show: (t: Toast) => store.toasts.push(t),
    dismiss: (id: number) => void store.dismissed.push(id),
  }),
}));

const exercise = (id: number, name: string, o: Partial<Exercise> = {}): Exercise => ({
  id,
  name,
  category: "primary",
  tracksMax: true,
  measure: "reps",
  weighted: true,
  archived: false,
  ...o,
});
const EXERCISES = [
  exercise(1, "Bench press"),
  exercise(2, "Deadlift"),
  exercise(3, "Back squat"),
  exercise(4, "Front squat"),
  exercise(5, "Strict press"),
  exercise(10, "Pull-up", { category: "accessory", tracksMax: false, weighted: false }),
  exercise(11, "Sled push", { category: "accessory", tracksMax: false, archived: true }),
];
const base = (): Settings => ({
  ...defaultSettings({ bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 }, "2026-11-02"),
  onboarded: true,
});
/** The default settings with the program changed. */
const withProgram = (p: Partial<Program>): Settings => ({ ...base(), program: { ...base().program, ...p } });
const reset = (settings: Settings = base(), today = TODAY) => store.reset(settings, EXERCISES, today);

/** The clock the shift guard and the Undo folding read (`Date.now`). */
let clock = 0;
beforeEach(() => {
  reset();
  clock = Date.parse("2026-11-04T10:00:00Z");
  vi.spyOn(Date, "now").mockImplementation(() => clock);
});
afterEach(() => vi.restoreAllMocks());

function Where() {
  const { pathname, hash } = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="where">{pathname + hash}</output>
      <Link to="/settings">go to settings</Link>
      <button type="button" onClick={() => navigate(-1)}>
        browser back
      </button>
    </>
  );
}
const show = (at: string | { pathname: string; state?: unknown } = "/program", history: string[] = []) =>
  render(
    <MemoryRouter initialEntries={[...history, at]}>
      <Routes>
        <Route path="/program" element={<ProgramScreen />} />
        <Route path="/settings" element={<SettingsScreen />} />
        <Route path="/train" element={<h1>Train</h1>} />
        <Route path="/train/:date" element={<h1>Train day</h1>} />
        <Route path="/" element={<h1>Today</h1>} />
      </Routes>
      <Where />
    </MemoryRouter>,
  );
const where = () => screen.getByTestId("where").textContent;
const lastSaved = () => store.saved.at(-1)!;
const lastToast = () => store.toasts.at(-1)!;
/** Taps a toast's Undo (the newest toast's, unless told otherwise). */
const undo = (toast: Toast = lastToast()) => act(() => toast.action!.onAction());
const start = () => store.data.settings.program.cycleStartDate;
/** The one thing a save changed: `saved` minus `path` equals the settings before it. */
const onlyChanged = (before: Settings, after: Settings, key: "program" | "training") => {
  const { [key]: _a, ...restBefore } = before;
  const { [key]: _b, ...restAfter } = after;
  expect(restAfter).toEqual(restBefore);
};
const type = async (user: ReturnType<typeof userEvent.setup>, field: HTMLElement, text: string) => {
  await user.clear(field);
  await user.type(field, text);
  await user.tab();
};
const sectionHeadings = () => screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
const delay = () => screen.getByRole("button", { name: "Delay a week" });
const skip = () => screen.getByRole("button", { name: "Skip ahead a week" });
const dateField = () => screen.getByLabelText<HTMLInputElement>("Cycle start date");
const described = (el: HTMLElement) => document.getElementById(el.getAttribute("aria-describedby")!)!.textContent;
/** Leaves Program for Settings and changes the steps target there. */
const changeStepsOnSettings = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("link", { name: "go to settings" }));
  expect(where()).toBe("/settings");
  await type(user, screen.getByRole("textbox", { name: "Steps" }), "12000");
  expect(store.data.settings.targets.steps).toBe(12000);
};

describe("Program", () => {
  it("is titled Program under the program's name, with the program's sections in order and a way back to Train", () => {
    show();
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.textContent).toBe("Program");
    expect(document.querySelector("[data-program-name]")!.textContent).toBe(base().program.name);
    expect(h1.nextElementSibling!.textContent).toBe("The program Train follows. Change it and the sessions ahead recalculate.");
    expect(sectionHeadings()).toEqual(["Now", "Weekly layout", "Cycle weeks", "Rules", "Rep-max table", "Exercise library"]);
    expect(screen.getByRole("link", { name: "Back to Train" }).getAttribute("href")).toBe("/train");
    const jumps = within(screen.getByRole("navigation", { name: "Program sections" })).getAllByRole("link");
    expect(jumps.map((a) => a.getAttribute("href"))).toEqual(["#now", "#layout", "#weeks", "#rules", "#rep-max", "#library"]);
    for (const a of jumps) expect(document.getElementById(a.getAttribute("href")!.slice(1))?.tagName).toBe("SECTION");
  });

  describe("the way back", () => {
    it.each([
      ["/train", "/train", "Back to Train"],
      ["/train/2026-10-19", "/train/2026-10-19", "Back to Train"],
      ["/settings", "/settings", "Back to Settings"],
      ["/settings#schedule", "/settings#schedule", "Back to Settings"],
    ])("from %s it leads back there", (from, to, label) => {
      expect(programBackTarget({ from })).toEqual({ to, label });
    });

    it.each([
      "/",
      "/goals",
      "/progress?view=body",
      "/program",
      "/trainers",
      "/train/",
      "/train/2026-10-19/extra",
      "/train/../settings",
      "/train?next=//example.com",
      "/settings/extra",
      "/settingsx",
      "//example.com/train",
      "https://example.com/train",
      "train",
      "",
      42,
      null,
      { pathname: "/train" },
    ])("any other origin (%j) leads to Train", (from) => {
      expect(programBackTarget({ from })).toEqual({ to: "/train", label: "Back to Train" });
    });

    it("without a state it leads to Train", () => {
      expect(programBackTarget(null)).toEqual({ to: "/train", label: "Back to Train" });
      expect(programBackTarget(undefined)).toEqual({ to: "/train", label: "Back to Train" });
      expect(programBackTarget("/settings")).toEqual({ to: "/train", label: "Back to Train" });
    });

    it("the control is named after where it goes, and goes there", async () => {
      const user = userEvent.setup();
      show({ pathname: "/program", state: { from: "/train/2026-10-19" } });
      const back = screen.getByRole("link", { name: "Back to Train" });
      expect(back.getAttribute("href")).toBe("/train/2026-10-19");
      expect(screen.queryByRole("link", { name: "Back to Settings" })).toBeNull();
      await user.click(back);
      expect(where()).toBe("/train/2026-10-19");
    });

    it("opened from Settings' Training program row, it leads back to that part of Settings", async () => {
      const user = userEvent.setup();
      show("/settings");
      await user.click(screen.getByRole("link", { name: /Training program/ }));
      expect(where()).toBe("/program");
      expect(screen.queryByRole("link", { name: "Back to Train" })).toBeNull();
      await user.click(screen.getByRole("link", { name: "Back to Settings" }));
      expect(where()).toBe("/settings#schedule");
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Settings");
      expect(document.activeElement?.textContent).toBe("Schedule");
    });
  });

  describe("Now", () => {
    const now = () => document.querySelector("[data-cycle-now]")!.textContent;

    it("says where the cycle is", () => {
      show();
      expect(now()).toContain("Cycle 1 · Week 1 of 5");
      expect(now()).toContain("Nov 2 – Nov 8 · cycle ends Dec 6");
    });

    it("notes a deload week", () => {
      // Four weeks on: week 5, the deload.
      reset(withProgram({ cycleStartDate: "2026-10-05" }));
      const first = show();
      expect(now()).toContain("Cycle 1 · Week 5 of 5");
      expect(now()).toContain("Deload · Nov 2 – Nov 8");
      first.unmount();

      const weeks = base().program.weeks.map((w, i) => (i === 4 ? { ...w, label: "Easy" } : w));
      reset(withProgram({ cycleStartDate: "2026-10-05", weeks }));
      show();
      expect(now()).toContain("Easy · Deload week · Nov 2 – Nov 8");
    });

    it.each([
      // start, today, headline, detail
      ["2026-11-09", "2026-11-04", "Starts next Monday", "Cycle 1 · Week 1 of 5 begins Mon Nov 9, in 5 days"],
      ["2026-11-09", "2026-11-08", "Starts tomorrow", "Cycle 1 · Week 1 of 5 begins Mon Nov 9"],
      // A start stored before starts snapped to Mondays: later this same week.
      ["2026-11-05", "2026-11-02", "Starts this Thursday", "Cycle 1 · Week 1 of 5 begins Thu Nov 5, in 3 days"],
      ["2026-11-23", "2026-11-04", "Starts Mon Nov 23", "Cycle 1 · Week 1 of 5 begins Mon Nov 23, in 19 days"],
    ])("a program starting %s, seen on %s: “%s”", (cycleStartDate, today, headline, detail) => {
      reset(withProgram({ cycleStartDate }), today);
      show();
      expect(document.querySelector("[data-cycle-now] p")!.textContent).toBe(headline);
      expect(now()).toContain(detail);
      // "in 1 days" is never said.
      expect(now()).not.toMatch(/in 1 days/);
    });
  });

  it("has every control that moved from Settings", () => {
    show();
    const box = (name: string) => screen.getByRole("textbox", { name });
    const toggle = (name: string) => screen.getByRole("switch", { name });
    // Now
    expect((box("Program name") as HTMLInputElement).value).toBe(base().program.name);
    expect(dateField().value).toBe("2026-11-02");
    expect(delay()).toBeTruthy();
    expect(skip()).toBeTruthy();
    // Weekly layout: seven days, the five lifting days with a name, a main lift and the AMRAP switch
    for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) expect(toggle(`${d} lifting day`)).toBeTruthy();
    for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri"]) {
      expect(box(`${d} session name`)).toBeTruthy();
      expect(screen.getByRole("combobox", { name: `${d} main lift` })).toBeTruthy();
      expect(toggle(`${d} AMRAP progression`)).toBeTruthy();
    }
    expect(screen.queryByRole("textbox", { name: "Sat session name" })).toBeNull();
    // Cycle weeks
    for (const n of [1, 2, 3, 4, 5]) {
      expect(box(`Week ${n} name`)).toBeTruthy();
      expect(box(`Week ${n} reps per set`)).toBeTruthy();
      expect(toggle(`Week ${n} deload`)).toBeTruthy();
      expect(screen.getByRole("button", { name: `Remove week ${n}` })).toBeTruthy();
    }
    expect((box("Week 5 load based on rep max") as HTMLInputElement).value).toBe("12");
    expect(screen.getByRole("button", { name: "Week" })).toBeTruthy();
    // Rules: the program's, then what was Settings → Training
    expect((box("Working weight") as HTMLInputElement).value).toBe("90");
    expect((box("Round weights to") as HTMLInputElement).value).toBe("5");
    expect(toggle("AMRAP last set").getAttribute("aria-checked")).toBe("true");
    expect(toggle("Auto progression").getAttribute("aria-checked")).toBe("true");
    expect((box("Per extra rep") as HTMLInputElement).value).toBe("1");
    expect((box("Deload accessories") as HTMLInputElement).value).toBe("80");
    expect(box("Accessory increment")).toBeTruthy();
    expect((box("Main lift rest") as HTMLInputElement).value).toBe("3:00");
    expect(box("Accessory rest")).toBeTruthy();
    const rules = document.getElementById("rules")!;
    for (const name of ["Working weight", "Accessory increment", "Main lift rest", "Accessory rest"])
      expect(rules.contains(box(name)), `${name} is under Rules`).toBe(true);
    // Rep-max table
    for (const r of [1, 2, 3, 4, 5, 6, 8, 10, 12]) expect(box(`${r} RM percent of max`)).toBeTruthy();
    // Exercise library
    expect(screen.getByRole("button", { name: "Edit Bench press" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit Sled push" })).toBeNull();
    expect(screen.getByRole("button", { name: "show archived" })).toBeTruthy();
    expect(box("New lift name")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Tracked lift" })).toBeTruthy();
  });

  it("saves the same fields the controls saved on Settings, and nothing else", async () => {
    const user = userEvent.setup();
    show();
    const box = (name: string) => screen.getByRole("textbox", { name });
    let before = store.data.settings;
    /** After an edit: one save, touching only `key`; returns what that key holds now. */
    const saved = <K extends "program" | "training">(key: K): NonNullable<Settings[K]> => {
      const after = lastSaved();
      expect(settingsSchema.safeParse(after).success).toBe(true);
      onlyChanged(before, after, key);
      before = after;
      return after[key]!;
    };
    const p0 = before.program;

    await type(user, box("Program name"), "Autumn block");
    expect(saved("program")).toEqual({ ...p0, name: "Autumn block" });

    // A Thursday: the start snaps to that week's Monday.
    fireEvent.change(dateField(), { target: { value: "2026-11-12" } });
    expect(saved("program").cycleStartDate).toBe("2026-11-09");

    await type(user, box("Working weight"), "85");
    expect(saved("program").intensity).toBe(0.85);
    await type(user, box("Round weights to"), "2.5");
    expect(saved("program").roundToLb).toBe(2.5);
    await user.click(screen.getByRole("switch", { name: "AMRAP last set" }));
    expect(saved("program").amrapLastSet).toBe(false);
    await type(user, box("Per extra rep"), "2.5");
    expect(saved("program").progression).toEqual({ enabled: true, lbPerExtraRep: 2.5 });
    await user.click(screen.getByRole("switch", { name: "Auto progression" }));
    expect(saved("program").progression).toEqual({ enabled: false, lbPerExtraRep: 2.5 });
    expect(screen.queryByRole("textbox", { name: "Per extra rep" })).toBeNull();
    await type(user, box("Deload accessories"), "70");
    expect(saved("program").deloadAccessoryLoad).toBe(0.7);

    // What was Settings → Training: the same three fields of `training`.
    await type(user, box("Accessory increment"), "10");
    expect(saved("training")).toEqual({ restSecondsMain: 180, restSecondsAccessory: 90, accessoryIncrementLb: 10 });
    await type(user, box("Main lift rest"), "230");
    expect(saved("training").restSecondsMain).toBe(150);
    await type(user, box("Accessory rest"), "1:15");
    expect(saved("training")).toEqual({ restSecondsMain: 150, restSecondsAccessory: 75, accessoryIncrementLb: 10 });

    // Weekly layout
    await user.selectOptions(screen.getByRole("combobox", { name: "Mon main lift" }), "Front squat");
    expect(saved("program").days["1"]).toEqual({ ...p0.days["1"]!, primaryExerciseId: 4 });
    await type(user, box("Tue session name"), "Hinge");
    expect(saved("program").days["2"]!.label).toBe("Hinge");
    await user.click(screen.getByRole("switch", { name: "Wed AMRAP progression" }));
    expect(saved("program").days["3"]!.progression).toBe(false);
    await user.click(screen.getByRole("switch", { name: "Sat lifting day" }));
    expect(saved("program").days["6"]).toEqual({ label: "Training", primaryExerciseId: null, progression: true });
    await user.click(screen.getByRole("switch", { name: "Fri lifting day" }));
    expect(Object.keys(saved("program").days).sort()).toEqual(["1", "2", "3", "4", "6"]);

    // Cycle weeks
    await type(user, box("Week 1 name"), "Volume");
    expect(saved("program").weeks[0]).toEqual({ ...p0.weeks[0]!, label: "Volume" });
    await type(user, box("Week 2 reps per set"), "5 5 5");
    expect(saved("program").weeks[1]!.reps).toEqual([5, 5, 5]);
    await user.click(screen.getByRole("switch", { name: "Week 3 deload" }));
    expect(saved("program").weeks[2]).toEqual({ ...p0.weeks[2]!, deload: true, basisReps: 12 });
    await type(user, box("Week 3 load based on rep max"), "10");
    expect(saved("program").weeks[2]!.basisReps).toBe(10);
    await user.click(screen.getByRole("button", { name: "Week" }));
    expect(saved("program").weeks).toHaveLength(6);
    expect(lastSaved().program.weeks[5]).toEqual({ label: "Week 6", deload: false, reps: [5, 5, 5, 5], basisReps: null });

    // Rep-max table
    await type(user, box("5 RM percent of max"), "86.5");
    expect(saved("program").repMaxPct["5"]).toBeCloseTo(0.865);
    expect(Object.keys(lastSaved().program.repMaxPct)).toEqual(Object.keys(p0.repMaxPct));
  });

  describe("an edit applies to the settings as they are, not as they were last rendered", () => {
    // Another change reaches the data layer a moment before the screen has rendered it.
    const arrived = () => {
      const next = { ...store.data.settings, targets: { ...store.data.settings.targets, steps: 12_345 } };
      store.arrive({
        ...next,
        program: { ...next.program, name: "Renamed elsewhere" },
        training: { restSecondsMain: 200, restSecondsAccessory: 60, accessoryIncrementLb: 2.5 },
      });
    };

    it("a rule of the program", async () => {
      const user = userEvent.setup();
      show();
      const field = screen.getByRole("textbox", { name: "Working weight" });
      await user.clear(field);
      await user.type(field, "85");
      arrived();
      await user.tab();
      expect(lastSaved().program.intensity).toBe(0.85);
      expect(lastSaved().program.name).toBe("Renamed elsewhere");
      expect(lastSaved().targets.steps).toBe(12_345);
    });

    it("a training preference (the rest timers keep what the other change set)", async () => {
      const user = userEvent.setup();
      show();
      const field = screen.getByRole("textbox", { name: "Accessory increment" });
      await user.clear(field);
      await user.type(field, "10");
      arrived();
      await user.tab();
      expect(lastSaved().training).toEqual({ restSecondsMain: 200, restSecondsAccessory: 60, accessoryIncrementLb: 10 });
      expect(lastSaved().program.name).toBe("Renamed elsewhere");
      expect(lastSaved().targets.steps).toBe(12_345);
    });
  });

  describe("Cycle weeks", () => {
    it("removes a week with an Undo that puts it back where it was, among the weeks as they are by then", async () => {
      const user = userEvent.setup();
      show();
      const weeks = base().program.weeks;
      await user.click(screen.getByRole("button", { name: "Remove week 2" }));
      expect(lastSaved().program.weeks.map((w) => w.label)).toEqual(["Week 1", "Week 3", "Week 4", "Deload"]);
      expect(lastToast().message).toBe("Week 2 removed");
      // Other things change before Undo — a rule, and the weeks themselves: they stay.
      await type(user, screen.getByRole("textbox", { name: "Working weight" }), "85");
      await type(user, screen.getByRole("textbox", { name: "Week 1 name" }), "Volume");
      await type(user, screen.getByRole("textbox", { name: "Week 2 reps per set" }), "4 4 4");
      undo();
      expect(lastSaved().program.weeks).toEqual([
        { ...weeks[0]!, label: "Volume" },
        weeks[1],
        { ...weeks[2]!, reps: [4, 4, 4] },
        weeks[3],
        weeks[4],
      ]);
      expect(lastSaved().program.intensity).toBe(0.85);
    });

    it("the removed week goes back at the end when the weeks have become fewer than its place", async () => {
      const user = userEvent.setup();
      show();
      const weeks = base().program.weeks;
      await user.click(screen.getByRole("button", { name: "Remove week 4" }));
      const removed = lastToast();
      // Two more go (their own toasts aside): three weeks are left, the removed one was the fourth.
      await user.click(screen.getByRole("button", { name: "Remove week 1" }));
      await user.click(screen.getByRole("button", { name: "Remove week 1" }));
      expect(store.data.settings.program.weeks.map((w) => w.label)).toEqual(["Week 3", "Deload"]);
      undo(removed);
      expect(lastSaved().program.weeks).toEqual([weeks[2], weeks[4], weeks[3]]);
    });

    it("Undo of a removal after leaving for Settings keeps what changed there", async () => {
      const user = userEvent.setup();
      show();
      await user.click(screen.getByRole("button", { name: "Remove week 2" }));
      await changeStepsOnSettings(user);
      undo();
      expect(store.data.settings.targets.steps).toBe(12000);
      expect(store.data.settings.program.weeks).toEqual(base().program.weeks);
    });

    it("returns focus to the restored week's remove button after Undo", async () => {
      const user = userEvent.setup();
      show();
      await user.click(screen.getByRole("button", { name: "Remove week 2" }));
      undo();
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove week 2" })));
    });

    it("the last week can't be removed", async () => {
      const user = userEvent.setup();
      reset(withProgram({ weeks: base().program.weeks.slice(0, 2) }));
      show();
      expect(screen.getAllByRole("button", { name: /^Remove week/ })).toHaveLength(2);
      await user.click(screen.getByRole("button", { name: "Remove week 2" }));
      expect(store.data.settings.program.weeks).toHaveLength(1);
      expect(screen.queryByRole("button", { name: /^Remove week/ })).toBeNull();
    });

    it("stops at 16 weeks", async () => {
      const user = userEvent.setup();
      const week = base().program.weeks[0]!;
      reset(withProgram({ weeks: Array.from({ length: 15 }, (_, i) => ({ ...week, label: `Week ${i + 1}` })) }));
      show();
      const add = screen.getByRole<HTMLButtonElement>("button", { name: "Week" });
      expect(add.disabled).toBe(false);
      await user.click(add);
      expect(store.data.settings.program.weeks).toHaveLength(16);
      expect(add.disabled).toBe(true);
      await user.click(add);
      expect(store.data.settings.program.weeks).toHaveLength(16);
    });
  });

  describe("Rep-max table", () => {
    it.each(["9.9", "100.1", "0", "250"])("refuses %s%% (10 to 100), with a message, and saves nothing", async (text) => {
      const user = userEvent.setup();
      show();
      await type(user, screen.getByRole("textbox", { name: "5 RM percent of max" }), text);
      expect(store.saved).toHaveLength(0);
      expect(lastToast()).toMatchObject({ message: "5 RM: enter a percent between 10 and 100.", tone: "warn" });
    });

    it.each([
      ["10", 0.1],
      ["100", 1],
    ])("accepts the limits themselves (%s%%)", async (text, value) => {
      const user = userEvent.setup();
      show();
      await type(user, screen.getByRole("textbox", { name: "5 RM percent of max" }), text);
      expect(lastSaved().program.repMaxPct["5"]).toBeCloseTo(value);
      expect(store.toasts).toHaveLength(0);
    });

    it("clearing a row removes it from the table (its percent is interpolated from then on)", async () => {
      const user = userEvent.setup();
      show();
      const before = base().program.repMaxPct;
      const field = screen.getByRole("textbox", { name: "5 RM percent of max" });
      await user.clear(field);
      await user.tab();
      const { "5": _five, ...rest } = before;
      expect(lastSaved().program.repMaxPct).toEqual(rest);
      expect(screen.queryByRole("textbox", { name: "5 RM percent of max" })).toBeNull();
      expect(screen.getByRole("textbox", { name: "4 RM percent of max" })).toBeTruthy();
    });
  });

  describe("Exercise library", () => {
    it("adds a tracked lift: a primary lift measured in reps that tracks a max, named as typed (trimmed)", async () => {
      const user = userEvent.setup();
      show();
      const name = screen.getByRole<HTMLInputElement>("textbox", { name: "New lift name" });
      await user.type(name, "  Push press ");
      await user.click(screen.getByRole("button", { name: "Tracked lift" }));
      expect(store.created).toEqual([{ name: "Push press", category: "primary", measure: "reps", tracksMax: true }]);
      await waitFor(() => expect(name.value).toBe(""));
    });

    it("can't add a lift without a name", async () => {
      const user = userEvent.setup();
      show();
      const add = screen.getByRole<HTMLButtonElement>("button", { name: "Tracked lift" });
      expect(add.disabled).toBe(true);
      await user.type(screen.getByRole("textbox", { name: "New lift name" }), "   ");
      expect(add.disabled).toBe(true);
      await user.click(add);
      expect(store.created).toEqual([]);
      await user.type(screen.getByRole("textbox", { name: "New lift name" }), "Row");
      expect(add.disabled).toBe(false);
    });
  });

  describe("what delaying / skipping ahead would do, before it is tapped", () => {
    const weeks = base().program.weeks;
    const easy = weeks.map((w, i) => (i === 4 ? { ...w, label: "Easy" } : w));
    const { "1": _monday, ...noMonday } = base().program.days;
    const DELAY = 1;
    const SKIP = -1;
    it.each<[string, Partial<Program>, 1 | -1, string]>([
      // Week 1 (the default): delayed, the program hasn't started this week.
      ["week 1, delay", {}, DELAY, "Starts Mon Nov 9 instead of Nov 2: this week is before the program; next Monday is Week 1 · Push."],
      ["week 1, skip", {}, SKIP, "This week becomes Week 2; next Monday is Week 3 · Push."],
      // Mid-cycle: this week and the next, both named.
      ["week 3, delay", { cycleStartDate: "2026-10-19" }, DELAY, "This week repeats Week 2; next Monday is Week 3 · Push."],
      ["week 2, skip", { cycleStartDate: "2026-10-26" }, SKIP, "This week becomes Week 3; next Monday is Week 4 · Push."],
      // Around the deload week.
      ["week 4, skip", { cycleStartDate: "2026-10-12" }, SKIP, "This week becomes Deload; next Monday is Week 1 (cycle 2) · Push."],
      ["week 4, delay", { cycleStartDate: "2026-10-12" }, DELAY, "This week repeats Week 3; next Monday is Week 4 · Push."],
      ["deload week, delay", { cycleStartDate: "2026-10-05" }, DELAY, "This week repeats Week 4; next Monday is Deload · Push."],
      ["deload week, skip", { cycleStartDate: "2026-10-05" }, SKIP, "This week becomes Week 1 (cycle 2); next Monday is Week 2 · Push."],
      // Across a cycle, backwards.
      [
        "cycle 2 week 1, delay",
        { cycleStartDate: "2026-09-28" },
        DELAY,
        "This week repeats Deload (cycle 1); next Monday is Week 1 (cycle 2) · Push.",
      ],
      ["cycle 2 week 1, skip", { cycleStartDate: "2026-09-28" }, SKIP, "This week becomes Week 2; next Monday is Week 3 · Push."],
      // A deload week whose name doesn't say so.
      [
        "into a deload called Easy",
        { cycleStartDate: "2026-10-12", weeks: easy },
        SKIP,
        "This week becomes Easy (deload); next Monday is Week 1 (cycle 2) · Push.",
      ],
      [
        "back into it",
        { cycleStartDate: "2026-09-28", weeks: easy },
        DELAY,
        "This week repeats Easy (deload, cycle 1); next Monday is Week 1 (cycle 2) · Push.",
      ],
      // Before the first cycle.
      ["starts next Monday, delay", { cycleStartDate: "2026-11-09" }, DELAY, "Starts Mon Nov 16 instead of Nov 9."],
      [
        "starts next Monday, skip (past the start)",
        { cycleStartDate: "2026-11-09" },
        SKIP,
        "Starts Mon Nov 2 instead of Nov 9: this week becomes Week 1; next Monday is Week 2 · Push.",
      ],
      [
        "starts in two weeks, skip",
        { cycleStartDate: "2026-11-16" },
        SKIP,
        "Starts Mon Nov 9 instead of Nov 16: this week is before the program; next Monday is Week 1 · Push.",
      ],
      ["starts in two weeks, delay", { cycleStartDate: "2026-11-16" }, DELAY, "Starts Mon Nov 23 instead of Nov 16."],
      // The week's first session isn't on a Monday, or there is none.
      [
        "no Monday session",
        { cycleStartDate: "2026-10-19", days: noMonday },
        DELAY,
        "This week repeats Week 2; next week is Week 3, from Tuesday · Pull.",
      ],
      [
        "no Monday session, from week 1",
        { days: noMonday },
        DELAY,
        "Starts Mon Nov 9 instead of Nov 2: this week is before the program; next week is Week 1, from Tuesday · Pull.",
      ],
      ["no lifting days", { cycleStartDate: "2026-10-19", days: {} }, SKIP, "This week becomes Week 4; next week is Deload."],
      // A one-week program: every week is the same one.
      [
        "one week, cycle 3, delay",
        { cycleStartDate: "2026-10-19", weeks: weeks.slice(0, 1) },
        DELAY,
        "Every week is Week 1, so only the cycle count changes: this week is cycle 2 instead of 3.",
      ],
      [
        "one week, cycle 3, skip",
        { cycleStartDate: "2026-10-19", weeks: weeks.slice(0, 1) },
        SKIP,
        "Every week is Week 1, so only the cycle count changes: this week is cycle 4 instead of 3.",
      ],
      [
        "one week, its first, delay",
        { weeks: weeks.slice(0, 1) },
        DELAY,
        "Starts Mon Nov 9 instead of Nov 2: this week is before the program; next Monday is Week 1 · Push.",
      ],
      // The end of the calendar.
      ["no room left", { cycleStartDate: "2999-12-30" }, DELAY, "The program can't move any further."],
    ])("%s", (_case, program, weeksBy, text) => {
      expect(shiftEffect({ ...base().program, ...program }, weeksBy, TODAY)).toBe(text);
    });

    it("each button is described by its line", () => {
      reset(withProgram({ cycleStartDate: "2026-10-19" }));
      show();
      expect(described(delay())).toBe("This week repeats Week 2; next Monday is Week 3 · Push.");
      expect(described(skip())).toBe("This week becomes Week 4; next Monday is Deload · Push.");
      // The line is on screen, under its button.
      expect(delay().nextElementSibling!.textContent).toBe(described(delay()));
    });

    it("a move that can't be made is switched off", async () => {
      const user = userEvent.setup();
      reset(withProgram({ cycleStartDate: "2999-12-30" }));
      show();
      expect((delay() as HTMLButtonElement).disabled).toBe(true);
      expect((skip() as HTMLButtonElement).disabled).toBe(false);
      await user.click(delay());
      expect(store.saved).toHaveLength(0);
      expect(store.toasts).toHaveLength(0);
    });
  });

  describe("Delay a week / Skip ahead a week", () => {
    it("Delay a week moves the cycle start 7 days later; Undo puts it back", async () => {
      const user = userEvent.setup();
      show();
      const before = store.data.settings;
      await user.click(delay());
      expect(store.saved).toHaveLength(1);
      expect(lastSaved()).toEqual({ ...before, program: { ...before.program, cycleStartDate: "2026-11-09" } });
      expect(dateField().value).toBe("2026-11-09");
      expect(document.querySelector("[data-cycle-now]")!.textContent).toContain("Starts next Monday");
      expect(store.toasts).toHaveLength(1);
      expect(lastToast().message).toBe("Program delayed a week");
      expect(lastToast().action!.label).toBe("Undo");
      expect(lastToast().duration).toBe(UNDO_MS);

      undo();
      expect(store.saved).toHaveLength(2);
      expect(lastSaved()).toEqual(before);
    });

    it("Skip ahead a week moves it 7 days earlier; Undo keeps what changed in between", async () => {
      const user = userEvent.setup();
      show();
      await user.click(skip());
      expect(lastSaved().program.cycleStartDate).toBe("2026-10-26");
      expect(lastToast().message).toBe("Program moved ahead a week");
      expect(document.querySelector("[data-cycle-now]")!.textContent).toContain("Cycle 1 · Week 2 of 5");
      await user.click(screen.getByRole("switch", { name: "AMRAP last set" }));
      undo();
      expect(lastSaved().program.cycleStartDate).toBe("2026-11-02");
      expect(lastSaved().program.amrapLastSet).toBe(false);
    });

    it("a double-tap moves one week, with one toast", async () => {
      const user = userEvent.setup();
      show();
      await user.dblClick(delay());
      expect(start()).toBe("2026-11-09");
      expect(store.saved).toHaveLength(1);
      expect(store.toasts).toHaveLength(1);
      // A tap on the other button in the same instant is part of the same slip.
      await user.click(skip());
      expect(start()).toBe("2026-11-09");
      // Just inside the guard: still nothing. At it: a tap of its own.
      clock += SHIFT_GUARD_MS - 1;
      await user.click(delay());
      expect(start()).toBe("2026-11-09");
      clock += 1;
      await user.click(delay());
      expect(start()).toBe("2026-11-16");
    });

    it("a tap right after Undo is a move of its own, not part of a double-tap", async () => {
      const user = userEvent.setup();
      show();
      await user.click(delay());
      undo();
      expect(start()).toBe("2026-11-02");
      await user.click(delay());
      expect(start()).toBe("2026-11-09");
      expect(lastToast().message).toBe("Program delayed a week");
    });

    it("taps in a row fold into one toast that names the whole move; its Undo goes back to before the first", async () => {
      const user = userEvent.setup();
      show();
      await user.click(delay());
      clock += 1000;
      await user.click(delay());
      expect(start()).toBe("2026-11-16");
      // The first toast was replaced (ids are 1-based here: `show` returns the count).
      expect(store.dismissed).toEqual([1]);
      expect(store.toasts.map((t) => t.message)).toEqual(["Program delayed a week", "Program delayed 2 weeks"]);
      clock += 1000;
      await user.click(delay());
      expect(lastToast().message).toBe("Program delayed 3 weeks");
      undo();
      expect(start()).toBe("2026-11-02");
    });

    it("folds across the two buttons, and a move back to the start leaves nothing to undo", async () => {
      const user = userEvent.setup();
      show();
      await user.click(skip());
      clock += 1000;
      await user.click(skip());
      expect(lastToast().message).toBe("Program moved ahead 2 weeks");
      clock += 1000;
      await user.click(delay());
      expect(lastToast().message).toBe("Program moved ahead a week");
      clock += 1000;
      await user.click(delay());
      // Back where it began: the toast goes, no new one.
      expect(start()).toBe("2026-11-02");
      expect(store.toasts).toHaveLength(3);
      expect(store.dismissed).toEqual([1, 2, 3]);
      // The next move starts afresh.
      clock += 1000;
      await user.click(delay());
      expect(lastToast().message).toBe("Program delayed a week");
      expect(store.dismissed).toEqual([1, 2, 3]);
    });

    it("stops folding when the first Undo is no longer on offer: the next move's Undo goes back one move", async () => {
      const user = userEvent.setup();
      show();
      await user.click(delay());
      // Just inside the window it still folds…
      clock += UNDO_MS - 1;
      await user.click(delay());
      expect(lastToast().message).toBe("Program delayed 2 weeks");
      expect(store.dismissed).toEqual([1]);
      // …a full window after that toast, it doesn't.
      clock += UNDO_MS;
      await user.click(delay());
      expect(start()).toBe("2026-11-23");
      expect(lastToast().message).toBe("Program delayed a week");
      expect(store.dismissed).toEqual([1]);
      undo();
      expect(start()).toBe("2026-11-16");
    });

    it("after Undo, the next move doesn't fold into the undone one", async () => {
      const user = userEvent.setup();
      show();
      await user.click(delay());
      undo();
      clock += 1000;
      await user.click(skip());
      expect(lastToast().message).toBe("Program moved ahead a week");
      expect(store.dismissed).toEqual([]);
      undo();
      expect(start()).toBe("2026-11-02");
    });

    it("Undo only undoes a start that is still where the move put it; otherwise it says so and overwrites nothing", async () => {
      const user = userEvent.setup();
      show();
      await user.click(delay());
      // Another device (or tab) moves the start meanwhile.
      act(() => store.remote(withProgram({ cycleStartDate: "2026-10-19" })));
      const saves = store.saved.length;
      undo(store.toasts[0]);
      expect(store.saved).toHaveLength(saves);
      expect(start()).toBe("2026-10-19");
      expect(lastToast()).toMatchObject({ message: "Can't undo: the cycle start was changed again since.", tone: "warn" });
      expect(lastToast().action).toBeUndefined();
    });

    it("Undo after leaving for Settings and changing the steps target there keeps the new target", async () => {
      const user = userEvent.setup();
      show();
      await user.click(delay());
      expect(start()).toBe("2026-11-09");
      const toast = lastToast();
      await changeStepsOnSettings(user);
      undo(toast);
      expect(store.data.settings.targets.steps).toBe(12000);
      expect(start()).toBe("2026-11-02");
      expect(lastSaved()).toEqual({ ...base(), targets: { ...base().targets, steps: 12000 } });
    });

    it("Undo keeps a change that arrived from another device after the screen was left", async () => {
      const user = userEvent.setup();
      show();
      await user.click(skip());
      await user.click(screen.getByRole("link", { name: "go to settings" }));
      act(() => store.remote({ ...store.data.settings, nutrition: { ...store.data.settings.nutrition, proteinGPerLb: 1.25 } }));
      undo();
      expect(store.data.settings.nutrition.proteinGPerLb).toBe(1.25);
      expect(start()).toBe("2026-11-02");
    });

    it("returns focus to the button after Undo", async () => {
      const user = userEvent.setup();
      show();
      await user.click(skip());
      (document.activeElement as HTMLElement).blur();
      undo();
      await waitFor(() => expect(document.activeElement).toBe(skip()));
    });

    it("a save the schema refuses shows no toast and moves nothing", async () => {
      // A stored value from before a limit existed: any save of the document trips over it.
      reset({ ...base(), training: { restSecondsMain: 5, restSecondsAccessory: 90, accessoryIncrementLb: 5 } });
      const user = userEvent.setup();
      show();
      await user.click(delay());
      expect(store.saved).toHaveLength(0);
      expect(store.toasts).toHaveLength(0);
      expect(screen.getByRole("alert").textContent).toBe("Main lift rest must be at least 10.");
    });
  });

  describe("the cycle start date field", () => {
    it("leaves the same Undo: the start goes back, and focus returns to the field", async () => {
      show();
      fireEvent.change(dateField(), { target: { value: "2026-11-12" } });
      expect(start()).toBe("2026-11-09");
      expect(store.toasts).toHaveLength(1);
      expect(lastToast()).toMatchObject({ message: "Program starts Mon Nov 9", action: { label: "Undo" } });
      undo();
      expect(start()).toBe("2026-11-02");
      await waitFor(() => expect(document.activeElement).toBe(dateField()));
    });

    it("picking a day in the week it already starts in changes nothing", () => {
      show();
      fireEvent.change(dateField(), { target: { value: "2026-11-06" } });
      expect(store.saved).toHaveLength(0);
      expect(store.toasts).toHaveLength(0);
      // Not a date (a half-typed one): ignored.
      fireEvent.change(dateField(), { target: { value: "" } });
      expect(store.saved).toHaveLength(0);
    });

    it("folds with the buttons: one toast, back to the first start", async () => {
      const user = userEvent.setup();
      show();
      fireEvent.change(dateField(), { target: { value: "2026-11-23" } });
      clock += 1000;
      await user.click(delay());
      expect(start()).toBe("2026-11-30");
      expect(store.dismissed).toEqual([1]);
      expect(lastToast().message).toBe("Program delayed 4 weeks");
      clock += 1000;
      fireEvent.change(dateField(), { target: { value: "2026-10-19" } });
      expect(lastToast().message).toBe("Program starts Mon Oct 19");
      undo();
      expect(start()).toBe("2026-11-02");
    });

    it("its Undo is conditional too, and survives leaving the screen", async () => {
      const user = userEvent.setup();
      show();
      fireEvent.change(dateField(), { target: { value: "2026-11-23" } });
      const toast = lastToast();
      await changeStepsOnSettings(user);
      undo(toast);
      expect(store.data.settings.targets.steps).toBe(12000);
      expect(start()).toBe("2026-11-02");

      // Changed again since: nothing is overwritten.
      act(() => store.remote(withProgram({ cycleStartDate: "2026-12-07" })));
      const saves = store.saved.length;
      undo(toast);
      expect(store.saved).toHaveLength(saves);
      expect(start()).toBe("2026-12-07");
    });
  });

  describe("Weekly layout", () => {
    const lifting = (d: string) => screen.getByRole("switch", { name: `${d} lifting day` });

    it("labels both switches of a day: Lift and AMRAP", () => {
      show();
      const layout = document.getElementById("layout")!;
      const captionBefore = (el: HTMLElement) => el.previousElementSibling!;
      for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) {
        expect(layout.contains(lifting(d))).toBe(true);
        expect(captionBefore(lifting(d)).textContent).toBe("Lift");
        // The switch's own name says it for assistive tech; the caption is for the eye.
        expect(captionBefore(lifting(d)).getAttribute("aria-hidden")).toBe("true");
      }
      expect(captionBefore(screen.getByRole("switch", { name: "Mon AMRAP progression" })).textContent).toBe("AMRAP");
    });

    it("switching a day off and on again brings back its name, main lift and AMRAP setting", async () => {
      const user = userEvent.setup();
      const days = { ...base().program.days, "4": { label: "Press day", primaryExerciseId: 5, progression: false } };
      reset(withProgram({ days }));
      show();
      await user.click(lifting("Thu"));
      expect(store.data.settings.program.days["4"]).toBeUndefined();
      expect(screen.queryByRole("textbox", { name: "Thu session name" })).toBeNull();
      await user.click(lifting("Thu"));
      expect(store.data.settings.program.days).toEqual(days);
      expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Thu session name" }).value).toBe("Press day");
      expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Thu main lift" }).value).toBe("5");
      expect(screen.getByRole("switch", { name: "Thu AMRAP progression" }).getAttribute("aria-checked")).toBe("false");
    });

    it("remembers each day by itself, as it was when it was switched off", async () => {
      const user = userEvent.setup();
      show();
      const days = base().program.days;
      await type(user, screen.getByRole("textbox", { name: "Mon session name" }), "Chest");
      await user.click(lifting("Mon"));
      await user.click(lifting("Tue"));
      await user.click(lifting("Mon"));
      expect(store.data.settings.program.days["1"]).toEqual({ ...days["1"]!, label: "Chest" });
      expect(store.data.settings.program.days["2"]).toBeUndefined();
      await user.click(lifting("Tue"));
      expect(store.data.settings.program.days).toEqual({ ...days, "1": { ...days["1"]!, label: "Chest" } });
      // A day that never was a lifting day starts from the defaults.
      await user.click(lifting("Sat"));
      expect(store.data.settings.program.days["6"]).toEqual({ label: "Training", primaryExerciseId: null, progression: true });
    });

    it("switching a day off leaves an Undo; switching one on doesn't", async () => {
      const user = userEvent.setup();
      show();
      const days = base().program.days;
      await user.click(lifting("Sat"));
      expect(store.toasts).toHaveLength(0);
      expect(store.dismissed).toEqual([]);
      await user.click(lifting("Mon"));
      expect(store.toasts).toHaveLength(1);
      expect(lastToast()).toMatchObject({ message: "Monday lifting switched off", action: { label: "Undo" } });
      // Something else in the layout changes before Undo: it stays.
      await type(user, screen.getByRole("textbox", { name: "Tue session name" }), "Hinge");
      undo();
      expect(store.data.settings.program.days).toEqual({
        ...days,
        "2": { ...days["2"]!, label: "Hinge" },
        "6": { label: "Training", primaryExerciseId: null, progression: true },
      });
      await waitFor(() => expect(document.activeElement).toBe(lifting("Mon")));
    });

    it("Undo after the screen was left (the remembered day is gone with it) still restores the day, and nothing else", async () => {
      const user = userEvent.setup();
      show();
      await user.click(lifting("Fri"));
      await changeStepsOnSettings(user);
      undo();
      expect(store.data.settings.targets.steps).toBe(12000);
      expect(store.data.settings.program.days).toEqual(base().program.days);
    });

    it("switching the day back on by hand withdraws the toast: there is nothing left to undo", async () => {
      const user = userEvent.setup();
      show();
      await user.click(lifting("Mon"));
      await user.click(lifting("Tue"));
      expect(store.toasts.map((t) => t.message)).toEqual(["Monday lifting switched off", "Tuesday lifting switched off"]);
      clock += 1000;
      await user.click(lifting("Mon"));
      // Monday's toast (the first) goes; Tuesday's stays; no new one.
      expect(store.dismissed).toEqual([1]);
      expect(store.toasts).toHaveLength(2);
      // Off again: a toast of its own.
      await user.click(lifting("Mon"));
      expect(store.toasts).toHaveLength(3);
      expect(store.dismissed).toEqual([1]);
    });

    it("Undo leaves a day alone that is a lifting day again", async () => {
      const user = userEvent.setup();
      show();
      await user.click(lifting("Mon"));
      const toast = lastToast();
      // Back on from somewhere else (another device), then renamed here.
      act(() => store.remote(base()));
      await type(user, screen.getByRole("textbox", { name: "Mon session name" }), "Chest");
      const saves = store.saved.length;
      undo(toast);
      expect(store.saved).toHaveLength(saves);
      expect(store.data.settings.program.days["1"]!.label).toBe("Chest");
      expect(lastToast()).toMatchObject({ message: "Can't undo: Monday is a lifting day again.", tone: "warn" });
    });
  });

  describe("a save that doesn't go through", () => {
    it("is named by its field when the schema refuses it (the labels still resolve for fields edited here)", () => {
      const s = base();
      const issue = (bad: unknown) => {
        const r = settingsSchema.safeParse(bad);
        return readableIssue(r.error!.issues[0] as unknown as Parameters<typeof readableIssue>[0]);
      };
      expect(issue({ ...s, program: { ...s.program, cycleStartDate: "soon" } })).toMatch(/^Cycle start date: /);
      expect(issue({ ...s, program: { ...s.program, intensity: 2 } })).toBe("Working weight can be at most 1.2.");
      expect(issue({ ...s, program: { ...s.program, days: { "9": s.program.days["1"] } } })).toMatch(/^Weekly layout: /);
      expect(issue({ ...s, program: { ...s.program, weeks: [] } })).toMatch(/^Cycle weeks/);
      expect(issue({ ...s, training: { restSecondsMain: 180, restSecondsAccessory: 90, accessoryIncrementLb: 99 } })).toBe(
        "Accessory increment can be at most 50.",
      );
    });

    it("the alert goes once a save goes through", async () => {
      // A stored value from before a limit existed: any save of the document trips over it…
      reset({ ...base(), training: { restSecondsMain: 5, restSecondsAccessory: 90, accessoryIncrementLb: 5 } });
      const user = userEvent.setup();
      show();
      await user.click(screen.getByRole("switch", { name: "AMRAP last set" }));
      expect(store.saved).toHaveLength(0);
      expect(screen.getByRole("alert").textContent).toBe("Main lift rest must be at least 10.");
      // …until that value itself is put right.
      await type(user, screen.getByRole("textbox", { name: "Main lift rest" }), "3:00");
      expect(store.saved).toHaveLength(1);
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it.each([
      [new Error("This device's storage is full."), "This device's storage is full."],
      ["nope", "Couldn't save."],
    ])("says so when the data layer rejects it", async (reason, message) => {
      const user = userEvent.setup();
      show();
      store.failNext = reason;
      await user.click(screen.getByRole("switch", { name: "AMRAP last set" }));
      expect((await screen.findByRole("alert")).textContent).toBe(message);
      // The next good save clears it.
      await user.click(screen.getByRole("switch", { name: "AMRAP last set" }));
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    });
  });
});

describe("Settings", () => {
  it("is titled Settings under “Preferences” (the rules live on Program), and keeps the preferences", () => {
    show("/settings");
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.textContent).toBe("Settings");
    expect(h1.previousElementSibling!.textContent).toBe("Preferences");
    expect(screen.queryByText("The rules")).toBeNull();
    expect(screen.getByRole("link", { name: "Back to Today" }).getAttribute("href")).toBe("/");
    expect(sectionHeadings()).toEqual(["Daily targets", "Schedule", "Nutrition", "Display", "Sync", "Data"]);
    for (const name of ["Steps", "Zone 2", "Protein", "Fat", "Maintenance estimate", "Calories per lb", "Max loss", "Max gain"])
      expect(screen.getByRole("textbox", { name })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Metcon days" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Zone 2 days" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "High contrast" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Sync now/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Export JSON/ })).toBeTruthy();
    const jumps = within(screen.getByRole("navigation", { name: "Settings sections" })).getAllByRole("link");
    expect(jumps.map((a) => a.getAttribute("href"))).toEqual(["#targets", "#schedule", "#nutrition", "#display", "#sync", "#data"]);
    for (const a of jumps) expect(document.getElementById(a.getAttribute("href")!.slice(1))?.tagName).toBe("SECTION");
  });

  it("no longer shows the training program, and links to Program instead", async () => {
    const user = userEvent.setup();
    show("/settings");
    for (const name of ["Program name", "Working weight", "Main lift rest", "Accessory rest", "Accessory increment", "Week 1 name"])
      expect(screen.queryByRole("textbox", { name })).toBeNull();
    expect(screen.queryByLabelText("Cycle start date")).toBeNull();
    expect(screen.queryByRole("switch", { name: "Mon lifting day" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit Bench press" })).toBeNull();
    expect(document.getElementById("program")).toBeNull();
    expect(document.getElementById("training")).toBeNull();

    const link = screen.getByRole("link", { name: /Training program/ });
    expect(link.getAttribute("href")).toBe("/program");
    await user.click(link);
    expect(where()).toBe("/program");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Program");
  });

  it("still saves its own fields through the same path", async () => {
    const user = userEvent.setup();
    show("/settings");
    const before = store.data.settings;
    await type(user, screen.getByRole("textbox", { name: "Steps" }), "12000");
    expect(lastSaved()).toEqual({ ...before, targets: { ...before.targets, steps: 12000 } });
    await user.click(within(screen.getByRole("group", { name: "Metcon days" })).getByRole("button", { name: "Sun" }));
    expect(lastSaved().schedule.metcon[0]).toBe(!before.schedule.metcon[0]);
    expect(lastSaved().program).toEqual(before.program);
  });
});

describe("old Settings anchors", () => {
  it("map the moved sections to Program and leave the rest on Settings", () => {
    expect(programPathForSettingsHash("#program")).toBe("/program");
    expect(programPathForSettingsHash("#training")).toBe("/program#rules");
    for (const id of ["now", "layout", "weeks", "rules", "rep-max", "library"])
      expect(programPathForSettingsHash(`#${id}`)).toBe(`/program#${id}`);
    for (const hash of ["", "#", "#targets", "#schedule", "#nutrition", "#display", "#sync", "#data", "#nope"])
      expect(programPathForSettingsHash(hash)).toBeNull();
  });

  it("/settings#program lands on Program", () => {
    show("/settings#program");
    expect(where()).toBe("/program");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Program");
    expect(screen.getByRole("textbox", { name: "Program name" })).toBeTruthy();
  });

  it("/settings#training lands on Program's rules, with focus on the section's heading", () => {
    show("/settings#training");
    expect(where()).toBe("/program#rules");
    expect(document.activeElement?.textContent).toBe("Rules");
  });

  it("/settings#sync stays on Settings", () => {
    show("/settings#sync");
    expect(where()).toBe("/settings#sync");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Settings");
    expect(document.activeElement?.textContent).toBe("Sync");
  });

  it("the redirect replaces the old address: Back leaves it behind instead of bouncing to Program again", async () => {
    const user = userEvent.setup();
    show("/settings#training", ["/train"]);
    expect(where()).toBe("/program#rules");
    await user.click(screen.getByRole("button", { name: "browser back" }));
    expect(where()).toBe("/train");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Train");
  });
});
