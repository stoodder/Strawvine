/**
 * Weighted exercises (any measure + a load) in the Train components: creating one, and showing
 * or hiding the load on set chips and in the set editor.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Exercise, SetEntry } from "../../../shared/schemas";
import { AddExerciseSheet } from "./AddExerciseSheet";
import { PlannedChip, SetChip } from "./SetControls";
import { SetEditSheet } from "./SetSheets";
import { describeSet } from "./sessionEdit";

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
  ];
  const sheet = (onCreate = vi.fn(async () => {})) => {
    render(
      <AddExerciseSheet
        open
        onClose={() => {}}
        title="Add exercise"
        exercises={library}
        recentIds={[]}
        onPick={() => {}}
        onCreate={onCreate}
      />,
      { container: root() },
    );
    return onCreate;
  };

  it("is weighted by default and combines the load with any measure", async () => {
    const user = userEvent.setup();
    const onCreate = sheet();
    await user.type(screen.getByRole("textbox", { name: "Search or create exercise" }), "Weighted dead hang");
    const weighted = screen.getByRole("switch", { name: "Weighted", description: "Log a load (lb) with each set" });
    expect(weighted.getAttribute("aria-checked")).toBe("true");
    await user.click(screen.getByRole("button", { name: "Time" }));
    await user.click(screen.getByRole("button", { name: /Create & add/ }));
    expect(onCreate).toHaveBeenCalledWith({ name: "Weighted dead hang", category: "accessory", measure: "seconds", weighted: true });
  });

  it("can be made unweighted (a run, a plank)", async () => {
    const user = userEvent.setup();
    const onCreate = sheet();
    await user.type(screen.getByRole("textbox", { name: "Search or create exercise" }), "Shuttle run");
    await user.click(screen.getByRole("button", { name: "Distance" }));
    await user.click(screen.getByRole("switch", { name: "Weighted" }));
    expect(screen.getByRole("switch", { name: "Weighted" }).getAttribute("aria-checked")).toBe("false");
    await user.click(screen.getByRole("button", { name: /Create & add/ }));
    expect(onCreate).toHaveBeenCalledWith({ name: "Shuttle run", category: "accessory", measure: "meters", weighted: false });
  });

  it("tags the library with what each exercise logs besides reps", () => {
    sheet();
    const tag = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) }).textContent!.slice(name.length);
    expect(tag("Pull-up")).toBe("Accessory");
    expect(tag("Farmer's carry")).toBe("Carry · m · lb");
    expect(tag("Plank")).toBe("Core · s");
    expect(tag("Cable row")).toBe("Accessory · lb");
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

  it("shows a weighted set without a load as “—”, so there's a load to set", () => {
    chip(set(), true);
    expect(screen.getByRole("button", { name: named("Hang set 1: 30s (no load)") }).textContent).toContain("—");
  });

  it("shows no load on an unweighted set, but still shows one an old set has", () => {
    const { rerender } = chip(set(), false);
    expect(screen.getByRole("button", { name: named("Hang set 1: 30s") }).textContent).not.toContain("—");
    rerender(element(set({ done: true, reps: 30, weight: 20 }), false));
    expect(screen.getByRole("button", { name: named("Hang set 1: 30s at 20 lb") }).textContent).toContain("20");
  });

  it("previews a weighted set without a load as “—” too", () => {
    render(
      <ul>
        <PlannedChip index={0} set={set({ targetReps: 40 })} measure="meters" weighted />
        <PlannedChip index={1} set={set({ id: "s2", targetReps: 40 })} measure="meters" weighted={false} />
      </ul>,
      { container: root() },
    );
    const [weighted, plain] = screen.getAllByRole("listitem");
    expect(weighted!.textContent).toMatch(/Set 1: 40 meters \(no load\).*—/);
    expect(plain!.textContent).not.toContain("—");
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

  it("keeps an old load on an unweighted exercise editable rather than hiding it", () => {
    editor(set({ targetWeight: 20 }), false);
    expect(screen.queryByText("Load · lb")).not.toBeNull();
  });
});
