/**
 * The superset and workout-order sheets: members in order with Move up / Move down and Remove from
 * superset, what can join, and the order of the workout's blocks. Driven here by the shared
 * structure edits (as Train drives them), so the rows follow what an edit did.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Block, BlockExercise, Session } from "../../../shared/schemas";
import { blankSet } from "../../../shared/session";
import { accessoryBlocks, movableInto, moveBlock, reorderInBlock, supersetLetters } from "../../../shared/sessionStructure";
import { SupersetSheet, WorkoutOrderSheet } from "./SupersetSheets";

const names: Record<number, string> = { 10: "Rows", 11: "Curls", 12: "Dips", 13: "Chest-supported incline dumbbell row" };
const ex = (exerciseId: number, sets = 3): BlockExercise => ({
  exerciseId,
  measure: "reps",
  sets: Array.from({ length: sets }, (_, i) => blankSet({ id: `${exerciseId}-${i}`, targetReps: 10 })),
});
const block = (id: string, ...exercises: BlockExercise[]): Block => ({ id, kind: "accessory", exercises });
const start: Session = {
  date: "2026-11-02",
  label: "Push",
  cycle: 1,
  week: 1,
  deload: false,
  primaryMaxLb: 225,
  notes: "",
  completedAt: null,
  blocks: [{ id: "P", kind: "primary", exercises: [ex(1, 4)] }, block("X", ex(10), ex(11), ex(13)), block("Y", ex(12))],
};
const limitNote = { superset: "A superset holds up to 6 exercises", blocks: "A session holds up to 30 blocks" };

function SupersetHarness({ onAddExisting = vi.fn() }: { onAddExisting?: (key: string) => void }) {
  const [s, setS] = useState(start);
  const [status, setStatus] = useState("");
  const b = s.blocks.find((x) => x.id === "X")!;
  const letter = supersetLetters(s).get("X") ?? null;
  return (
    <SupersetSheet
      open
      onClose={() => {}}
      letter={letter}
      members={b.exercises.map((e) => ({ key: e.sets[0]!.id, name: names[e.exerciseId]!, detail: "3 sets" }))}
      candidates={movableInto(s, "X").map((c) => ({ key: c.exercise.sets[0]!.id, name: names[c.exercise.exerciseId]!, from: null }))}
      full={false}
      blocksFull={false}
      status={status}
      limitNote={limitNote}
      onMove={(i, d) => {
        setS(reorderInBlock(s, "X", i, i + d));
        setStatus(
          `${names[b.exercises[i]!.exerciseId]} moved ${d < 0 ? "up" : "down"} · now ${letter}${i + d + 1} of ${b.exercises.length}`,
        );
      }}
      onRemove={() => {}}
      onAddExisting={onAddExisting}
      onAddNew={() => {}}
    />
  );
}

const memberNames = (sheet: HTMLElement) =>
  within(within(sheet).getAllByRole("list")[0]!)
    .getAllByRole("listitem")
    .map((li) => li.textContent);

describe("SupersetSheet", () => {
  it("lists the members in order and moves one, keeping focus on the pressed button and announcing it", async () => {
    const user = userEvent.setup();
    render(<SupersetHarness />, { container: document.getElementById("root")! });
    const sheet = screen.getByRole("dialog", { name: "Superset A" });
    expect(memberNames(sheet)).toEqual([
      expect.stringMatching(/^A1: Rows/),
      expect.stringMatching(/^A2: Curls/),
      expect.stringMatching(/^A3: Chest-supported/),
    ]);
    // The first can't go up, the last can't go down: aria-disabled (still focusable), not disabled.
    expect(within(sheet).getByRole("button", { name: "Move Rows up in Superset A" }).getAttribute("aria-disabled")).toBe("true");
    expect(
      within(sheet)
        .getByRole("button", { name: "Move Chest-supported incline dumbbell row down in Superset A" })
        .getAttribute("aria-disabled"),
    ).toBe("true");

    const down = within(sheet).getByRole("button", { name: "Move Rows down in Superset A" });
    await user.click(down);
    expect(memberNames(sheet)).toEqual([
      expect.stringMatching(/^A1: Curls/),
      expect.stringMatching(/^A2: Rows/),
      expect.stringMatching(/^A3: Chest-supported/),
    ]);
    expect(document.activeElement).toBe(down);
    expect(within(sheet).getByRole("status").textContent).toBe("Rows moved down · now A2 of 3");
    // Twice to the end: the button that took it there stays focused, now aria-disabled.
    await user.click(down);
    expect(document.activeElement).toBe(down);
    expect(down.getAttribute("aria-disabled")).toBe("true");
    await user.click(down); // nowhere to go: nothing happens
    expect(memberNames(sheet)[2]).toMatch(/^A3: Rows/);
  });

  it("offers this workout's other accessories and a new exercise; remove is per member", async () => {
    const user = userEvent.setup();
    const onAddExisting = vi.fn();
    render(<SupersetHarness onAddExisting={onAddExisting} />, { container: document.getElementById("root")! });
    const sheet = screen.getByRole("dialog", { name: "Superset A" });
    await user.click(within(sheet).getByRole("button", { name: "Add Dips to Superset A" }));
    expect(onAddExisting).toHaveBeenCalledWith("12-0");
    expect(within(sheet).getByRole("button", { name: "Add new exercise" })).toBeTruthy();
    for (const n of ["Rows", "Curls"]) expect(within(sheet).getByRole("button", { name: `Remove ${n} from Superset A` })).toBeTruthy();
  });

  it("a single exercise: how a superset starts (no moves or remove), and the limits when full", () => {
    render(
      <SupersetSheet
        open
        onClose={() => {}}
        letter={null}
        members={[{ key: "a", name: "Dips", detail: "1 set" }]}
        candidates={[{ key: "b", name: "Rows", from: "Superset A" }]}
        full
        blocksFull={false}
        status=""
        limitNote={limitNote}
        onMove={() => {}}
        onRemove={() => {}}
        onAddExisting={() => {}}
        onAddNew={() => {}}
      />,
      { container: document.getElementById("root")! },
    );
    const sheet = screen.getByRole("dialog", { name: "New superset" });
    expect(within(sheet).queryByRole("button", { name: /^Move/ })).toBeNull();
    expect(within(sheet).queryByRole("button", { name: /^Remove/ })).toBeNull();
    const pair = within(sheet).getByRole("button", { name: "Superset Dips with Rows" });
    expect(pair.textContent).toContain("Leaves Superset A");
    expect(pair.getAttribute("aria-disabled")).toBe("true");
    expect(within(sheet).getByText("A superset holds up to 6 exercises")).toBeTruthy();
  });
});

describe("WorkoutOrderSheet", () => {
  function OrderHarness() {
    const [s, setS] = useState(start);
    const [status, setStatus] = useState("");
    const list = accessoryBlocks(s);
    const letters = supersetLetters(s);
    return (
      <WorkoutOrderSheet
        open
        onClose={() => {}}
        mainLift="Bench press"
        blocks={list.map((b) => ({
          key: b.id,
          title: b.exercises.length > 1 ? `Superset ${letters.get(b.id)}` : names[b.exercises[0]!.exerciseId]!,
          members: b.exercises.length > 1 ? b.exercises.map((e) => names[e.exerciseId]!) : [],
        }))}
        status={status}
        onMove={(i, d) => {
          setS(moveBlock(s, list[i]!.id, i + d));
          setStatus(`moved to ${i + d + 1} of ${list.length}`);
        }}
      />
    );
  }

  it("lists the main lift first (fixed) and moves blocks", async () => {
    const user = userEvent.setup();
    render(<OrderHarness />, { container: document.getElementById("root")! });
    const sheet = screen.getByRole("dialog", { name: "Workout order" });
    const rows = () =>
      within(sheet)
        .getAllByRole("listitem")
        .map((li) => li.textContent);
    expect(rows()[0]).toMatch(/^Main liftBench press/);
    expect(rows()[1]).toMatch(/^Superset A: Rows · , Curls/);
    expect(within(sheet).queryByRole("button", { name: /Bench press/ })).toBeNull();
    const up = within(sheet).getByRole("button", { name: "Move Dips up in workout" });
    await user.click(up);
    expect(rows()[1]).toBe("Dips");
    expect(document.activeElement).toBe(up);
    expect(up.getAttribute("aria-disabled")).toBe("true");
    expect(within(sheet).getByRole("status").textContent).toBe("moved to 1 of 2");
  });
});
