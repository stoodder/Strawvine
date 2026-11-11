import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { Block, BlockExercise, Session, SetEntry } from "../../../shared/schemas";
import { recapLines } from "./FinishPanel";
import { plateChips, useRestTimer } from "./RestTimer";
import { describeSet, editorChange, nextOpenSet, replaceSetAndPropagate, resolveExRef, resolveSetRef } from "./sessionEdit";

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

describe("replaceSetAndPropagate", () => {
  const three = () =>
    ex(6, [
      set({ targetReps: 10, targetWeight: 50 }),
      set({ targetReps: 10, targetWeight: 50 }),
      set({ targetReps: 10, targetWeight: 50 }),
    ]);
  const targets = (e: BlockExercise) => e.sets.map((x) => `${x.targetReps}@${x.targetWeight}`);

  it("logging a set at fewer reps leaves the later targets alone (a result, not a new plan)", () => {
    const e = three();
    const prev = e.sets[0]!;
    const out = replaceSetAndPropagate(e, prev, { ...prev, done: true, reps: 8, weight: 50 });
    expect(targets(out)).toEqual(["10@50", "10@50", "10@50"]);
  });
  it("logging a set heavier carries the load to the open sets", () => {
    const e = three();
    const prev = e.sets[0]!;
    const out = replaceSetAndPropagate(e, prev, { ...prev, done: true, reps: 8, weight: 55 });
    expect(targets(out)).toEqual(["10@50", "10@55", "10@55"]);
  });
  it("updating a logged set's reps doesn't retarget the later sets", () => {
    const e = three();
    const logged = { ...e.sets[0]!, done: true, reps: 10, weight: 50 };
    const withLogged = { ...e, sets: [logged, ...e.sets.slice(1)] };
    const out = replaceSetAndPropagate(withLogged, logged, { ...logged, reps: 9 });
    expect(targets(out)).toEqual(["10@50", "10@50", "10@50"]);
  });
  it("saving a new target carries the reps and load forward", () => {
    const e = three();
    const prev = e.sets[0]!;
    const out = replaceSetAndPropagate(e, prev, { ...prev, targetReps: 8, targetWeight: 60 });
    expect(targets(out)).toEqual(["8@60", "8@60", "8@60"]);
  });
  it("leaves an AMRAP's reps and a deliberately different target alone", () => {
    const e = ex(1, [set({ targetReps: 5 }), set({ targetReps: 6 }), set({ targetReps: 5, amrap: true })]);
    const prev = e.sets[0]!;
    const out = replaceSetAndPropagate(e, prev, { ...prev, targetReps: 4 });
    expect(out.sets.map((x) => x.targetReps)).toEqual([4, 6, 5]);
  });
});

describe("editorChange (does a save from the set editor need its own Undo?)", () => {
  const open = () => set({ targetReps: 10, targetWeight: 50 });
  const done = () => set({ targetReps: 10, targetWeight: 50, done: true, reps: 10, weight: 50 });

  it("nothing changed: none", () => {
    expect(editorChange(open(), open(), true)).toBe("none");
    expect(editorChange(done(), done(), true)).toBe("none");
  });

  it("logged as it stood — what the row's check does: check", () => {
    const s = open();
    expect(editorChange(s, { ...s, done: true, reps: 10, weight: 50 }, true)).toBe("check");
    // An unweighted exercise's set is logged without the target load it still holds.
    expect(editorChange(s, { ...s, done: true, reps: 10, weight: null }, false)).toBe("check");
    expect(editorChange(s, { ...s, done: true, reps: 10, weight: 50 }, false)).toBe("values");
  });

  it("logged with other reps or another load: values", () => {
    const s = open();
    expect(editorChange(s, { ...s, done: true, reps: 9, weight: 50 }, true)).toBe("values");
    expect(editorChange(s, { ...s, done: true, reps: 10, weight: 55 }, true)).toBe("values");
    // A load set on a set that had none (the check sent it to the editor).
    const bare = set({ targetReps: 10, targetWeight: null });
    expect(editorChange(bare, { ...bare, done: true, reps: 10, weight: 20 }, true)).toBe("values");
  });

  it("a new target, or a logged set updated: values", () => {
    const s = open();
    expect(editorChange(s, { ...s, targetReps: 8 }, true)).toBe("values");
    expect(editorChange(s, { ...s, targetWeight: 55 }, true)).toBe("values");
    const d = done();
    expect(editorChange(d, { ...d, reps: 11 }, true)).toBe("values");
    expect(editorChange(d, { ...d, weight: 45 }, true)).toBe("values");
  });
});

describe("useRestTimer: the set that started the rest", () => {
  beforeEach(() => localStorage.clear());

  it("stops for the set that started it, and only for that one", () => {
    const { result } = renderHook(() => useRestTimer());
    act(() => result.current.start(90, "a"));
    expect(result.current.from).not.toBeNull();
    act(() => result.current.stopIfStartedBy("b"));
    expect(result.current.from).not.toBeNull();
    act(() => result.current.stopIfStartedBy("a"));
    expect(result.current.from).toBeNull();
  });

  it("the latest set to start a rest is the one that owns it", () => {
    const { result } = renderHook(() => useRestTimer());
    act(() => result.current.start(90, "a"));
    act(() => result.current.start(180, "b"));
    act(() => result.current.stopIfStartedBy("a"));
    expect(result.current.from).not.toBeNull();
    expect(result.current.target).toBe(180);
    act(() => result.current.stopIfStartedBy("b"));
    expect(result.current.from).toBeNull();
  });

  it("a rest no single set started (several logged at once) is nobody's to stop", () => {
    const { result } = renderHook(() => useRestTimer());
    act(() => result.current.start(90, "a"));
    act(() => result.current.start(90));
    act(() => result.current.stopIfStartedBy("a"));
    expect(result.current.from).not.toBeNull();
  });

  it("survives a reload, and a dismissed rest forgets its set", () => {
    const first = renderHook(() => useRestTimer());
    act(() => first.result.current.start(90, "a"));
    first.unmount();
    const second = renderHook(() => useRestTimer());
    expect(second.result.current.from).not.toBeNull();
    act(() => second.result.current.stop());
    expect(second.result.current.from).toBeNull();
    // A new rest started by nothing in particular isn't stopped by the old set.
    act(() => second.result.current.start(90));
    act(() => second.result.current.stopIfStartedBy("a"));
    expect(second.result.current.from).not.toBeNull();
  });
});

describe("describeSet (spoken load)", () => {
  it("names no pending target load for an unweighted exercise, but keeps a load already logged", () => {
    const pending = set({ targetReps: 10, targetWeight: 25 });
    expect(describeSet(pending, "reps", false)).toBe("10 reps");
    expect(describeSet(pending, "reps", true)).toBe("10 reps at 25 lb");
    expect(describeSet({ ...pending, done: true, reps: 10, weight: 30 }, "reps", false)).toBe("10 reps at 30 lb");
    expect(describeSet({ ...pending, done: true, reps: 10, weight: null }, "reps", true)).toBe("10 reps (no load)");
    // Without the flag (the main lift): any load, as before.
    expect(describeSet(pending, "reps")).toBe("10 reps at 25 lb");
  });
});
