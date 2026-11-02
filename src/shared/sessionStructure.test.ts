import { describe, expect, it } from "vitest";
import { blockSchema, sessionSchema, type Block, type BlockExercise, type Exercise, type Session, type SetEntry } from "./schemas";
import { blankSet, effectiveSession, savedAfterEdit } from "./session";
import {
  MAX_BLOCKS,
  MAX_SUPERSET,
  locateExercise,
  movableInto,
  moveBlock,
  moveExerciseToBlock,
  reorderInBlock,
  splitOut,
  supersetLetters,
} from "./sessionStructure";

const set = (id: string, o: Partial<SetEntry> = {}) => blankSet({ id, targetReps: 10, targetWeight: 50, ...o });
const logged = (id: string) => set(id, { done: true, reps: 10, weight: 50 });
const ex = (exerciseId: number, ...sets: SetEntry[]): BlockExercise => ({ exerciseId, measure: "reps", sets });
const block = (id: string, ...exercises: BlockExercise[]): Block => ({ id, kind: "accessory", exercises });
const main: Block = { id: "P", kind: "primary", exercises: [ex(1, set("p1"), set("p2"))] };
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
/** "P[1] X[10|11] Y[12]": blocks and the exercises in them, in order. */
const shape = (s: Session) => s.blocks.map((b) => `${b.id}[${b.exercises.map((e) => e.exerciseId).join("|")}]`).join(" ");

const rows = ex(10, logged("r1"), set("r2"));
const curls = ex(11, set("c1"), set("c2"));
const dips = ex(12, set("d1"));
const plank = ex(13, logged("k1"));
const base = sess([main, block("X", rows, curls), block("Y", dips), block("Z", plank)]);

describe("moveExerciseToBlock", () => {
  it("moves an exercise with its sets (logged or not) to the end of another block; its emptied block disappears", () => {
    const m = moveExerciseToBlock(base, { blockId: "Y", exIdx: 0 }, "X");
    expect(shape(m)).toBe("P[1] X[10|11|12] Z[13]");
    expect(m.blocks[1]!.exercises[2]).toBe(dips); // the same exercise: its sets and ids
    const n = moveExerciseToBlock(base, { blockId: "Z", exIdx: 0 }, "Y");
    expect(n.blocks.find((b) => b.id === "Y")!.exercises[1]!.sets[0]).toMatchObject({ id: "k1", done: true });
  });

  it("out of a superset of two leaves a single exercise behind; at a given position", () => {
    const m = moveExerciseToBlock(base, { blockId: "X", exIdx: 0 }, "Z", 0);
    expect(shape(m)).toBe("P[1] X[11] Y[12] Z[10|13]");
  });

  it("keeps the blocks it doesn't touch (same objects) and the moved exercise's identity", () => {
    const m = moveExerciseToBlock(base, { blockId: "Y", exIdx: 0 }, "X");
    expect(m.blocks[0]).toBe(main);
    expect(m.blocks.find((b) => b.id === "Z")).toBe(base.blocks[3]);
    expect(m.blocks[1]!.exercises.slice(0, 2)).toEqual([rows, curls]);
    expect(m.blocks[1]!.exercises[0]).toBe(rows);
  });

  it("is a no-op for the main lift, the same block, a missing block or a full superset", () => {
    expect(moveExerciseToBlock(base, { blockId: "P", exIdx: 0 }, "X")).toBe(base);
    expect(moveExerciseToBlock(base, { blockId: "Y", exIdx: 0 }, "P")).toBe(base);
    expect(moveExerciseToBlock(base, { blockId: "X", exIdx: 0 }, "X")).toBe(base);
    expect(moveExerciseToBlock(base, { blockId: "Q", exIdx: 0 }, "X")).toBe(base);
    expect(moveExerciseToBlock(base, { blockId: "Y", exIdx: 3 }, "X")).toBe(base);
    const full = sess([block("X", ...Array.from({ length: MAX_SUPERSET }, (_, i) => ex(20 + i, set(`f${i}`)))), block("Y", dips)]);
    expect(moveExerciseToBlock(full, { blockId: "Y", exIdx: 0 }, "X")).toBe(full);
  });

  it("moving it again into the block it's now in changes nothing", () => {
    const m = moveExerciseToBlock(base, { blockId: "Y", exIdx: 0 }, "X");
    expect(moveExerciseToBlock(m, locateExercise(m, dips)!, "X")).toBe(m);
  });
});

describe("reorderInBlock", () => {
  it("changes a superset's order (A1/A2), keeping each exercise", () => {
    const m = reorderInBlock(base, "X", 1, 0);
    expect(shape(m)).toBe("P[1] X[11|10] Y[12] Z[13]");
    expect(m.blocks[1]!.exercises[0]).toBe(curls);
    expect(m.blocks[1]!.id).toBe("X");
    expect(m.blocks[2]).toBe(base.blocks[2]);
  });

  it("clamps the target; is a no-op at the same place, out of range or on the main lift", () => {
    expect(shape(reorderInBlock(base, "X", 0, 9))).toBe("P[1] X[11|10] Y[12] Z[13]");
    expect(reorderInBlock(base, "X", 0, 0)).toBe(base);
    expect(reorderInBlock(base, "X", 0, -1)).toBe(base);
    expect(reorderInBlock(base, "X", 5, 0)).toBe(base);
    expect(reorderInBlock(base, "P", 0, 1)).toBe(base);
  });
});

describe("moveBlock", () => {
  it("moves an accessory block among the accessories; the main lift keeps its place", () => {
    expect(shape(moveBlock(base, "Z", 0))).toBe("P[1] Z[13] X[10|11] Y[12]");
    expect(shape(moveBlock(base, "X", 1))).toBe("P[1] Y[12] X[10|11] Z[13]");
    // A main lift that isn't first in the stored list stays where it is.
    const odd = sess([block("X", rows), main, block("Y", dips)]);
    expect(shape(moveBlock(odd, "Y", 0))).toBe("Y[12] P[1] X[10]");
  });

  it("keeps every block object; no-op at its place, for the main lift or a missing block; clamps", () => {
    const m = moveBlock(base, "Y", 0);
    expect(m.blocks.map((b) => b)).toEqual([main, base.blocks[2], base.blocks[1], base.blocks[3]]);
    expect(m.blocks[1]).toBe(base.blocks[2]);
    expect(moveBlock(base, "X", 0)).toBe(base);
    expect(moveBlock(base, "X", -3)).toBe(base);
    expect(moveBlock(base, "P", 2)).toBe(base);
    expect(moveBlock(base, "Q", 0)).toBe(base);
    expect(shape(moveBlock(base, "X", 99))).toBe("P[1] Y[12] Z[13] X[10|11]");
  });
});

describe("splitOut (Remove from superset)", () => {
  it("gives the exercise its own block right after the superset", () => {
    const m = splitOut(base, { blockId: "X", exIdx: 0 }, "N");
    expect(shape(m)).toBe("P[1] X[11] N[10] Y[12] Z[13]");
    expect(m.blocks[2]!.exercises[0]).toBe(rows);
    expect(m.blocks[3]).toBe(base.blocks[2]);
  });

  it("is a no-op for a single exercise, the main lift, or a session at the block limit", () => {
    expect(splitOut(base, { blockId: "Y", exIdx: 0 }, "N")).toBe(base);
    expect(splitOut(base, { blockId: "P", exIdx: 0 }, "N")).toBe(base);
    const many = sess([
      block("X", rows, curls),
      ...Array.from({ length: MAX_BLOCKS - 1 }, (_, i) => block(`b${i}`, ex(30 + i, set(`m${i}`)))),
    ]);
    expect(splitOut(many, { blockId: "X", exIdx: 0 }, "N")).toBe(many);
  });

  it("splitting a superset of two twice changes nothing more", () => {
    const m = splitOut(base, { blockId: "X", exIdx: 0 }, "N");
    expect(splitOut(m, { blockId: "X", exIdx: 0 }, "M")).toBe(m);
  });
});

describe("movableInto / supersetLetters / locateExercise", () => {
  it("offers the other accessories in workout order, never the main lift; nothing for a full block", () => {
    expect(movableInto(base, "Y").map((c) => [c.blockId, c.exercise.exerciseId, c.fromSuperset])).toEqual([
      ["X", 10, true],
      ["X", 11, true],
      ["Z", 13, false],
    ]);
    expect(movableInto(base, "P")).toEqual([]);
    const full = sess([block("X", ...Array.from({ length: MAX_SUPERSET }, (_, i) => ex(20 + i, set(`f${i}`)))), block("Y", dips)]);
    expect(movableInto(full, "X")).toEqual([]);
  });

  it("letters supersets in page order", () => {
    const two = moveExerciseToBlock(base, { blockId: "Y", exIdx: 0 }, "Z");
    expect([...supersetLetters(two)]).toEqual([
      ["X", "A"],
      ["Z", "B"],
    ]);
    expect([...supersetLetters(moveBlock(two, "Z", 0))]).toEqual([
      ["Z", "A"],
      ["X", "B"],
    ]);
  });

  it("finds an exercise again after a move, by its sets", () => {
    const m = splitOut(base, { blockId: "X", exIdx: 0 }, "N");
    expect(locateExercise(m, rows)).toEqual({ blockId: "N", exIdx: 0 });
    expect(locateExercise(m, { ...rows })).toEqual({ blockId: "N", exIdx: 0 });
    expect(locateExercise(m, ex(99, set("zz")))).toBeNull();
  });
});

describe("structure edits on the shown session (savedAfterEdit)", () => {
  // Curls are now timed: with nothing logged, the screen shows them in seconds (not saved).
  const exercises: Pick<Exercise, "id" | "measure">[] = [
    { id: 10, measure: "reps" },
    { id: 11, measure: "seconds" },
    { id: 12, measure: "reps" },
    { id: 13, measure: "reps" },
  ];

  it("a moved or reordered exercise nothing else touched is saved as stored (it keeps following its exercise)", () => {
    const view = effectiveSession(base, exercises);
    expect(view.blocks[1]!.exercises[1]!.measure).toBe("seconds");
    for (const edited of [
      reorderInBlock(view, "X", 1, 0),
      moveExerciseToBlock(view, { blockId: "X", exIdx: 1 }, "Z"),
      splitOut(view, { blockId: "X", exIdx: 1 }, "N"),
      moveBlock(view, "X", 2),
    ]) {
      const saved = savedAfterEdit(edited, view, base);
      const at = locateExercise(saved, curls)!;
      expect(saved.blocks.find((b) => b.id === at.blockId)!.exercises[at.exIdx]).toBe(curls);
      expect(JSON.stringify(saved)).not.toContain('"seconds"');
    }
  });
});

describe("limits", () => {
  it("are the server's (sessionSchema)", () => {
    const of = (n: number) => Array.from({ length: n }, (_, i) => ex(40 + i, set(`l${i}`)));
    expect(blockSchema.safeParse(block("X", ...of(MAX_SUPERSET))).success).toBe(true);
    expect(blockSchema.safeParse(block("X", ...of(MAX_SUPERSET + 1))).success).toBe(false);
    const blocks = (n: number) => of(n).map((e, i) => block(`b${i}`, e));
    expect(sessionSchema.safeParse(sess(blocks(MAX_BLOCKS))).success).toBe(true);
    expect(sessionSchema.safeParse(sess(blocks(MAX_BLOCKS + 1))).success).toBe(false);
  });
});
