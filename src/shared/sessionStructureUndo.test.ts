import { describe, expect, it } from "vitest";
import type { Block, BlockExercise, Session, SetEntry } from "./schemas";
import { blankSet, effectiveSession, savedAfterEdit } from "./session";
import { MAX_SUPERSET, moveExerciseToBlock, splitOut } from "./sessionStructure";
import { addStandings, rejoinSuperset } from "./sessionStructureUndo";

const set = (id: string, o: Partial<SetEntry> = {}) => blankSet({ id, targetReps: 10, ...o });
const ex = (exerciseId: number, ...sets: SetEntry[]): BlockExercise => ({ exerciseId, measure: "reps", sets });
const block = (id: string, ...exercises: BlockExercise[]): Block => ({ id, kind: "accessory", exercises });
const main: Block = { id: "P", kind: "primary", exercises: [ex(1, set("p1"))] };
const sess = (blocks: Block[]): Session => ({
  date: "2026-11-02",
  label: "Push",
  cycle: 1,
  week: 1,
  deload: false,
  primaryMaxLb: 225,
  blocks,
  notes: "",
  completedAt: null,
});
const shape = (s: Session) => s.blocks.map((b) => `${b.id}[${b.exercises.map((e) => e.exerciseId).join("|")}]`).join(" ");

describe("addStandings", () => {
  it("marks the block's members, moves an accessory from elsewhere (first copy), and keeps out the main lift", () => {
    const s = sess([main, block("X", ex(10, set("a")), ex(11, set("b"))), block("Y", ex(12, set("c"))), block("Z", ex(12, set("d")), ex(13))]);
    const m = addStandings(s, "X");
    expect(m.get(10)).toEqual({ kind: "member" });
    expect(m.get(11)).toEqual({ kind: "member" });
    expect(m.get(12)).toEqual({ kind: "elsewhere", place: { blockId: "Y", exIdx: 0 } });
    expect(m.get(13)).toEqual({ kind: "elsewhere", place: { blockId: "Z", exIdx: 1 } });
    expect(m.get(1)).toEqual({ kind: "main" });
    expect(m.has(99)).toBe(false);
  });

  it("the main lift done as an accessory elsewhere moves; a member wins over both", () => {
    const s = sess([main, block("X", ex(10)), block("Y", ex(1, set("c")))]);
    expect(addStandings(s, "X").get(1)).toEqual({ kind: "elsewhere", place: { blockId: "Y", exIdx: 0 } });
    expect(addStandings(sess([main, block("X", ex(1), ex(10))]), "X").get(1)).toEqual({ kind: "member" });
  });
});

describe("rejoinSuperset (undo Remove from superset)", () => {
  const rows = ex(10, set("r1"));
  const curls = ex(11, set("c1"));
  const dips = ex(12, set("d1"));
  const base = sess([main, block("X", rows, curls, dips), block("Y", ex(13, set("y1")))]);

  it("puts A1 back as A1, with the block of its own gone", () => {
    const split = splitOut(base, { blockId: "X", exIdx: 0 }, "own");
    expect(shape(split)).toBe("P[1] X[11|12] own[10] Y[13]");
    const r = rejoinSuperset(split, { blockId: "X", exIdx: 0 }, "own", 10, [rows]);
    expect("session" in r && shape(r.session)).toBe("P[1] X[10|11|12] Y[13]");
    expect("session" in r && r.session.blocks[1]!.exercises[0]).toBe(rows);
  });

  it("finds a zero-set exercise by its block even when the shown copy is another object", () => {
    // Shown in the exercise's new measure (effectiveSession), saved as stored: neither object nor set id matches.
    const plank: BlockExercise = { exerciseId: 20, measure: "reps", sets: [] };
    const s = sess([main, block("X", plank, curls)]);
    const view = effectiveSession(s, [{ id: 20, measure: "seconds" }]);
    const shown = view.blocks[1]!.exercises[0]!;
    expect(shown).not.toBe(plank);
    const saved = savedAfterEdit(splitOut(view, { blockId: "X", exIdx: 0 }, "own"), view, s);
    const copy = { ...saved, blocks: saved.blocks.map((b) => ({ ...b, exercises: b.exercises.map((e) => ({ ...e })) })) };
    const r = rejoinSuperset(copy, { blockId: "X", exIdx: 0 }, "own", 20, [shown]);
    expect("session" in r && shape(r.session)).toBe("P[1] X[20|11]");
  });

  it("follows it into another block (by its sets), and only reorders when it is already back", () => {
    const split = splitOut(base, { blockId: "X", exIdx: 0 }, "own");
    const movedOn = moveExerciseToBlock(split, { blockId: "own", exIdx: 0 }, "Y");
    expect(shape(movedOn)).toBe("P[1] X[11|12] Y[13|10]");
    const r = rejoinSuperset(movedOn, { blockId: "X", exIdx: 0 }, "own", 10, [{ ...rows }]);
    expect("session" in r && shape(r.session)).toBe("P[1] X[10|11|12] Y[13]");
    const back = moveExerciseToBlock(split, { blockId: "own", exIdx: 0 }, "X");
    const again = rejoinSuperset(back, { blockId: "X", exIdx: 0 }, "own", 10, [rows]);
    expect("session" in again && shape(again.session)).toBe("P[1] X[10|11|12] Y[13]");
  });

  it("says why when it can't: gone, superset gone, superset full", () => {
    const split = splitOut(base, { blockId: "X", exIdx: 1 }, "own");
    const removed = { ...split, blocks: split.blocks.filter((b) => b.id !== "own") };
    expect(rejoinSuperset(removed, { blockId: "X", exIdx: 1 }, "own", 11, [curls])).toEqual({ cannot: "gone" });
    const noSuperset = { ...split, blocks: split.blocks.filter((b) => b.id !== "X") };
    expect(rejoinSuperset(noSuperset, { blockId: "X", exIdx: 1 }, "own", 11, [curls])).toEqual({ cannot: "superset-gone" });
    const filled = {
      ...split,
      blocks: split.blocks.map((b) =>
        b.id === "X" ? { ...b, exercises: Array.from({ length: MAX_SUPERSET }, (_, i) => ex(30 + i, set(`f${i}`))) } : b,
      ),
    };
    expect(rejoinSuperset(filled, { blockId: "X", exIdx: 1 }, "own", 11, [curls])).toEqual({ cannot: "full" });
  });
});
