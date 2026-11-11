/**
 * Program and the slimmed Settings: the training plan's controls moved from Settings to Program
 * and save exactly what they saved before (one settings document, one save path); the cycle moves
 * a week later / earlier with an Undo; Settings keeps the preferences and a link to Program; old
 * Settings anchors of moved sections land on Program.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../../shared/defaults";
import { settingsSchema, type Exercise, type Settings } from "../../shared/schemas";
import { programPathForSettingsHash } from "../components/program/sections";
import { readableIssue } from "../components/settings/useSettingsEditor";
import { ProgramScreen } from "./Program";
import { SettingsScreen } from "./Settings";

// Wednesday of week 1 (the cycle starts Monday Nov 2).
const TODAY = "2026-11-04";

/** A tiny reactive stand-in for the data layer: a save replaces the settings and re-renders. */
const store = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    settings: null as unknown as import("../../shared/schemas").Settings,
    exercises: [] as import("../../shared/schemas").Exercise[],
    data: null as unknown as { settings: import("../../shared/schemas").Settings; exercises: import("../../shared/schemas").Exercise[] },
    listeners,
    saved: [] as import("../../shared/schemas").Settings[],
    toasts: [] as Array<{ message: string; tone?: string; action?: { label: string; onAction: () => void } }>,
    reset(settings: import("../../shared/schemas").Settings, exercises: import("../../shared/schemas").Exercise[]) {
      state.saved = [];
      state.toasts = [];
      state.data = { settings, exercises };
    },
    save(next: import("../../shared/schemas").Settings) {
      state.saved.push(next);
      state.data = { ...state.data, settings: next };
      for (const l of listeners) l();
      return Promise.resolve(next);
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
    useData: () => ({ data: useSyncExternalStore(subscribe, () => store.data), today: TODAY }),
    useSaveSettings: () => store.save,
    useCreateExercise: () => vi.fn(),
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
vi.mock("../components/Toast", () => ({
  useToast: () => ({ show: (t: (typeof store.toasts)[number]) => store.toasts.push(t), dismiss: vi.fn() }),
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

beforeEach(() => store.reset(base(), EXERCISES));

function Where() {
  const { pathname, hash } = useLocation();
  return <output data-testid="where">{pathname + hash}</output>;
}
const show = (at = "/program") =>
  render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route path="/program" element={<ProgramScreen />} />
        <Route path="/settings" element={<SettingsScreen />} />
        <Route path="/train" element={<h1>Train</h1>} />
      </Routes>
      <Where />
    </MemoryRouter>,
  );
const where = () => screen.getByTestId("where").textContent;
const lastSaved = () => store.saved.at(-1)!;
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

describe("Program", () => {
  it("is titled Program under the program's name, with the plan's sections in order and a way back to Train", () => {
    show();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Program");
    expect(document.querySelector("[data-program-name]")!.textContent).toBe(base().program.name);
    expect(sectionHeadings()).toEqual(["Now", "Weekly layout", "Cycle weeks", "Rules", "Rep-max table", "Exercise library"]);
    expect(screen.getByRole("link", { name: "Back to Train" }).getAttribute("href")).toBe("/train");
    const jumps = within(screen.getByRole("navigation", { name: "Program sections" })).getAllByRole("link");
    expect(jumps.map((a) => a.getAttribute("href"))).toEqual(["#now", "#layout", "#weeks", "#rules", "#rep-max", "#library"]);
    for (const a of jumps) expect(document.getElementById(a.getAttribute("href")!.slice(1))?.tagName).toBe("SECTION");
  });

  it("goes back to the Train day it was opened from", () => {
    render(
      <MemoryRouter initialEntries={[{ pathname: "/program", state: { from: "/train/2026-10-19" } }]}>
        <ProgramScreen />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "Back to Train" }).getAttribute("href")).toBe("/train/2026-10-19");
  });

  it("says where the cycle is now", () => {
    show();
    const now = document.querySelector("[data-cycle-now]")!;
    expect(now.textContent).toContain("Cycle 1 · Week 1 of 5");
    expect(now.textContent).toContain("Nov 2 – Nov 8 · cycle ends Dec 6");
  });

  it("notes a deload week, and a plan that hasn't started", () => {
    // Four weeks on: week 5, the deload.
    store.reset({ ...base(), program: { ...base().program, cycleStartDate: "2026-10-05" } }, EXERCISES);
    const first = show();
    expect(document.querySelector("[data-cycle-now]")!.textContent).toContain("Cycle 1 · Week 5 of 5");
    expect(document.querySelector("[data-cycle-now]")!.textContent).toContain("Deload · Nov 2 – Nov 8");
    first.unmount();

    const weeks = base().program.weeks.map((w, i) => (i === 4 ? { ...w, label: "Easy" } : w));
    store.reset({ ...base(), program: { ...base().program, cycleStartDate: "2026-10-05", weeks } }, EXERCISES);
    const second = show();
    expect(document.querySelector("[data-cycle-now]")!.textContent).toContain("Easy · Deload week · Nov 2 – Nov 8");
    second.unmount();

    store.reset({ ...base(), program: { ...base().program, cycleStartDate: "2026-11-09" } }, EXERCISES);
    show();
    expect(document.querySelector("[data-cycle-now]")!.textContent).toContain("Starts next Monday");
    expect(document.querySelector("[data-cycle-now]")!.textContent).toContain("Cycle 1 · Week 1 of 5 begins Mon Nov 9, in 5 days");
  });

  it("has every control that moved from Settings", () => {
    show();
    const box = (name: string) => screen.getByRole("textbox", { name });
    const toggle = (name: string) => screen.getByRole("switch", { name });
    // Now
    expect((box("Program name") as HTMLInputElement).value).toBe(base().program.name);
    expect((screen.getByLabelText("Cycle start date") as HTMLInputElement).value).toBe("2026-11-02");
    expect(screen.getByRole("button", { name: "Start a week later" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start a week earlier" })).toBeTruthy();
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
    fireEvent.change(screen.getByLabelText("Cycle start date"), { target: { value: "2026-11-12" } });
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

  it("removes a week with an Undo that puts it back where it was", async () => {
    const user = userEvent.setup();
    show();
    const weeks = base().program.weeks;
    await user.click(screen.getByRole("button", { name: "Remove week 2" }));
    expect(lastSaved().program.weeks.map((w) => w.label)).toEqual(["Week 1", "Week 3", "Week 4", "Deload"]);
    expect(store.toasts.at(-1)!.message).toBe("Week 2 removed");
    // Something else changes before Undo: it stays.
    await type(user, screen.getByRole("textbox", { name: "Working weight" }), "85");
    store.toasts.at(-1)!.action!.onAction();
    expect(lastSaved().program.weeks).toEqual(weeks);
    expect(lastSaved().program.intensity).toBe(0.85);
  });

  it("explains what a week later / earlier would do before it is tapped", () => {
    show();
    const later = screen.getByRole("button", { name: "Start a week later" });
    const earlier = screen.getByRole("button", { name: "Start a week earlier" });
    const described = (el: HTMLElement) => document.getElementById(el.getAttribute("aria-describedby")!)!.textContent;
    expect(described(later)).toBe("Pushes the whole plan back a week: next Monday becomes Week 1 · Push.");
    expect(described(earlier)).toBe("Pulls the whole plan forward a week: this week becomes Week 2.");
  });

  it("the explanation follows the plan: mid-cycle, across a cycle, and with no Monday session", () => {
    // Cycle 2, week 1 (the cycle started five weeks before this Monday).
    store.reset({ ...base(), program: { ...base().program, cycleStartDate: "2026-09-28" } }, EXERCISES);
    const a = show();
    expect(screen.getByText("Pushes the whole plan back a week: this week becomes Deload (cycle 1).")).toBeTruthy();
    expect(screen.getByText("Pulls the whole plan forward a week: this week becomes Week 2.")).toBeTruthy();
    a.unmount();

    const { "1": _monday, ...days } = base().program.days;
    store.reset({ ...base(), program: { ...base().program, days } }, EXERCISES);
    show();
    expect(screen.getByText("Pushes the whole plan back a week: next Tuesday becomes Week 1 · Pull.")).toBeTruthy();
  });

  it("Start a week later moves the cycle start by 7 days; Undo puts it back", async () => {
    const user = userEvent.setup();
    show();
    const before = store.data.settings;
    await user.click(screen.getByRole("button", { name: "Start a week later" }));
    expect(store.saved).toHaveLength(1);
    expect(lastSaved()).toEqual({ ...before, program: { ...before.program, cycleStartDate: "2026-11-09" } });
    expect((screen.getByLabelText("Cycle start date") as HTMLInputElement).value).toBe("2026-11-09");
    expect(document.querySelector("[data-cycle-now]")!.textContent).toContain("Starts next Monday");
    const toast = store.toasts.at(-1)!;
    expect(toast.message).toBe("Plan moved a week later");
    expect(toast.action!.label).toBe("Undo");

    toast.action!.onAction();
    expect(store.saved).toHaveLength(2);
    expect(lastSaved()).toEqual(before);
  });

  it("Start a week earlier moves it 7 days back; Undo keeps what changed in between", async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole("button", { name: "Start a week earlier" }));
    expect(lastSaved().program.cycleStartDate).toBe("2026-10-26");
    expect(store.toasts.at(-1)!.message).toBe("Plan moved a week earlier");
    expect(document.querySelector("[data-cycle-now]")!.textContent).toContain("Cycle 1 · Week 2 of 5");
    await user.click(screen.getByRole("switch", { name: "AMRAP last set" }));
    store.toasts.at(-1)!.action!.onAction();
    expect(lastSaved().program.cycleStartDate).toBe("2026-11-02");
    expect(lastSaved().program.amrapLastSet).toBe(false);
  });

  it("a save the schema refuses is named by its field (the labels still resolve for fields edited here)", async () => {
    // A stored value from before a limit existed: any save of the document trips over it.
    const s = base();
    store.reset({ ...s, training: { restSecondsMain: 5, restSecondsAccessory: 90, accessoryIncrementLb: 5 } }, EXERCISES);
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole("button", { name: "Start a week later" }));
    expect(store.saved).toHaveLength(0);
    expect(store.toasts).toHaveLength(0);
    expect(screen.getByRole("alert").textContent).toBe("Main lift rest must be at least 10.");

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
});

describe("Settings", () => {
  it("is titled Settings under “The rules”, and keeps the preferences", () => {
    show("/settings");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Settings");
    expect(screen.getByText("The rules")).toBeTruthy();
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

  it("no longer shows the training plan, and links to Program instead", async () => {
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
    for (const id of ["now", "layout", "weeks", "rules", "rep-max", "library"]) expect(programPathForSettingsHash(`#${id}`)).toBe(`/program#${id}`);
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
});
