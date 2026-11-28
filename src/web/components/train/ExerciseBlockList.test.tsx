/**
 * The block list of the Train page (Accessories now; Core and Rehab later): it shows exactly the
 * blocks it is given, with page-wide superset letters, and every control goes through `actions`
 * with the block, exercise and set it was on. It saves nothing and holds no state.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, type Mock } from "vitest";
import type { Block, BlockExercise, SetEntry } from "../../../shared/schemas";
import { blankSet } from "../../../shared/session";
import {
  ExerciseBlockList,
  exKey,
  foldedItems,
  hintApplies,
  type BlockActions,
  type BlockListContext,
  type ExerciseHint,
} from "./ExerciseBlockList";

const root = () => document.getElementById("root")!;
const names: Record<number, string> = { 10: "Rows", 11: "Curls", 12: "Dips", 13: "Plank" };
const sets = (exerciseId: number, n = 2, o: Partial<SetEntry> = {}) =>
  Array.from({ length: n }, (_, i) => ({ ...blankSet({ id: `${exerciseId}-${i}`, targetReps: 10, targetWeight: 50 }), ...o }));
const ex = (exerciseId: number, o: Partial<BlockExercise> = {}): BlockExercise => ({
  exerciseId,
  measure: "reps",
  sets: sets(exerciseId),
  ...o,
});
const block = (id: string, ...exercises: BlockExercise[]): Block => ({ id, kind: "accessory", exercises });

function actions(): { [K in keyof BlockActions]: Mock<BlockActions[K]> } {
  return {
    onFold: vi.fn(),
    onCheck: vi.fn(),
    onEditSet: vi.fn(),
    onOptions: vi.fn(),
    onUnskip: vi.fn(),
    onAddSet: vi.fn(),
    onManage: vi.fn(),
    onApplyHint: vi.fn(),
    onDismissHint: vi.fn(),
  };
}
const ctx = (o: Partial<BlockListContext> = {}): BlockListContext => ({
  isPreview: false,
  isRecord: false,
  letters: new Map(),
  exName: (id) => names[id] ?? "Exercise",
  exWeighted: () => true,
  folded: () => false,
  ...o,
});
function list(blocks: Block[], o: Partial<BlockListContext> = {}, hintFor?: (e: BlockExercise) => ExerciseHint | null) {
  const a = actions();
  render(<ExerciseBlockList blocks={blocks} ctx={ctx(o)} actions={a} hintFor={hintFor} />, { container: root() });
  return a;
}

describe("ExerciseBlockList", () => {
  it("shows exactly the blocks it is given, in their order (a filtered set)", () => {
    list([block("b2", ex(12)), block("b1", ex(10))]);
    const blocks = [...root().querySelectorAll("[data-block]")].map((el) => el.getAttribute("data-block"));
    expect(blocks).toEqual(["b2", "b1"]);
    expect(screen.getByRole("list", { name: "Dips sets" })).toBeTruthy();
    expect(screen.queryByText("Curls")).toBeNull();
  });

  it("names a superset by its page-wide letter, tags its members, and opens its sheet", async () => {
    const user = userEvent.setup();
    // Core's first superset follows the accessories': it is C here, not A.
    const a = list([block("ss", ex(10), ex(11))], { letters: new Map([["ss", "C"]]) });
    expect(screen.getByText("C1")).toBeTruthy();
    expect(screen.getByText("C2")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Manage Superset C" }));
    expect(a.onManage).toHaveBeenCalledWith("ss");
  });

  it("passes the block, exercise and set of each control", async () => {
    const user = userEvent.setup();
    const a = list([block("b1", ex(10)), block("b2", ex(12))]);
    await user.click(screen.getByRole("button", { name: "Dips set 2: 10 reps at 50 lb" }));
    expect(a.onCheck).toHaveBeenCalledWith({ blockId: "b2", exIdx: 0, setId: "12-1" });
    await user.click(screen.getByRole("button", { name: "Edit Dips set 2: 10 × 50 lb" }));
    expect(a.onEditSet).toHaveBeenCalledWith({ blockId: "b2", exIdx: 0, setId: "12-1" });
    await user.click(screen.getByRole("button", { name: "Rows options" }));
    expect(a.onOptions).toHaveBeenCalledWith({ blockId: "b1", exIdx: 0, exerciseId: 10 });
    await user.click(screen.getByRole("button", { name: "Add Rows set" }));
    expect(a.onAddSet).toHaveBeenCalledWith({ blockId: "b1", exIdx: 0 });
  });

  it("shows a skipped exercise as one row with Unskip", async () => {
    const user = userEvent.setup();
    const a = list([block("ss", ex(10), ex(11, { skipped: true }))], { letters: new Map([["ss", "A"]]) });
    expect(screen.queryByRole("list", { name: "Curls sets" })).toBeNull();
    expect(screen.getByText(/Skipped/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Unskip Curls" }));
    expect(a.onUnskip).toHaveBeenCalledWith({ blockId: "ss", exIdx: 1 });
  });

  it("shows the hint it is given, with Apply and dismiss; none without hintFor", async () => {
    const user = userEvent.setup();
    const hint: ExerciseHint = {
      kind: "increase",
      measure: "reps",
      lastWeight: 50,
      suggestedWeight: 55,
      reason: "All reps at 50 lb on Nov 2 → +5 lb",
    };
    const a = list([block("b1", ex(10)), block("b2", ex(12))], {}, (e) => (e.exerciseId === 10 ? hint : null));
    await user.click(screen.getByRole("button", { name: "Apply 55 lb to the open Rows sets" }));
    expect(a.onApplyHint).toHaveBeenCalledWith({ blockId: "b1", exIdx: 0 }, 55, "Rows");
    await user.click(screen.getByRole("button", { name: "Dismiss the Rows hint for today" }));
    expect(a.onDismissHint).toHaveBeenCalledWith({ blockId: "b1", exIdx: 0 }, 10);
    expect(screen.queryByRole("button", { name: /Dips hint/ })).toBeNull();
  });

  it("in a preview, shows the plan without controls", () => {
    list([block("ss", ex(10), ex(11))], { isPreview: true, letters: new Map([["ss", "A"]]) });
    expect(screen.getByText("Superset A")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Manage|options|Add .* set/ })).toBeNull();
  });

  it("folds a done block to its row, which opens it; the open block's name folds it", async () => {
    const user = userEvent.setup();
    const done = block("d", ex(10, { sets: sets(10, 2, { done: true, reps: 10, weight: 50 }) }));
    const a = list([done, block("o", ex(12))], { folded: (id) => id === "d" });
    const row = root().querySelector('[data-fold="d"]')!;
    expect(row.hasAttribute("data-folded")).toBe(true);
    expect(within(row as HTMLElement).queryByRole("list")).toBeNull();
    await user.click(within(row as HTMLElement).getByRole("button", { expanded: false }));
    expect(a.onFold).toHaveBeenCalledWith("d", false);
  });

  it("an open done block folds again from its name", async () => {
    const user = userEvent.setup();
    const done = block("d", ex(10, { sets: sets(10, 2, { done: true, reps: 10, weight: 50 }) }));
    const a = list([done]);
    const row = root().querySelector('[data-fold="d"]') as HTMLElement;
    expect(row.hasAttribute("data-done")).toBe(true);
    await user.click(within(row).getByRole("button", { expanded: true }));
    expect(a.onFold).toHaveBeenCalledWith("d", true);
  });
});

describe("helpers", () => {
  it("exKey follows the exercise's first set", () => {
    expect(exKey(ex(10), 0, "b")).toBe("10-0");
    expect(exKey({ exerciseId: 10, measure: "reps", sets: [] }, 2, "b")).toBe("eb-10-2");
  });
  it("foldedItems tags superset members with the page-wide letter", () => {
    const items = foldedItems(
      block("ss", ex(10), ex(11)),
      new Map([["ss", "B"]]),
      (id) => names[id]!,
      () => true,
    );
    expect(items.map((i) => [i.name, i.tag])).toEqual([
      ["Rows", "B1"],
      ["Curls", "B2"],
    ]);
  });
  it("hintApplies: an increase while an open set is below it; a hold while sets are open", () => {
    const up: ExerciseHint = { kind: "increase", measure: "reps", lastWeight: 50, suggestedWeight: 55, reason: "" };
    expect(hintApplies(up, sets(10))).toBe(true);
    expect(hintApplies(up, sets(10, 2, { targetWeight: 55 }))).toBe(false);
    expect(hintApplies({ ...up, kind: "hold", suggestedWeight: 50 }, sets(10, 2, { done: true }))).toBe(false);
  });
});
