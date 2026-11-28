import { describe, expect, it } from "vitest";
import { blockSchema, sessionSchema, type Block, type BlockExercise, type Exercise, type Session, type SetEntry } from "./schemas";
import { blankSet, effectiveSession, savedAfterEdit } from "./session";
import {
  derivedBlockId,
  MAX_BLOCKS,
  MAX_SUPERSET,
  blockGroup,
  groupBlocks,
  moveToSection,
  normalizeSectionOrder,
  pageOrder,
  locateExercise,
  movableInto,
  moveBlock,
  moveExerciseToBlock,
  normalizeMainLift,
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

describe("normalizeMainLift", () => {
  it("keeps the main lift alone in its block; the others move, with their sets, to an accessory block right after it", () => {
    const crowded: Block = { id: "P", kind: "primary", skipped: true, exercises: [ex(1, logged("p1")), ex(2, set("q1")), ex(3)] };
    const s = sess([crowded, block("P-2", dips), block("Y", plank)]);
    const n = normalizeMainLift(s);
    expect(shape(n)).toBe("P[1] P-3[2|3] P-2[12] Y[13]");
    expect(n.blocks[0]).toMatchObject({ kind: "primary", skipped: true });
    expect(n.blocks[1]).toEqual({ id: "P-3", kind: "accessory", exercises: [crowded.exercises[1], crowded.exercises[2]] });
    expect(n.blocks[2]).toBe(s.blocks[1]);
    expect(sessionSchema.safeParse(n).success).toBe(true);
    expect(normalizeMainLift(n)).toBe(n);
  });

  it("returns the same session when the main lift is alone", () => {
    expect(normalizeMainLift(base)).toBe(base);
  });
});

describe("derivedBlockId", () => {
  it("is the first free <id>-n, within the 40-character id limit", () => {
    const taken = new Set(["X", "X-2"]);
    expect(derivedBlockId("X", taken)).toBe("X-3");
    expect(derivedBlockId("X", taken)).toBe("X-4");
    expect(derivedBlockId("a".repeat(40), new Set()).length).toBeLessThanOrEqual(40);
  });
});

describe("groups: Accessories, Core and Rehab (SPEC §6.7)", () => {
  const CORE = { core: true };
  const core = (id: string, ...exercises: BlockExercise[]): Block => ({ id, kind: "accessory", exercises, section: "core" });
  const rehab = (id: string, ...exercises: BlockExercise[]): Block => ({ id, kind: "rehab", exercises, rehab: "knee" });
  const raise = ex(20, set("h1"));
  const hold = ex(21, set("w1"));
  const step = ex(30, set("s1"));
  const ext = ex(31, set("e1"));
  // Stored as an older build may have left it: a core block between accessories.
  const mixed = sess([main, block("X", rows, curls), core("C", raise, hold), block("Y", dips), rehab("R", step), rehab("S", ext)]);

  it("reads blocks in page order (a stable sort) and stores them so; already ordered is the same object", () => {
    expect(pageOrder(mixed, CORE).map((b) => b.id)).toEqual(["P", "X", "Y", "C", "R", "S"]);
    const fixed = normalizeSectionOrder(mixed, CORE);
    expect(shape(fixed)).toBe("P[1] X[10|11] Y[12] C[20|21] R[30] S[31]");
    expect(fixed.blocks[1]).toBe(mixed.blocks[1]);
    expect(normalizeSectionOrder(fixed, CORE)).toBe(fixed);
    expect(normalizeSectionOrder(base, CORE)).toBe(base);
    expect(blockGroup(mixed.blocks[2]!, CORE)).toBe("core");
    expect(groupBlocks(mixed, "rehab").map((b) => b.id)).toEqual(["R", "S"]);
    expect(groupBlocks(mixed, "rehab", { rehab: "hip" })).toEqual([]);
    expect(groupBlocks(mixed, "core", CORE).map((b) => b.id)).toEqual(["C"]);
    // "accessories" (a block moved out of Core) reads as Accessories, as no `section` does.
    expect(blockGroup({ kind: "accessory", section: "accessories" }, CORE)).toBe("accessories");
  });

  it("without subsections (the default) Core reads as Accessories: stored order, letters and moves as before", () => {
    expect(blockGroup(mixed.blocks[2]!)).toBe("accessories");
    expect(pageOrder(mixed).map((b) => b.id)).toEqual(["P", "X", "C", "Y", "R", "S"]);
    expect(normalizeSectionOrder(mixed).blocks.slice(0, 4)).toEqual(mixed.blocks.slice(0, 4));
    const s = sess([main, block("X", rows, curls), core("C", raise, hold), block("Y", dips, plank)]);
    expect([...supersetLetters(s)]).toEqual([
      ["X", "A"],
      ["C", "B"],
      ["Y", "C"],
    ]);
    // An index among every accessory block (Train's Reorder sheet): Core moves past an accessory and back.
    expect(shape(moveBlock(s, "C", 0))).toBe("P[1] C[20|21] X[10|11] Y[12|13]");
    expect(shape(moveBlock(s, "Y", 1))).toBe("P[1] X[10|11] Y[12|13] C[20|21]");
    expect(moveBlock(s, "C", 0).blocks[1]).toBe(s.blocks[2]); // `section` kept: the same block
  });

  it("superset letters run through the page: Accessories, then Core, then Rehab", () => {
    const s = sess([main, core("C", raise, hold), block("X", rows, curls), rehab("R", step, ext)]);
    expect([...supersetLetters(s, CORE)]).toEqual([
      ["X", "A"],
      ["C", "B"],
      ["R", "C"],
    ]);
  });

  it("an exercise joins a superset of Accessories or Core (never added twice); rehab only within its own block", () => {
    // Core ⇄ Accessories: the exercise is then in the target's subsection; the superset stays in one.
    const intoCore = moveExerciseToBlock(mixed, { blockId: "Y", exIdx: 0 }, "C");
    expect(shape(intoCore)).toBe("P[1] X[10|11] C[20|21|12] R[30] S[31]");
    expect(intoCore.blocks[2]!.section).toBe("core");
    expect(shape(moveExerciseToBlock(mixed, { blockId: "C", exIdx: 0 }, "X"))).toBe("P[1] X[10|11|20] C[21] Y[12] R[30] S[31]");
    expect(movableInto(mixed, "C").map((c) => c.exercise.exerciseId)).toEqual([10, 11, 12]);
    expect(movableInto(mixed, "X").map((c) => c.exercise.exerciseId)).toEqual([20, 21, 12]);
    // Rehab: only within its own rehab block.
    expect(moveExerciseToBlock(mixed, { blockId: "R", exIdx: 0 }, "Y")).toBe(mixed);
    expect(moveExerciseToBlock(mixed, { blockId: "Y", exIdx: 0 }, "R")).toBe(mixed);
    const joined = moveExerciseToBlock(mixed, { blockId: "S", exIdx: 0 }, "R");
    expect(shape(joined)).toBe("P[1] X[10|11] C[20|21] Y[12] R[30|31]");
    expect(joined.blocks[4]!.exercises[1]).toBe(ext);
    // Rehab blocks of another rehab block are another group.
    const other = sess([rehab("R", step), { id: "H", kind: "rehab", exercises: [ext], rehab: "hip" }]);
    expect(moveExerciseToBlock(other, { blockId: "H", exIdx: 0 }, "R")).toBe(other);
    expect(movableInto(mixed, "R").map((c) => c.exercise.exerciseId)).toEqual([31]);
  });

  it("reorders within a block and moves blocks among their own group only, every other block in place", () => {
    expect(shape(reorderInBlock(mixed, "R", 0, 0))).toBe(shape(mixed));
    expect(shape(reorderInBlock(mixed, "C", 1, 0))).toBe("P[1] X[10|11] C[21|20] Y[12] R[30] S[31]");
    expect(shape(moveBlock(mixed, "Y", 0, CORE))).toBe("P[1] Y[12] C[20|21] X[10|11] R[30] S[31]");
    expect(moveBlock(mixed, "C", 1, CORE)).toBe(mixed);
    expect(shape(moveBlock(mixed, "S", 0))).toBe("P[1] X[10|11] C[20|21] Y[12] S[31] R[30]");
  });

  it("splitting a member out keeps it in its group (kind, subsection, rehab block)", () => {
    const core2 = splitOut(mixed, { blockId: "C", exIdx: 1 }, "C2");
    expect(core2.blocks.find((b) => b.id === "C2")).toEqual({ id: "C2", kind: "accessory", exercises: [hold], section: "core" });
    const reh = splitOut(moveExerciseToBlock(mixed, { blockId: "S", exIdx: 0 }, "R"), { blockId: "R", exIdx: 0 }, "R2");
    expect(reh.blocks.find((b) => b.id === "R2")).toEqual({ id: "R2", kind: "rehab", exercises: [step], rehab: "knee" });
    // An accessory split out has no subsection key at all, as before.
    expect(Object.keys(splitOut(base, { blockId: "X", exIdx: 0 }, "N").blocks[2]!)).toEqual(["id", "kind", "exercises"]);
  });

  it("moveToSection: a block (a superset whole) to Core or back, at a position, stored in page order", () => {
    const toCore = moveToSection(mixed, "Y", "core", 0);
    expect(shape(toCore)).toBe("P[1] X[10|11] Y[12] C[20|21] R[30] S[31]");
    expect(toCore.blocks[2]!.section).toBe("core");
    expect(supersetLetters(toCore, CORE).get("C")).toBe("B");
    const end = moveToSection(mixed, "X", "core");
    expect(shape(end)).toBe("P[1] Y[12] C[20|21] X[10|11] R[30] S[31]");
    const back = moveToSection(mixed, "C", "accessories");
    expect(shape(back)).toBe("P[1] X[10|11] Y[12] C[20|21] R[30] S[31]");
    // Written as "accessories": pre-fill's legacy Core rule (a template with no `section`) never files it again.
    expect(back.blocks[3]!.section).toBe("accessories");
    expect(back.blocks[3]!.exercises).toBe(mixed.blocks[2]!.exercises);
    expect(shape(moveToSection(mixed, "C", "accessories", 0))).toBe("P[1] C[20|21] X[10|11] Y[12] R[30] S[31]");
    expect(moveToSection(mixed, "C", "core")).toBe(mixed);
    expect(moveToSection(back, "C", "accessories")).toBe(back);
    expect(moveToSection(mixed, "Y", "accessories")).toBe(mixed);
    expect(moveToSection(mixed, "R", "core")).toBe(mixed);
    expect(moveToSection(mixed, "P", "core")).toBe(mixed);
    expect(sessionSchema.parse(toCore)).toEqual(toCore);
    expect(sessionSchema.parse(back)).toEqual(back);
  });
});

describe("Train without subsections, on a document holding Core (from a device with the flag on)", () => {
  // Train.tsx: the list is `accessoryBlocks` (stored order), the Reorder sheet's Move up/down is
  // moveBlock(session, accessories[index].id, index ± 1), letters are `supersetLetters`.
  const accessories = (s: Session) => s.blocks.filter((b) => b.kind === "accessory");
  const moveAccessory = (s: Session, index: number, delta: -1 | 1) => moveBlock(s, accessories(s)[index]!.id, index + delta);
  const names = (s: Session) => accessories(s).map((b) => b.exercises.map((e) => e.exerciseId).join("+"));
  const core = (id: string, ...exercises: BlockExercise[]): Block => ({ id, kind: "accessory", exercises, section: "core" });
  // The flag-on pre-fill stored Core last; then a "+ Exercise" was appended after it here.
  const s = sess([
    main,
    block("X", rows),
    block("Y", dips),
    core("C", ex(20, set("h1")), ex(21, set("k1"))),
    block("N", ex(14, set("n1"))),
  ]);

  it("Move up / down move one place in the list shown, across Core and back", () => {
    expect(names(moveAccessory(s, 2, -1))).toEqual(["10", "20+21", "12", "14"]);
    expect(names(moveAccessory(s, 3, -1))).toEqual(["10", "12", "14", "20+21"]);
    expect(names(moveAccessory(s, 1, 1))).toEqual(["10", "20+21", "12", "14"]);
    expect(names(moveAccessory(moveAccessory(s, 2, -1), 1, 1))).toEqual(names(s));
    // The block keeps its `section`: a device with the subsections still reads it as Core.
    expect(moveAccessory(s, 2, -1).blocks.find((b) => b.id === "C")).toBe(s.blocks[3]);
  });

  it("superset letters follow the list shown", () => {
    const pair = block("Q", ex(15, set("q1")), ex(16, set("q2")));
    const withPair = sess([main, block("X", rows), core("C", ex(20, set("h1")), ex(21, set("k1"))), pair]);
    const letters = supersetLetters(withPair);
    expect(
      accessories(withPair)
        .filter((b) => b.exercises.length > 1)
        .map((b) => letters.get(b.id)),
    ).toEqual(["A", "B"]);
    const moved = sess([main, pair, block("X", rows), core("C", ex(20, set("h1")), ex(21, set("k1")))]);
    expect(supersetLetters(moved).get("Q")).toBe("A");
  });

  it("a document with no `section` (every one saved before this wave) reads the same with or without the subsections: indices, letters", () => {
    expect(moveBlock(base, "Z", 0, { core: true })).toEqual(moveBlock(base, "Z", 0));
    expect(supersetLetters(base, { core: true })).toEqual(supersetLetters(base));
    expect(names(moveAccessory(base, 2, -1))).toEqual(["10+11", "13", "12"]);
  });
});
