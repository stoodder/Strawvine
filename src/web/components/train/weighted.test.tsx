/**
 * Weighted exercises (any measure + a load): creating one, showing or hiding the load on set
 * chips and in the set editor, and the weighted chip in Settings' exercise library.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Exercise, SetEntry } from "../../../shared/schemas";
import { LiftsEditor } from "../../screens/Settings";
import { AddExerciseSheet } from "./AddExerciseSheet";
import { PlannedChip, SetChip } from "./SetControls";
import { SetEditSheet } from "./SetSheets";
import { describeSet } from "./sessionEdit";

// Settings' library reads exercises from the store and shows toasts: stand-ins for both.
const store = vi.hoisted(() => ({ exercises: [] as Exercise[], update: vi.fn(), toast: vi.fn() }));
vi.mock("../../lib/store", () => ({
  useData: () => ({ data: { exercises: store.exercises } }),
  useUpdateExercise: () => store.update,
  useCreateExercise: () => vi.fn(),
}));
vi.mock("../Toast", () => ({ useToast: () => ({ show: store.toast, dismiss: vi.fn() }) }));

const root = () => document.getElementById("root")!;
const set = (o: Partial<SetEntry> = {}): SetEntry => ({
  id: "s1",
  targetReps: 30,
  targetWeight: null,
  reps: null,
  weight: null,
  done: false,
  amrap: false,
  appliedProgressionLb: null,
  ...o,
});
const exercise = (o: Partial<Exercise> & Pick<Exercise, "id" | "name">): Exercise => ({
  category: "accessory",
  tracksMax: false,
  measure: "reps",
  weighted: true,
  archived: false,
  ...o,
});

describe("creating an exercise", () => {
  const library = [
    exercise({ id: 1, name: "Pull-up", weighted: false }),
    exercise({ id: 2, name: "Farmer's carry", category: "carry", measure: "meters" }),
    exercise({ id: 3, name: "Plank", category: "core", measure: "seconds", weighted: false }),
    exercise({ id: 4, name: "Cable row" }),
    exercise({ id: 5, name: "Bench press", category: "primary", tracksMax: true }),
  ];
  type OnCreate = (input: { name: string; category: string; measure: string; weighted: boolean }) => Promise<void>;
  const props = (onCreate: OnCreate) => ({
    onClose: () => {},
    title: "Add exercise",
    exercises: library,
    recentIds: [],
    onPick: () => {},
    onCreate,
  });
  const sheet = () => {
    const onCreate = vi.fn<OnCreate>(async () => {});
    render(<AddExerciseSheet open {...props(onCreate)} />, { container: root() });
    return onCreate;
  };
  const search = () => screen.getByRole("textbox", { name: "Search or create exercise" });
  const loadGroup = () => screen.getByRole("group", { name: "Load" });
  const pressed = (name: "Weighted" | "Unweighted") =>
    within(loadGroup()).getByRole("button", { name }).getAttribute("aria-pressed");

  it("offers the load as a choice like the category and measure: weighted for reps", async () => {
    const user = userEvent.setup();
    sheet();
    await user.type(search(), "Hammer curl");
    expect(screen.getByRole("group", { name: "Category" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Measured in" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Load", description: "Log a load (lb) with each set" })).toBeTruthy();
    expect(pressed("Weighted")).toBe("true");
    expect(pressed("Unweighted")).toBe("false");
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("follows the measure and category until it's picked, then keeps the pick", async () => {
    const user = userEvent.setup();
    const onCreate = sheet();
    await user.type(search(), "Weighted dead hang");
    await user.click(screen.getByRole("button", { name: "Time" }));
    expect(pressed("Weighted")).toBe("false"); // a hold starts unloaded
    await user.click(screen.getByRole("button", { name: "Carry" }));
    expect(pressed("Weighted")).toBe("true"); // a carry is loaded, whatever the measure
    await user.click(screen.getByRole("button", { name: "Core" }));
    await user.click(screen.getByRole("button", { name: "Reps" }));
    expect(pressed("Weighted")).toBe("false"); // core reps (sit-ups) start unloaded
    await user.click(screen.getByRole("button", { name: "Accessory" }));
    expect(pressed("Weighted")).toBe("true");

    // Picked: it stays, whatever the measure or category does next.
    await user.click(screen.getByRole("button", { name: "Time" }));
    await user.click(within(loadGroup()).getByRole("button", { name: "Weighted" }));
    await user.click(screen.getByRole("button", { name: "Core" }));
    await user.click(screen.getByRole("button", { name: "Reps" }));
    await user.click(screen.getByRole("button", { name: "Time" }));
    expect(pressed("Weighted")).toBe("true");
    await user.click(screen.getByRole("button", { name: /Create & add/ }));
    expect(onCreate).toHaveBeenCalledWith({ name: "Weighted dead hang", category: "core", measure: "seconds", weighted: true });
  });

  it("can be made unweighted (a run, a plank)", async () => {
    const user = userEvent.setup();
    const onCreate = sheet();
    await user.type(search(), "Shuttle run");
    await user.click(screen.getByRole("button", { name: "Unweighted" }));
    await user.click(screen.getByRole("button", { name: "Distance" }));
    expect(pressed("Unweighted")).toBe("true");
    expect(screen.getByRole("group", { name: "Load", description: "No load — just the distance" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Create & add/ }));
    expect(onCreate).toHaveBeenCalledWith({ name: "Shuttle run", category: "accessory", measure: "meters", weighted: false });
  });

  it("starts over after a create and after closing (the sheet stays mounted)", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn<OnCreate>(async () => {});
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            reopen
          </button>
          <AddExerciseSheet open={open} {...props(onCreate)} onClose={() => setOpen(false)} />
        </>
      );
    }
    render(<Harness />, { container: root() });
    await user.type(search(), "Band pull-apart");
    await user.click(screen.getByRole("button", { name: "Unweighted" }));
    await user.click(screen.getByRole("button", { name: /Create & add/ }));
    expect(onCreate).toHaveBeenLastCalledWith(expect.objectContaining({ weighted: false }));
    await user.type(search(), "Hammer curl");
    expect(pressed("Weighted")).toBe("true");

    // Picked, then closed: reopening starts from reps, weighted.
    await user.click(screen.getByRole("button", { name: "Time" }));
    await user.click(screen.getByRole("button", { name: "Unweighted" }));
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(await screen.findByRole("button", { name: "reopen" }));
    await user.type(search(), "Hammer curl");
    expect(within(screen.getByRole("group", { name: "Measured in" })).getByRole("button", { name: "Reps" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(pressed("Weighted")).toBe("true");
    await user.click(screen.getByRole("button", { name: /Create & add/ }));
    expect(onCreate).toHaveBeenLastCalledWith({ name: "Hammer curl", category: "accessory", measure: "reps", weighted: true });
  });

  it("offers no choice for a barbell lift: always weighted", async () => {
    const user = userEvent.setup();
    const onCreate = sheet();
    await user.type(search(), "Pause squat");
    await user.click(screen.getByRole("button", { name: "Unweighted" }));
    await user.click(screen.getByRole("button", { name: "Barbell" }));
    expect(screen.queryByRole("group", { name: "Load" })).toBeNull();
    await user.click(screen.getByRole("button", { name: /Create & add/ }));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ category: "primary", weighted: true }));
  });

  it("tags the library: category, the measure unless reps, and weighted (never on a main lift)", () => {
    sheet();
    const tag = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) }).textContent!.slice(name.length);
    expect(tag("Pull-up")).toBe("Accessory");
    expect(tag("Farmer's carry")).toBe("Carry · distance · weighted");
    expect(tag("Plank")).toBe("Core · time");
    expect(tag("Cable row")).toBe("Accessory · weighted");
    expect(tag("Bench press")).toBe("Barbell");
  });
});

describe("set chips", () => {
  // jsdom trims the spaces inside the sr-only spans (" at ", " lb") that browsers keep: compare without them.
  const named = (text: string) => (name: string) => name.replace(/\s/g, "") === text.replace(/\s/g, "");
  const element = (s: SetEntry, weighted: boolean) => (
    <SetChip exerciseName="Hang" index={0} set={s} measure="seconds" weighted={weighted} onTap={() => {}} onHold={() => {}} />
  );
  const chip = (s: SetEntry, weighted: boolean) => render(element(s, weighted), { container: root() });

  it("shows the load of a weighted set, with its time", () => {
    chip(set({ targetWeight: 25 }), true);
    expect(screen.getByRole("button", { name: named("Hang set 1: 30s at 25 lb") }).textContent).toContain("25");
  });

  it("shows a weighted set without a load as an empty “lb”, so there's a load to set", () => {
    chip(set(), true);
    expect(screen.getByRole("button", { name: named("Hang set 1: 30s (no load)") }).textContent).toMatch(/lb$/);
  });

  it("shows no target load on an unweighted set, but shows a logged one", () => {
    const { rerender } = chip(set(), false);
    expect(screen.getByRole("button", { name: named("Hang set 1: 30s") }).textContent).not.toContain("lb");
    rerender(element(set({ targetWeight: 20 }), false));
    expect(screen.getByRole("button", { name: named("Hang set 1: 30s") }).textContent).not.toContain("20");
    rerender(element(set({ done: true, reps: 30, weight: 20 }), false));
    expect(screen.getByRole("button", { name: named("Hang set 1: 30s at 20 lb") }).textContent).toContain("20");
  });

  it("previews a weighted set without a load as an empty “lb”, and an unweighted one without its target load", () => {
    render(
      <ul>
        <PlannedChip index={0} set={set({ targetReps: 40 })} measure="meters" weighted />
        <PlannedChip index={1} set={set({ id: "s2", targetReps: 40, targetWeight: 70 })} measure="meters" weighted={false} />
        <PlannedChip index={2} set={set({ id: "s3", targetReps: 40, targetWeight: 70 })} measure="meters" weighted />
      </ul>,
      { container: root() },
    );
    const [empty, plain, loaded] = screen.getAllByRole("listitem");
    expect(empty!.textContent).toMatch(/Set 1: 40 meters \(no load\).*lb$/);
    expect(plain!.textContent).toBe("Set 2: 40 meters40m");
    expect(loaded!.textContent).toMatch(/Set 3: 40 meters at 70 lb.*70$/);
  });
});

describe("describeSet", () => {
  it("names the load with any measure", () => {
    expect(describeSet(set({ targetWeight: 25 }), "seconds", true)).toBe("30 seconds at 25 lb");
    expect(describeSet(set({ targetReps: 40, targetWeight: 70 }), "meters")).toBe("40 meters at 70 lb");
    expect(describeSet(set({ targetReps: 10 }), "reps", true)).toBe("10 reps (no load)");
    expect(describeSet(set({ targetReps: null }), "reps", true)).toBe("no target (no load)");
    expect(describeSet(set({ targetReps: 10 }), "reps")).toBe("10 reps");
  });
});

describe("set editor", () => {
  const editor = (s: SetEntry, weighted: boolean, onSave = vi.fn()) => {
    render(<SetEditSheet open onClose={() => {}} title="Hang · set 1" set={s} measure="seconds" weighted={weighted} onSave={onSave} />, {
      container: root(),
    });
    return onSave;
  };

  it("offers the load for a weighted exercise and saves it with the time", async () => {
    const user = userEvent.setup();
    const onSave = editor(set(), true);
    expect(screen.queryByText("Load · lb")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Increase load" }));
    await user.click(screen.getByRole("button", { name: "Log set" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ done: true, reps: 30, weight: 5 }));
  });

  it("hides the load for an unweighted exercise", async () => {
    const user = userEvent.setup();
    const onSave = editor(set(), false);
    expect(screen.queryByText("Seconds")).not.toBeNull();
    expect(screen.queryByText("Load · lb")).toBeNull();
    expect(screen.queryByRole("button", { name: "Increase load" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Log set" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ done: true, reps: 30, weight: null }));
  });

  it("keeps a logged load on an unweighted exercise editable", () => {
    editor(set({ done: true, reps: 30, weight: 20 }), false);
    expect(screen.queryByText("Load · lb")).not.toBeNull();
  });

  it("neither shows nor logs a target load on an unweighted exercise", async () => {
    const user = userEvent.setup();
    const onSave = editor(set({ targetWeight: 20 }), false);
    expect(screen.queryByText("Load · lb")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Log set" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ done: true, weight: null }));
  });

  it("stores no load as null, never 0", async () => {
    const user = userEvent.setup();
    const onSave = editor(set({ targetWeight: 5 }), true);
    await user.click(screen.getByRole("button", { name: "Decrease load" }));
    await user.click(screen.getByRole("button", { name: "Save target" }));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ targetWeight: null, weight: null }));
    await user.click(screen.getByRole("button", { name: "Log set" }));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ done: true, weight: null }));
  });
});

describe("Settings' exercise library", () => {
  beforeEach(() => {
    store.update.mockClear();
    store.toast.mockClear();
    store.exercises = [
      exercise({ id: 1, name: "Bench press", category: "primary", tracksMax: true }),
      exercise({ id: 2, name: "Sandbag clean", category: "primary" }),
      exercise({ id: 3, name: "Weighted dead hang", measure: "seconds" }),
      exercise({ id: 4, name: "Pull-up", weighted: false }),
    ];
  });

  it("offers the weighted chip only off the main lifts", () => {
    render(<LiftsEditor />, { container: root() });
    expect(screen.queryByRole("button", { name: "Bench press: weighted" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sandbag clean: weighted" })).toBeNull();
    expect(screen.getByRole("button", { name: "Weighted dead hang: weighted" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Pull-up: weighted" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("turning weighted off says the logged loads are kept, with an undo", async () => {
    const user = userEvent.setup();
    render(<LiftsEditor />, { container: root() });
    await user.click(screen.getByRole("button", { name: "Weighted dead hang: weighted" }));
    expect(store.update).toHaveBeenCalledWith(3, { weighted: false });
    expect(store.toast).toHaveBeenCalledTimes(1);
    const toast = store.toast.mock.calls[0]![0] as { message: string; action: { label: string; onAction: () => void } };
    expect(toast.message).toBe("Weighted dead hang no longer tracks load — logged loads are kept");
    expect(toast.action.label).toBe("Undo");
    toast.action.onAction();
    expect(store.update).toHaveBeenLastCalledWith(3, { weighted: true });

    // Turning it on needs no toast.
    await user.click(screen.getByRole("button", { name: "Pull-up: weighted" }));
    expect(store.update).toHaveBeenLastCalledWith(4, { weighted: true });
    expect(store.toast).toHaveBeenCalledTimes(1);
  });
});
