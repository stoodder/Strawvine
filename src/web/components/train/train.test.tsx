import { describe, expect, it } from "vitest";
import type { Block, BlockExercise, Session, SetEntry } from "../../../shared/schemas";
import { recapLines } from "./FinishPanel";
import { plateChips } from "./RestTimer";
import { nextOpenSet, resolveExRef, resolveSetRef } from "./sessionEdit";

let n = 0;
const set = (o: Partial<SetEntry> = {}): SetEntry => ({
  id: `s${n++}`,
  targetReps: 5,
  targetWeight: 100,
  reps: null,
  weight: null,
  done: false,
  amrap: false,
  appliedProgressionLb: null,
  ...o,
});
const ex = (exerciseId: number, sets: SetEntry[], o: Partial<BlockExercise> = {}): BlockExercise => ({
  exerciseId,
  measure: "reps",
  sets,
  ...o,
});
const session = (blocks: Block[]): Session => ({
  date: "2026-11-02",
  label: "Push",
  cycle: 1,
  week: 4,
  deload: false,
  primaryMaxLb: 315,
  notes: "",
  completedAt: null,
  blocks,
});

describe("nextOpenSet", () => {
  const m = [set({ done: true }), set(), set()];
  const a = [set(), set()];
  const s = session([
    { id: "acc", kind: "accessory", exercises: [ex(6, a)] },
    { id: "main", kind: "primary", exercises: [ex(1, m)] },
  ]);
  it("is the next open set of the same exercise, in page order (main lift first)", () => {
    expect(nextOpenSet(s, { blockId: "main", exIdx: 0, setId: m[0]!.id })?.set.id).toBe(m[1]!.id);
  });
  it("moves on to the next exercise after the last set", () => {
    expect(nextOpenSet(s, { blockId: "main", exIdx: 0, setId: m[2]!.id })?.set.id).toBe(a[0]!.id);
  });
  it("without a logged set, is the first open set", () => {
    expect(nextOpenSet(s, null)?.set.id).toBe(m[1]!.id);
  });
  it("leaves out a skipped main lift", () => {
    const skipped = { ...s, blocks: s.blocks.map((b) => (b.kind === "primary" ? { ...b, skipped: true } : b)) };
    expect(nextOpenSet(skipped, null)?.set.id).toBe(a[0]!.id);
  });
});

describe("resolveSetRef / resolveExRef", () => {
  const dip = ex(7, [set()]);
  const row = ex(8, [set()]);
  const before = session([{ id: "b", kind: "accessory", exercises: [dip, row] }]);
  const merged = session([{ id: "b", kind: "accessory", exercises: [ex(6, [set()]), dip, row] }]);
  it("keeps a ref whose target hasn't moved", () => {
    const ref = { blockId: "b", exIdx: 1, setId: row.sets[0]!.id };
    expect(resolveSetRef(before, ref)).toBe(ref);
  });
  it("follows a set whose exercise moved in a merge", () => {
    expect(resolveSetRef(merged, { blockId: "b", exIdx: 1, setId: row.sets[0]!.id })?.exIdx).toBe(2);
    expect(resolveExRef(merged, { blockId: "b", exIdx: 1, exerciseId: 8 })?.exIdx).toBe(2);
  });
  it("is null when the target is gone", () => {
    const without = session([{ id: "b", kind: "accessory", exercises: [dip] }]);
    expect(resolveSetRef(without, { blockId: "b", exIdx: 1, setId: row.sets[0]!.id })).toBeNull();
    expect(resolveExRef(without, { blockId: "b", exIdx: 1, exerciseId: 8 })).toBeNull();
  });
});

describe("plateChips", () => {
  it("lists pairs, folds runs of three", () => {
    expect(plateChips([45, 45])).toEqual([
      { plate: 45, count: 1 },
      { plate: 45, count: 1 },
    ]);
    expect(plateChips([45, 45, 45, 10])).toEqual([
      { plate: 45, count: 3 },
      { plate: 10, count: 1 },
    ]);
  });
  it("folds pairs too when there would be more than four chips", () => {
    expect(plateChips([45, 45, 25, 10, 5, 2.5]).map((g) => `${g.plate}x${g.count}`)).toEqual(["45x2", "25x1", "10x1", "5x1", "2.5x1"]);
  });
});

describe("recapLines", () => {
  it("notes a skipped main lift and ignores its sets", () => {
    const s = session([
      { id: "main", kind: "primary", skipped: true, exercises: [ex(1, [set({ amrap: true, done: true, reps: 9, targetReps: 6 })])] },
    ]);
    expect(recapLines(s, () => "Bench press")).toEqual([{ text: "Bench press skipped today", gold: false }]);
  });
});
