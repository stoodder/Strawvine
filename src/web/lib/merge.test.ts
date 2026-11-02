import { describe, expect, it } from "vitest";
import { defaultSettings } from "../../shared/defaults";
import type { Bootstrap, Session, SetEntry } from "../../shared/schemas";
import { blankSet } from "../../shared/session";
import {
  ackEntry,
  addOp,
  emptyOutbox,
  failEntry,
  isNoopDelete,
  overlay,
  request,
  resolveConflict,
  validateOp,
  type Op,
} from "./outbox-core";
import { fitSession, mergeFields, mergeSession, mergeSettings, mergeSettingsDetailed } from "./merge";
import { MAX_BLOCKS, moveBlock, moveExerciseToBlock, splitOut } from "../../shared/sessionStructure";

const settings = defaultSettings({ bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 }, "2026-11-01");

const set = (id: string, partial: Partial<SetEntry> = {}) => blankSet({ id, targetReps: 5, targetWeight: 100, ...partial });
const logged = (id: string, reps = 5, weight = 100) => set(id, { done: true, reps, weight });
const sess = (blocks: Session["blocks"], extra: Partial<Session> = {}): Session => ({
  date: "2026-11-02",
  label: "Push",
  cycle: 1,
  week: 1,
  deload: false,
  primaryMaxLb: 315,
  blocks,
  notes: "",
  completedAt: null,
  planSig: null,
  ...extra,
});
const primary = (sets: SetEntry[], id = "p") => ({
  id,
  kind: "primary" as const,
  exercises: [{ exerciseId: 1, measure: "reps" as const, sets }],
});
const accessory = (id: string, exerciseId: number, sets: SetEntry[]) => ({
  id,
  kind: "accessory" as const,
  exercises: [{ exerciseId, measure: "reps" as const, sets }],
});
const setsOf = (s: Session, blockId: string) => s.blocks.find((b) => b.id === blockId)!.exercises[0]!.sets;

describe("mergeSession", () => {
  const ancestor = sess([primary([set("a"), set("b"), set("c")]), accessory("x", 10, [set("x1"), set("x2")])]);

  it("keeps sets logged here and sets logged on the other device", () => {
    const local = sess([primary([logged("a"), set("b"), set("c")]), accessory("x", 10, [set("x1"), set("x2")])]);
    const server = sess([primary([set("a"), set("b"), set("c")]), accessory("x", 10, [logged("x1", 12, 50), set("x2")])]);
    const m = mergeSession(ancestor, local, server);
    expect(setsOf(m, "p").map((x) => x.done)).toEqual([true, false, false]);
    expect(setsOf(m, "x").map((x) => [x.done, x.reps])).toEqual([
      [true, 12],
      [false, null],
    ]);
  });

  it("a set edited here wins over the other device's edit of the same set", () => {
    const local = sess([primary([logged("a", 6), set("b"), set("c")]), accessory("x", 10, [set("x1"), set("x2")])]);
    const server = sess([primary([logged("a", 4), set("b"), set("c")]), accessory("x", 10, [set("x1"), set("x2")])]);
    expect(setsOf(mergeSession(ancestor, local, server), "p")[0]!.reps).toBe(6);
  });

  it("keeps sets and blocks only the server has, in place, and adds this device's", () => {
    const local = sess([primary([set("a"), set("b"), set("c"), set("d")]), accessory("x", 10, [set("x1"), set("x2")])]);
    const server = sess([
      primary([set("a"), set("b"), set("c")]),
      accessory("y", 11, [logged("y1")]),
      accessory("x", 10, [set("x1"), set("x2"), set("x3")]),
    ]);
    const m = mergeSession(ancestor, local, server);
    expect(m.blocks.map((b) => b.id)).toEqual(["p", "y", "x"]);
    expect(setsOf(m, "p").map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
    expect(setsOf(m, "x").map((x) => x.id)).toEqual(["x1", "x2", "x3"]);
  });

  it("removals: one device's removal stands unless the other changed the item", () => {
    // Removed here, untouched there → gone. Removed there, untouched here → gone.
    const local = sess([primary([set("a"), set("b")]), accessory("x", 10, [set("x1"), set("x2")])]);
    const server = sess([primary([set("a"), set("b"), set("c")]), accessory("x", 10, [set("x1")])]);
    const m = mergeSession(ancestor, local, server);
    expect(setsOf(m, "p").map((x) => x.id)).toEqual(["a", "b"]);
    expect(setsOf(m, "x").map((x) => x.id)).toEqual(["x1"]);
    // Removed there but logged here → kept.
    const loggedHere = sess([primary([set("a"), set("b"), set("c")]), accessory("x", 10, [set("x1"), logged("x2")])]);
    expect(setsOf(mergeSession(ancestor, loggedHere, server), "x").map((x) => x.id)).toEqual(["x1", "x2"]);
  });

  it("merges the session's own fields like settings (skip, finish, notes)", () => {
    const local = { ...ancestor, notes: "felt good", blocks: [{ ...ancestor.blocks[0]!, skipped: true }, ancestor.blocks[1]!] };
    const server = { ...ancestor, completedAt: "2026-11-02T19:00:00Z" };
    const m = mergeSession(ancestor, local, server);
    expect([m.notes, m.completedAt, m.blocks[0]!.skipped]).toEqual(["felt good", "2026-11-02T19:00:00Z", true]);
  });

  it("pairs up sessions built independently on two devices (no common ancestor)", () => {
    // Each device built today's session (fresh ids) and logged different sets.
    const local = sess([primary([logged("a1"), set("b1"), set("c1")], "p1"), accessory("x1", 10, [set("s1"), set("s2")])], {
      notes: "here",
    });
    const server = sess([primary([set("a2"), logged("b2"), set("c2")], "p2"), accessory("x2", 10, [logged("t1"), set("t2")])], {
      completedAt: "2026-11-02T19:00:00Z",
    });
    const m = mergeSession(null, local, server);
    expect(m.blocks.map((b) => b.id)).toEqual(["p1", "x1"]); // no duplicated main lift / accessory block
    expect(setsOf(m, "p1").map((x) => [x.id, x.done])).toEqual([
      ["a1", true],
      ["b1", true],
      ["c1", false],
    ]);
    expect(setsOf(m, "x1").map((x) => [x.id, x.done])).toEqual([
      ["s1", true],
      ["s2", false],
    ]);
    expect([m.notes, m.completedAt]).toEqual(["here", "2026-11-02T19:00:00Z"]);
  });
});

describe("mergeSession: a set logged vs a stale copy's targets, and measures", () => {
  const rows = (measure: "reps" | "seconds", sets: SetEntry[], id = "x") => ({
    id,
    kind: "accessory" as const,
    exercises: [{ exerciseId: 10, measure, sets }],
  });
  const ancestor = sess([rows("reps", [set("r1", { targetReps: 12 }), set("r2", { targetReps: 12 })])]);
  const exOf = (s: Session) => s.blocks.find((b) => b.id === "x")!.exercises;

  it("a set logged on either side beats a target-only edit of it on the other", () => {
    const retargeted = sess([rows("reps", [set("r1", { targetReps: 8 }), set("r2", { targetReps: 8 })])]);
    const loggedThere = sess([rows("reps", [logged("r1", 12, 50), set("r2", { targetReps: 12 })])]);
    expect(setsOf(mergeSession(ancestor, retargeted, loggedThere), "x").map((x) => [x.done, x.reps, x.targetReps])).toEqual([
      [true, 12, 5],
      [false, null, 8],
    ]);
    expect(setsOf(mergeSession(ancestor, loggedThere, retargeted), "x").map((x) => [x.done, x.reps])).toEqual([
      [true, 12],
      [false, null],
    ]);
  });

  it("H1: a stale device's measure rewrite never unlogs a set logged on the other device", () => {
    // Device B logged set 1 of Rows (reps); device A, not having seen it, saved Rows rewritten to seconds.
    const server = sess([rows("reps", [logged("r1", 12, 50), set("r2", { targetReps: 12 })])]);
    const local = sess([rows("seconds", [set("r1", { targetReps: 30 }), set("r2", { targetReps: 30 })])]);
    const [ex, ...rest] = exOf(mergeSession(ancestor, local, server));
    expect(rest).toEqual([]);
    expect(ex!.measure).toBe("reps");
    expect(ex!.sets.map((x) => [x.id, x.done, x.reps, x.targetReps])).toEqual([
      ["r1", true, 12, 5],
      ["r2", false, null, 12],
    ]);
  });

  it("H2: rep sets logged on a stale copy keep their measure over a measure rewrite on the server", () => {
    // A's rewrite (seconds, nothing logged) landed first; B, still in reps, logged 2×12 @ 50.
    const server = sess([rows("seconds", [set("r1", { targetReps: 30 }), set("r2", { targetReps: 30 })])]);
    const local = sess([rows("reps", [logged("r1", 12, 50), logged("r2", 12, 50)])]);
    const m = mergeSession(ancestor, local, server);
    const [ex] = exOf(m);
    expect(ex!.measure).toBe("reps");
    expect(ex!.sets.map((x) => [x.done, x.reps, x.weight])).toEqual([
      [true, 12, 50],
      [true, 12, 50],
    ]);
  });

  it("nothing logged on either side: the measure changed here wins, with this side's sets (never mixed)", () => {
    const server = sess([rows("reps", [set("r1", { targetReps: 10 }), set("r2", { targetReps: 12 })])]);
    const local = sess([rows("seconds", [set("r1", { targetReps: 45 }), set("r2", { targetReps: 30 })])]);
    const [ex] = exOf(mergeSession(ancestor, local, server));
    expect(ex!.measure).toBe("seconds");
    expect(ex!.sets.map((x) => x.targetReps)).toEqual([45, 30]);
  });

  it("logged in different measures on both sides: the server's stands, this device's sets are kept apart", () => {
    const server = sess([rows("reps", [logged("r1", 12, 50), set("r2", { targetReps: 12 })])]);
    const local = sess([rows("seconds", [logged("r1", 30, 50), set("r2", { targetReps: 30 })])]);
    const m = mergeSession(ancestor, local, server);
    const [kept, apart, ...rest] = exOf(m);
    expect(rest).toEqual([]);
    expect(kept!.measure).toBe("reps");
    expect(kept!.sets.map((x) => [x.done, x.reps])).toEqual([
      [true, 12],
      [false, null],
    ]);
    expect(apart!.measure).toBe("seconds");
    expect(apart!.sets.map((x) => [x.done, x.reps])).toEqual([[true, 30]]);
    // Still a valid document: no set id twice.
    const ids = m.blocks.flatMap((b) => b.exercises.flatMap((e) => e.sets.map((x) => x.id)));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("mergeSettings", () => {
  it("takes the keys this device changed (at any depth) and the server's for the rest", () => {
    const local = { ...settings, targets: { ...settings.targets, steps: 12_000 } };
    const server = {
      ...settings,
      targets: { ...settings.targets, zone2Minutes: 45 },
      onboarded: true,
      program: { ...settings.program, intensity: 0.85 },
    };
    const m = mergeSettings(settings, local, server);
    expect(m.targets).toEqual({ steps: 12_000, zone2Minutes: 45 });
    expect(m.onboarded).toBe(true);
    expect(m.program.intensity).toBe(0.85);
  });

  it("treats arrays as values and removes keys removed here", () => {
    const withGoal = { ...settings, weightGoal: { targetLb: 200, pacePctPerWeek: 0.5, setOn: "2026-11-01" } };
    const local = { ...withGoal, weightGoal: null, strengthTargets: [{ id: "t", exerciseId: 1, targetLb: 400, setOn: "2026-11-01" }] };
    const m = mergeSettings(withGoal, local, { ...withGoal, onboarded: true });
    expect(m.weightGoal).toBeNull();
    expect(m.strengthTargets).toHaveLength(1);
    expect(mergeFields({ a: 1, b: 2 }, { a: 1 } as { a: number; b?: number }, { a: 1, b: 3 })).toEqual({ a: 1 });
  });

  it("without an ancestor, this device's values win", () => {
    expect(mergeFields(null, { a: 1, b: 2 }, { a: 5, c: 3 } as { a: number; b?: number; c?: number })).toEqual({ a: 1, b: 2, c: 3 });
  });
});

describe("version-checked ops in the outbox", () => {
  const doc = (notes: string) => sess([primary([set("a")])], { notes });

  it("sends If-Match with the revision the edit was based on, If-None-Match for a new document, nothing when unknown", () => {
    const op: Op = { kind: "session", date: "2026-11-02", doc: doc("x"), baseRev: "41", base: doc("") };
    expect(request(op).headers).toEqual({ "If-Match": '"41"' });
    expect(request({ ...op, baseRev: null, base: null }).headers).toEqual({ "If-None-Match": "*" });
    expect(request({ kind: "session", date: "2026-11-02", doc: doc("x") }).headers).toBeUndefined();
    expect(request({ kind: "settings", settings, baseRev: "7", base: settings }).headers).toEqual({ "If-Match": '"7"' });
  });

  it("a coalesced edit keeps what the first unsent one was based on", () => {
    let s = addOp(emptyOutbox(), { kind: "session", date: "2026-11-02", doc: doc("a"), baseRev: "1", base: doc("") }, null);
    s = addOp(s, { kind: "session", date: "2026-11-02", doc: doc("b"), baseRev: "9", base: doc("zzz") }, null);
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]!.op).toMatchObject({ doc: { notes: "b" }, baseRev: "1", base: { notes: "" } });
  });

  it("an ack re-bases later edits of the same document on the new revision", () => {
    let s = addOp(emptyOutbox(), { kind: "session", date: "2026-11-02", doc: doc("a"), baseRev: "1", base: doc("") }, null);
    const first = s.entries[0]!.seq;
    // Queued while the first was in flight: based on the same (old) revision.
    s = addOp(s, { kind: "session", date: "2026-11-02", doc: doc("ab"), baseRev: "1", base: doc("") }, first);
    s = addOp(s, { kind: "session", date: "2026-11-03", doc: doc("other"), baseRev: "5", base: null }, first);
    s = ackEntry(s, first, doc("a"), { srev: "2" });
    expect(s.entries[0]).toMatchObject({ state: "acked", srev: "2" });
    expect(s.entries[1]!.op).toMatchObject({ doc: { notes: "ab" }, baseRev: "2", base: { notes: "a" } });
    expect(s.entries[2]!.op).toMatchObject({ baseRev: "5" }); // another date: untouched
  });

  it("when the server saved a merge, later edits are merged onto it too", () => {
    const mine = sess([primary([logged("a"), set("b")])]);
    let s = addOp(emptyOutbox(), { kind: "session", date: "2026-11-02", doc: mine, baseRev: "1", base: null }, null);
    const first = s.entries[0]!.seq;
    const later = sess([primary([logged("a"), logged("b")])]);
    s = addOp(s, { kind: "session", date: "2026-11-02", doc: later, baseRev: "1", base: null }, first);
    // The server's copy also has a set from another device.
    const saved = sess([primary([logged("a"), set("b"), logged("z")])]);
    s = ackEntry(s, first, saved, { srev: "3" });
    const op = s.entries[1]!.op as Extract<Op, { kind: "session" }>;
    expect(op.doc!.blocks[0]!.exercises[0]!.sets.map((x) => [x.id, x.done])).toEqual([
      ["a", true],
      ["b", true],
      ["z", true],
    ]);
    expect(op.baseRev).toBe("3");
  });
});

describe("mergeSession: exercises that move between blocks", () => {
  const ex = (exerciseId: number, sets: SetEntry[]) => ({ exerciseId, measure: "reps" as const, sets });
  const block = (id: string, ...exercises: ReturnType<typeof ex>[]) => ({ id, kind: "accessory" as const, exercises });
  const shape = (s: Session) =>
    s.blocks
      .map(
        (b) => `${b.id}[${b.exercises.map((e) => `${e.exerciseId}:${e.sets.map((x) => x.id + (x.done ? "*" : "")).join(",")}`).join("|")}]`,
      )
      .join(" ");
  const allSetIds = (s: Session) => s.blocks.flatMap((b) => b.exercises.flatMap((e) => e.sets.map((x) => x.id)));
  const unique = (s: Session) => expect(new Set(allSetIds(s)).size).toBe(allSetIds(s).length);

  // A superset of exercises 10 and 11.
  const anc = sess([block("X", ex(10, [set("a1"), set("a2")]), ex(11, [set("b1"), set("b2")]))]);
  const split = sess([block("X", ex(11, [set("b1"), set("b2")])), block("Y", ex(10, [set("a1"), set("a2")]))]);
  const loggedB = sess([block("X", ex(10, [set("a1"), set("a2")]), ex(11, [logged("b1"), set("b2")]))]);
  const loggedA = sess([block("X", ex(10, [logged("a1"), set("a2")]), ex(11, [set("b1"), set("b2")]))]);

  it("split out of a superset here while the other device logged the one that stayed", () => {
    const m = mergeSession(anc, split, loggedB);
    expect(shape(m)).toBe("X[11:b1*,b2] Y[10:a1,a2]");
    unique(m);
  });

  it("split out of a superset here while the other device logged the one that moved", () => {
    const m = mergeSession(anc, split, loggedA);
    expect(shape(m)).toBe("X[11:b1,b2] Y[10:a1*,a2]");
    unique(m);
  });

  it("split on the other device while this one logged", () => {
    expect(shape(mergeSession(anc, loggedB, split))).toBe("X[11:b1*,b2] Y[10:a1,a2]");
    expect(shape(mergeSession(anc, loggedA, split))).toBe("X[11:b1,b2] Y[10:a1*,a2]");
  });

  it("removed from a superset here while the other device logged the other exercise", () => {
    const removedA = sess([block("X", ex(11, [set("b1"), set("b2")]))]);
    expect(shape(mergeSession(anc, removedA, loggedB))).toBe("X[11:b1*,b2]");
    // …and logged on the removed one there: kept (a removal never beats logged work).
    expect(shape(mergeSession(anc, removedA, loggedA))).toBe("X[10:a1*,a2|11:b1,b2]");
  });

  it("joined into a superset here while the other device logged", () => {
    const two = sess([block("X", ex(10, [set("a1")])), block("Y", ex(11, [set("b1")]))]);
    const joined = sess([block("X", ex(10, [set("a1")]), ex(11, [set("b1")]))]);
    const theirs = sess([block("X", ex(10, [set("a1")])), block("Y", ex(11, [logged("b1")]))]);
    const m = mergeSession(two, joined, theirs);
    expect(shape(m)).toBe("X[10:a1|11:b1*]");
  });

  describe("reorders and moves (superset management) vs logging on the other device", () => {
    // Superset X of 10 and 11, then single blocks Y (12) and Z (13).
    const start = sess([
      block("X", ex(10, [set("a1"), set("a2")]), ex(11, [set("b1"), set("b2")])),
      block("Y", ex(12, [set("c1")])),
      block("Z", ex(13, [set("d1")])),
    ]);
    const logOn = (s: Session, id: string): Session => ({
      ...s,
      blocks: s.blocks.map((b) => ({
        ...b,
        exercises: b.exercises.map((e) => ({ ...e, sets: e.sets.map((x) => (x.id === id ? logged(id) : x)) })),
      })),
    });
    const swapped = sess([
      block("X", ex(11, [set("b1"), set("b2")]), ex(10, [set("a1"), set("a2")])),
      block("Y", ex(12, [set("c1")])),
      block("Z", ex(13, [set("d1")])),
    ]);

    it("a superset reordered here while the other device logged: this order, their sets", () => {
      const m = mergeSession(start, swapped, logOn(start, "a1"));
      expect(shape(m)).toBe("X[11:b1,b2|10:a1*,a2] Y[12:c1] Z[13:d1]");
      unique(m);
    });

    it("…reordered on the other device while this one logged: their order is kept, with this device's sets", () => {
      const m = mergeSession(start, logOn(start, "a1"), swapped);
      expect(shape(m)).toBe("X[11:b1,b2|10:a1*,a2] Y[12:c1] Z[13:d1]");
      unique(m);
    });

    it("the workout's blocks reordered on either device while the other logged", () => {
      const moved = sess([start.blocks[2]!, start.blocks[0]!, start.blocks[1]!]);
      expect(shape(mergeSession(start, moved, logOn(start, "c1")))).toBe("Z[13:d1] X[10:a1,a2|11:b1,b2] Y[12:c1*]");
      expect(shape(mergeSession(start, logOn(start, "c1"), moved))).toBe("Z[13:d1] X[10:a1,a2|11:b1,b2] Y[12:c1*]");
    });

    it("blocks reordered on one device, a block added at the end on the other: the new block stays last", () => {
      const moved = moveBlock(start, "Z", 0);
      const added = sess([...start.blocks, block("W", ex(14, [set("w1")]))]);
      expect(shape(mergeSession(start, added, moved))).toBe("Z[13:d1] X[10:a1,a2|11:b1,b2] Y[12:c1] W[14:w1]");
      expect(shape(mergeSession(start, moved, added))).toBe("Z[13:d1] X[10:a1,a2|11:b1,b2] Y[12:c1] W[14:w1]");
      // Added in the middle: it follows the block before it.
      const mid = sess([start.blocks[0]!, block("W", ex(14, [set("w1")])), start.blocks[1]!, start.blocks[2]!]);
      expect(shape(mergeSession(start, mid, moved))).toBe("Z[13:d1] X[10:a1,a2|11:b1,b2] W[14:w1] Y[12:c1]");
    });

    it("reordered on both devices: this device's order wins; nothing is lost or doubled", () => {
      const other = sess([start.blocks[1]!, start.blocks[0]!, start.blocks[2]!]);
      const mine = sess([start.blocks[2]!, start.blocks[1]!, start.blocks[0]!]);
      const m = mergeSession(start, mine, logOn(other, "d1"));
      expect(shape(m)).toBe("Z[13:d1*] Y[12:c1] X[10:a1,a2|11:b1,b2]");
      unique(m);
    });

    it("an exercise moved from its own block into the superset here while the other device logged it", () => {
      // Y's 12 joins X as A3; Y disappears.
      const joined = sess([
        block("X", ex(10, [set("a1"), set("a2")]), ex(11, [set("b1"), set("b2")]), ex(12, [set("c1")])),
        block("Z", ex(13, [set("d1")])),
      ]);
      expect(shape(mergeSession(start, joined, logOn(start, "c1")))).toBe("X[10:a1,a2|11:b1,b2|12:c1*] Z[13:d1]");
      // …and the other way round: moved on the other device while this one logged it.
      expect(shape(mergeSession(start, logOn(start, "c1"), joined))).toBe("X[10:a1,a2|11:b1,b2|12:c1*] Z[13:d1]");
    });

    it("an exercise moved out of the superset into another block while the other device logged a round", () => {
      // 11 leaves X for Z (Z becomes a superset); the other device logged a1 and b1.
      const moved = sess([
        block("X", ex(10, [set("a1"), set("a2")])),
        block("Y", ex(12, [set("c1")])),
        block("Z", ex(13, [set("d1")]), ex(11, [set("b1"), set("b2")])),
      ]);
      const round = logOn(logOn(start, "a1"), "b1");
      for (const m of [mergeSession(start, moved, round), mergeSession(start, round, moved)]) {
        expect(shape(m)).toBe("X[10:a1*,a2] Y[12:c1] Z[13:d1|11:b1*,b2]");
        unique(m);
      }
    });

    it("moved into a superset here, reordered there: one copy of each exercise, every logged set", () => {
      const joined = sess([
        block("X", ex(10, [set("a1"), set("a2")]), ex(11, [set("b1"), set("b2")]), ex(12, [set("c1")])),
        block("Z", ex(13, [set("d1")])),
      ]);
      const m = mergeSession(start, logOn(joined, "c1"), logOn(swapped, "b2"));
      expect(shape(m)).toBe("X[11:b1,b2*|10:a1,a2|12:c1*] Z[13:d1]");
      unique(m);
    });
  });

  describe("exercises with no sets (identified across the workout, not by their block)", () => {
    const skip = (s: Session, exerciseId: number): Session => ({
      ...s,
      blocks: s.blocks.map((b) => ({
        ...b,
        exercises: b.exercises.map((e) => (e.exerciseId === exerciseId ? { ...e, skipped: true } : e)),
      })),
    });
    const shapeS = (s: Session) =>
      s.blocks
        .map(
          (b) =>
            `${b.id}[${b.exercises.map((e) => `${e.exerciseId}${e.skipped ? "S" : ""}:${e.sets.map((x) => x.id + (x.done ? "*" : "")).join(",")}`).join("|")}]`,
        )
        .join(" ");
    // X: a superset of 10 and a set-less 11; Y: 12.
    const a = sess([block("X", ex(10, [set("a1")]), ex(11, [])), block("Y", ex(12, [set("c1")]))]);
    const moved = moveExerciseToBlock(a, { blockId: "X", exIdx: 1 }, "Y");

    it("moved into another block here, skipped there: one copy, moved and skipped", () => {
      expect(shapeS(mergeSession(a, moved, skip(a, 11)))).toBe("X[10:a1] Y[12:c1|11S:]");
      expect(shapeS(mergeSession(a, skip(a, 11), moved))).toBe("X[10:a1] Y[12:c1|11S:]");
    });

    it("an exercise with no sets in a concurrent log merge is kept exactly once", () => {
      // The other device added a set to it and logged it.
      const loggedThere = sess([block("X", ex(10, [set("a1")]), ex(11, [logged("n1")])), block("Y", ex(12, [set("c1")]))]);
      expect(shapeS(mergeSession(a, moved, loggedThere))).toBe("X[10:a1] Y[12:c1|11:n1*]");
      expect(shapeS(mergeSession(a, loggedThere, moved))).toBe("X[10:a1] Y[12:c1|11:n1*]");
      // …and logged elsewhere while this device moved it.
      expect(shapeS(mergeSession(a, moved, sess([block("X", ex(10, [logged("a1")]), ex(11, [])), block("Y", ex(12, [set("c1")]))])))).toBe(
        "X[10:a1*] Y[12:c1|11:]",
      );
    });

    it("moved into different supersets on the two devices: this device's place, once", () => {
      const three = sess([block("X", ex(10, [set("a1")]), ex(11, [])), block("Y", ex(12, [set("c1")])), block("Z", ex(13, [set("d1")]))]);
      const here = moveExerciseToBlock(three, { blockId: "X", exIdx: 1 }, "Y");
      const there = moveExerciseToBlock(three, { blockId: "X", exIdx: 1 }, "Z");
      expect(shapeS(mergeSession(three, here, there))).toBe("X[10:a1] Y[12:c1|11:] Z[13:d1]");
    });

    it("split out here, skipped there: one copy, in its own block, skipped", () => {
      const split = splitOut(a, { blockId: "X", exIdx: 1 }, "N");
      expect(shapeS(mergeSession(a, split, skip(a, 11)))).toBe("X[10:a1] N[11S:] Y[12:c1]");
      expect(shapeS(mergeSession(a, skip(a, 11), split))).toBe("X[10:a1] N[11S:] Y[12:c1]");
    });

    it("the same exercise twice on purpose (both without sets) keeps both", () => {
      const twice = sess([block("X", ex(10, [set("a1")]), ex(11, [])), block("Y", ex(12, [set("c1")]), ex(11, []))]);
      const reordered = moveBlock(twice, "Y", 0);
      for (const m of [mergeSession(twice, reordered, skip(twice, 10)), mergeSession(twice, skip(twice, 10), reordered)])
        expect(shapeS(m)).toBe("Y[12:c1|11:] X[10S:a1|11:]");
      // Added on both devices to different blocks: both kept.
      const addX = sess([block("X", ex(10, [set("a1")]), ex(11, []), ex(14, [])), block("Y", ex(12, [set("c1")]))]);
      const addY = sess([block("X", ex(10, [set("a1")]), ex(11, [])), block("Y", ex(12, [set("c1")]), ex(14, []))]);
      expect(shapeS(mergeSession(a, addX, addY))).toBe("X[10:a1|11:|14:] Y[12:c1|14:]");
      // A second one added here while the other device moved the first: both kept, once each.
      expect(shapeS(mergeSession(a, sess([...a.blocks, block("W", ex(11, []))]), moved))).toBe("X[10:a1] Y[12:c1|11:] W[11:]");
    });
  });

  it("an exercise swapped for another lift (same sets) isn't duplicated", () => {
    const swapped = sess([block("X", ex(12, [set("a1"), set("a2")]), ex(11, [set("b1"), set("b2")]))]);
    const m = mergeSession(anc, swapped, loggedA);
    expect(shape(m)).toBe("X[12:a1*,a2|11:b1,b2]");
  });

  it("never repeats a set id, even from inconsistent copies", () => {
    // The server copy holds b1 twice (e.g. written by an older build).
    const bad = sess([
      block("X", ex(10, [set("a1"), set("a2")]), ex(11, [set("b1"), set("b2")])),
      block("Z", ex(11, [logged("b1"), set("b2")])),
    ]);
    unique(mergeSession(anc, loggedA, bad));
    unique(mergeSession(null, loggedA, bad));
  });

  it("random edits on both devices never produce a repeated set id or an empty block", () => {
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    const mutateDoc = (s: Session, tag: string): Session => {
      let blocks = s.blocks.map((b) => ({ ...b, exercises: b.exercises.map((e) => ({ ...e, sets: [...e.sets] })) }));
      for (let k = 0; k < 4; k++) {
        const b = blocks[rnd(blocks.length)]!;
        const e = b.exercises[rnd(b.exercises.length)]!;
        switch (rnd(9)) {
          case 8: // skip it (or not)
            b.exercises[b.exercises.indexOf(e)] = { ...e, skipped: !e.skipped };
            break;
          case 0: // log a set
            if (e.sets.length) e.sets[rnd(e.sets.length)] = { ...e.sets[0]!, id: e.sets[rnd(e.sets.length)]!.id, done: true, reps: 5 };
            break;
          case 1: // add a set
            e.sets.push(set(`${tag}${k}`));
            break;
          case 2: // split the last exercise out of a superset
            if (b.exercises.length > 1) {
              const moved = b.exercises.pop()!;
              blocks.push({ id: `${tag}B${k}`, kind: "accessory", exercises: [moved] });
            }
            break;
          case 3: // join the next block into this one
            {
              const i = blocks.indexOf(b);
              const next = blocks[i + 1];
              if (next && next.kind === "accessory" && b.exercises.length + next.exercises.length <= 6) {
                b.exercises.push(...next.exercises);
                blocks = blocks.filter((x) => x !== next);
              }
            }
            break;
          case 4: // remove an exercise
            if (b.exercises.length > 1) b.exercises.splice(rnd(b.exercises.length), 1);
            break;
          case 5: // reorder within the block
            if (b.exercises.length > 1) b.exercises.unshift(b.exercises.splice(rnd(b.exercises.length), 1)[0]!);
            break;
          case 6: // move the block
            {
              blocks = blocks.filter((x) => x !== b);
              blocks.splice(rnd(blocks.length + 1), 0, b);
            }
            break;
          case 7: // move an exercise into another block
            {
              const dest = blocks[rnd(blocks.length)]!;
              if (dest !== b && dest.exercises.length < 6) {
                dest.exercises.push(b.exercises.splice(b.exercises.indexOf(e), 1)[0]!);
                if (!b.exercises.length) blocks = blocks.filter((x) => x !== b);
              }
            }
            break;
        }
      }
      return { ...s, blocks };
    };
    // 15–17 have no sets (yet): identified by lift and occurrence, not by sets.
    const start = sess([
      block("X", ex(10, [set("a1"), set("a2")]), ex(11, [set("b1"), set("b2")]), ex(12, [set("c1")]), ex(15, [])),
      block("Y", ex(13, [set("d1"), set("d2")]), ex(16, [])),
      block("Z", ex(14, [set("e1")])),
      block("W", ex(17, [])),
    ]);
    const count = (s: Session, exerciseId: number) =>
      s.blocks.flatMap((b) => b.exercises).filter((e) => e.exerciseId === exerciseId).length;
    for (let i = 0; i < 300; i++) {
      const l = mutateDoc(start, `l${i}-`);
      const s = mutateDoc(start, `s${i}-`);
      const m = mergeSession(start, l, s);
      unique(m);
      expect(m.blocks.every((b) => b.exercises.length > 0)).toBe(true);
      // Every exercise appears at most once — exactly once when both devices still have it.
      for (const id of [10, 11, 12, 13, 14, 15, 16, 17]) {
        expect(count(m, id), `exercise ${id}, round ${i}`).toBeLessThanOrEqual(1);
        if (count(l, id) && count(s, id)) expect(count(m, id), `exercise ${id}, round ${i}`).toBe(1);
      }
      // Every set on both devices (and every set logged on either) is still there, once.
      const both = new Set(allSetIds(l).filter((id) => allSetIds(s).includes(id)));
      for (const id of both) expect(allSetIds(m).filter((x) => x === id)).toHaveLength(1);
      const loggedIds = [...l.blocks, ...s.blocks].flatMap((b) =>
        b.exercises.flatMap((e) => e.sets.filter((x) => x.done).map((x) => x.id)),
      );
      const mergedIds = new Set(allSetIds(m));
      for (const id of loggedIds) expect(mergedIds.has(id)).toBe(true);
    }
  });
});

describe("mergeSession: one main lift", () => {
  const main = (id: string, exerciseId: number, sets: SetEntry[]) => ({
    id,
    kind: "primary" as const,
    exercises: [{ exerciseId, measure: "reps" as const, sets }],
  });
  const anc = sess([main("P", 1, [set("p1"), set("p2")])], { planSig: "old" });

  it("a session rebuilt on the other device (new plan, other lift): its main lift stays, work logged here becomes an accessory", () => {
    const local = sess([main("P", 1, [logged("p1"), set("p2")])], { planSig: "old" });
    const server = sess([main("Q", 2, [set("q1"), set("q2")])], { planSig: "new" });
    const m = mergeSession(anc, local, server);
    expect(m.planSig).toBe("new");
    expect(m.blocks.map((b) => [b.id, b.kind])).toEqual([
      ["Q", "primary"],
      ["P", "accessory"],
    ]);
  });

  it("…the same lift: the logged sets are folded into the new plan's sets", () => {
    const local = sess([main("P", 1, [logged("p1", 5, 225), set("p2")])], { planSig: "old" });
    const server = sess([main("Q", 1, [set("q1", { targetWeight: 230 }), set("q2", { targetWeight: 230 })])], { planSig: "new" });
    const m = mergeSession(anc, local, server);
    expect(m.blocks).toHaveLength(1);
    expect(m.blocks[0]!.id).toBe("Q");
    expect(m.blocks[0]!.exercises[0]!.sets.map((x) => [x.id, x.done, x.weight, x.targetWeight])).toEqual([
      ["q1", true, 225, 230],
      ["q2", false, null, 230],
    ]);
  });

  it("…nothing logged on the old plan: it's simply replaced", () => {
    const local = sess([main("P", 1, [set("p1"), set("p2")])], { planSig: "old", notes: "x" });
    const server = sess([main("Q", 2, [set("q1")])], { planSig: "new" });
    expect(mergeSession(anc, local, server).blocks.map((b) => b.id)).toEqual(["Q"]);
  });

  it("rebuilt here while the other device logged on the old plan: this device's plan wins", () => {
    const local = sess([main("R", 3, [set("r1")])], { planSig: "mine", plannedFor: "2026-11-01" });
    const server = sess([main("P", 1, [logged("p1"), set("p2")])], { planSig: "old" });
    const m = mergeSession(anc, local, server);
    expect(m.plannedFor).toBe("2026-11-01");
    expect(m.blocks.map((b) => [b.id, b.kind])).toEqual([
      ["R", "primary"],
      ["P", "accessory"],
    ]);
  });
});

describe("mergeSettings: lists", () => {
  const target = (id: string, exerciseId: number, targetLb: number) => ({ id, exerciseId, targetLb, setOn: "2026-11-02" });
  const base = { ...settings, strengthTargets: [target("t1", 1, 300)] };

  it("strength targets merge by id: added, removed and edited on either device", () => {
    const local = { ...base, strengthTargets: [target("t1", 1, 315), target("t-here", 2, 500)] };
    const server = { ...base, strengthTargets: [target("t1", 1, 300), target("t-there", 3, 400)] };
    const m = mergeSettingsDetailed(base, local, server);
    expect(m.value.strengthTargets.map((t) => [t.id, t.targetLb])).toEqual([
      ["t1", 315],
      ["t-there", 400],
      ["t-here", 500],
    ]);
    expect(m.conflicts).toEqual([]);
    // Removed here, untouched there → gone.
    expect(mergeSettings(base, { ...base, strengthTargets: [] }, server).strengthTargets.map((t) => t.id)).toEqual(["t-there"]);
  });

  it("the weekly schedule merges day by day", () => {
    const flip = (xs: boolean[], i: number) => xs.map((v, n) => (n === i ? !v : v));
    const local = { ...base, schedule: { ...base.schedule, metcon: flip(base.schedule.metcon, 1) } };
    const server = { ...base, schedule: { ...base.schedule, metcon: flip(base.schedule.metcon, 3), zone2: flip(base.schedule.zone2, 0) } };
    const m = mergeSettings(base, local, server);
    expect(m.schedule.metcon).toEqual(flip(flip(base.schedule.metcon, 1), 3));
    expect(m.schedule.zone2).toEqual(flip(base.schedule.zone2, 0));
  });

  it("program weeks merge week by week; a change both can't combine keeps this device's and is reported", () => {
    const weeks = base.program.weeks;
    const local = { ...base, program: { ...base.program, weeks: weeks.map((w, i) => (i === 0 ? { ...w, label: "Heavy" } : w)) } };
    const server = { ...base, program: { ...base.program, weeks: weeks.map((w, i) => (i === 2 ? { ...w, reps: [1, 2, 3] } : w)) } };
    const m = mergeSettingsDetailed(base, local, server);
    expect(m.value.program.weeks[0]!.label).toBe("Heavy");
    expect(m.value.program.weeks[2]!.reps).toEqual([1, 2, 3]);
    expect(m.conflicts).toEqual([]);

    // Both edited the same week's reps differently: this device's, reported.
    const l2 = { ...base, program: { ...base.program, weeks: weeks.map((w, i) => (i === 1 ? { ...w, reps: [9] } : w)) } };
    const s2 = { ...base, program: { ...base.program, weeks: weeks.map((w, i) => (i === 1 ? { ...w, reps: [7, 7] } : w)) } };
    const m2 = mergeSettingsDetailed(base, l2, s2);
    expect(m2.value.program.weeks[1]!.reps).toEqual([9]);
    expect(m2.conflicts).toEqual(["program weeks"]);

    // A week added here, one edited there: lengths differ, so this device's list stands (reported).
    const l3 = { ...base, program: { ...base.program, weeks: [...weeks, { ...weeks[0]!, label: "Extra" }] } };
    const m3 = mergeSettingsDetailed(base, l3, server);
    expect(m3.value.program.weeks).toHaveLength(weeks.length + 1);
    expect(m3.conflicts).toEqual(["program weeks"]);
  });
});

describe("fitSession", () => {
  const many = (prefix: string, n: number, done: boolean) =>
    Array.from({ length: n }, (_, i) => set(`${prefix}${i}`, done ? { done: true, reps: 5 } : {}));

  it("drops unlogged sets past 30, keeping every logged one", () => {
    const doc = sess([accessory("x", 10, [...many("d", 20, true), ...many("o", 15, false)])]);
    const { doc: fit, error } = fitSession(doc);
    expect(error).toBeNull();
    expect(setsOf(fit, "x")).toHaveLength(30);
    expect(setsOf(fit, "x").filter((x) => x.done)).toHaveLength(20);
  });

  it("a superset over 6 keeps its first 6 and moves the rest into a block right after it (nothing dropped)", () => {
    const exs = Array.from({ length: 8 }, (_, i) => ({
      exerciseId: 20 + i,
      measure: "reps" as const,
      sets: [set(`s${i}`, i < 7 ? { done: true } : {})],
    }));
    const { doc, error, notices } = fitSession(sess([{ id: "big", kind: "accessory", exercises: exs }, accessory("z", 9, [set("z1")])]));
    expect(error).toBeNull();
    expect(notices).toEqual([]);
    expect(doc.blocks.map((b) => [b.id, b.exercises.map((x) => x.exerciseId)])).toEqual([
      ["big", [20, 21, 22, 23, 24, 25]],
      ["big-2", [26, 27]],
      ["z", [9]],
    ]);
  });

  it("…logged members stay in the superset; the ones moved out are unlogged where possible", () => {
    const exs = Array.from({ length: 7 }, (_, i) => ({
      exerciseId: 20 + i,
      measure: "reps" as const,
      sets: [set(`s${i}`, i === 6 ? { done: true } : {})],
    }));
    const { doc } = fitSession(sess([{ id: "big", kind: "accessory", exercises: exs }]));
    expect(doc.blocks.map((b) => b.exercises.map((x) => x.exerciseId))).toEqual([[20, 21, 22, 23, 24, 26], [25]]);
  });

  it("two devices each moving an exercise into a superset of 5: the one that doesn't fit gets a block after it", () => {
    const ex = (exerciseId: number, sets: SetEntry[]) => ({ exerciseId, measure: "reps" as const, sets });
    const five = [10, 11, 12, 13, 14].map((n) => ex(n, [set(`s${n}`)]));
    const anc = sess([
      primary([set("p1")]),
      { id: "S", kind: "accessory", exercises: five },
      accessory("X", 20, [set("x1"), set("x2")]),
      accessory("Q", 30, [set("q1")]),
    ]);
    const here = moveExerciseToBlock(anc, { blockId: "X", exIdx: 0 }, "S");
    const there = moveExerciseToBlock(anc, { blockId: "Q", exIdx: 0 }, "S");
    for (const [l, s] of [
      [here, there],
      [there, here],
    ] as const) {
      const { doc, error, notices } = fitSession(mergeSession(anc, l, s));
      expect(error).toBeNull();
      expect(notices).toEqual([]);
      expect(doc.blocks.map((b) => b.id)).toEqual(["p", "S", "S-2"]);
      const [s1, s2] = [doc.blocks[1]!.exercises.map((x) => x.exerciseId), doc.blocks[2]!.exercises.map((x) => x.exerciseId)];
      expect(s1.slice(0, 5)).toEqual([10, 11, 12, 13, 14]);
      expect([s1[5], ...s2].sort()).toEqual([20, 30]);
      expect(s2).toHaveLength(1);
      expect(doc.blocks[1]!.exercises.find((x) => x.exerciseId === 20)?.sets ?? doc.blocks[2]!.exercises[0]!.sets).toHaveLength(2);
    }
  });

  it("no room for another block (30): unlogged members that don't fit are dropped, and the merge says so", () => {
    const ex = (exerciseId: number, sets: SetEntry[]) => ({ exerciseId, measure: "reps" as const, sets });
    const big = { id: "big", kind: "accessory" as const, exercises: Array.from({ length: 8 }, (_, i) => ex(20 + i, [set(`s${i}`)])) };
    const rest = Array.from({ length: MAX_BLOCKS - 1 }, (_, i) => accessory(`b${i}`, 100 + i, [set(`r${i}`)]));
    const { doc, error, notices } = fitSession(sess([big, ...rest]));
    expect(error).toBeNull();
    expect(doc.blocks).toHaveLength(MAX_BLOCKS);
    expect(doc.blocks[0]!.exercises.map((x) => x.exerciseId)).toEqual([20, 21, 22, 23, 24, 25]);
    expect(doc.blocks.slice(1).map((b) => b.id)).toEqual(rest.map((b) => b.id));
    expect(notices).toEqual(["2 unlogged exercises were left out (a workout holds at most 30 blocks)"]);
    // Logged members that can't fit anywhere: the merge fails with the reason.
    const loggedBig = { ...big, exercises: big.exercises.map((x) => ({ ...x, sets: [logged(x.sets[0]!.id)] })) };
    const loggedRest = rest.map((b) => ({ ...b, exercises: [{ ...b.exercises[0]!, sets: [logged(b.exercises[0]!.sets[0]!.id)] }] }));
    expect(fitSession(sess([loggedBig, ...loggedRest])).error).toMatch(/more than 30 blocks/);
  });

  it("a main-lift block holding more than one exercise keeps its first; the others move to an accessory block after it", () => {
    const ex = (exerciseId: number, sets: SetEntry[]) => ({ exerciseId, measure: "reps" as const, sets });
    const doc = sess([
      { id: "p", kind: "primary", exercises: [ex(1, [logged("p1")]), ex(2, [set("q1")]), ex(3, [])] },
      accessory("x", 10, [set("x1")]),
    ]);
    const { doc: fit } = fitSession(doc);
    expect(fit.blocks.map((b) => [b.id, b.kind, b.exercises.map((x) => x.exerciseId)])).toEqual([
      ["p", "primary", [1]],
      ["p-2", "accessory", [2, 3]],
      ["x", "accessory", [10]],
    ]);
  });

  it("says why when only logged work is over the limit", () => {
    const { error } = fitSession(sess([accessory("x", 10, many("d", 31, true))]));
    expect(error).toMatch(/more than 30 logged sets/);
  });

  it("returns the same document when it fits", () => {
    const doc = sess([primary([set("a")])]);
    expect(fitSession(doc).doc).toBe(doc);
    expect(fitSession(doc).notices).toEqual([]);
  });

  it("reports the unlogged work it trims", () => {
    const many = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => set(`${prefix}${i}`));
    expect(fitSession(sess([accessory("x", 10, many("o", 32))])).notices).toEqual([
      "2 unlogged sets were left out (an exercise holds at most 30 sets)",
    ]);
    const blocks = Array.from({ length: MAX_BLOCKS + 1 }, (_, i) => accessory(`b${i}`, 100 + i, [set(`r${i}`)]));
    expect(fitSession(sess(blocks)).notices).toEqual(["1 unlogged block was left out (a workout holds at most 30 blocks)"]);
  });
});

describe("version-checked ops: deletes, rejected copies and conflicts", () => {
  const D = "2026-11-02";
  const doc = (notes: string, sets = [set("a"), set("b")]) => sess([primary(sets)], { notes });
  const sessionOp = (d: Session | null, baseRev?: string | null, base?: Session | null): Op =>
    baseRev === undefined ? { kind: "session", date: D, doc: d } : { kind: "session", date: D, doc: d, baseRev, base: base ?? null };
  const opOf = (s: { entries: { op: Op }[] }, i: number) => s.entries[i]!.op as Extract<Op, { kind: "session" }>;
  const doneOf = (d: Session | null | undefined) => d!.blocks[0]!.exercises[0]!.sets.map((x) => x.done);
  const resolve = (...args: Parameters<typeof resolveConflict>) => {
    const r = resolveConflict(...args);
    if (r.kind === "none") throw new Error("not resolved");
    return r;
  };

  it("a workout delete carries If-Match", () => {
    expect(request(sessionOp(null, "r4", doc(""))).headers).toEqual({ "If-Match": '"r4"' });
    expect(request(sessionOp(null)).headers).toBeUndefined(); // a copy without revisions: unchecked, as before
  });

  it("creating then deleting a workout offline sends nothing (and never a bare DELETE)", () => {
    let s = addOp(emptyOutbox(), sessionOp(doc("draft"), null), null);
    s = addOp(s, sessionOp(null, null), null);
    expect(s.entries).toEqual([]);
    // Deleting what the server never had, with nothing queued: nothing either.
    expect(addOp(emptyOutbox(), sessionOp(null, null), null).entries).toEqual([]);
    expect(isNoopDelete(sessionOp(null, null))).toBe(true);
  });

  it("a delete queued behind the create in flight stays, and is sent If-Match the created revision", () => {
    let s = addOp(emptyOutbox(), sessionOp(doc("draft"), null), null);
    const create = s.entries[0]!.seq;
    s = addOp(s, sessionOp(null, null), create);
    expect(s.entries).toHaveLength(2);
    s = ackEntry(s, create, doc("draft"), { srev: "r1" });
    expect(request(opOf(s, 1)).headers).toEqual({ "If-Match": '"r1"' });
  });

  it("delete → Undo coalesces into the restoring save, checked against the revision the delete knew", () => {
    let s = addOp(emptyOutbox(), sessionOp(null, "r1", doc("orig")), null);
    s = addOp(s, sessionOp(doc("orig"), "r1", doc("orig")), null);
    expect(s.entries).toHaveLength(1);
    expect(request(opOf(s, 0))).toMatchObject({ method: "PUT", headers: { "If-Match": '"r1"' } });
    // A delete queued by an older build (no revision): the restoring save keeps its own.
    let old = addOp(emptyOutbox(), sessionOp(null), null);
    old = addOp(old, sessionOp(doc("orig"), "r1", doc("orig")), null);
    expect(request(opOf(old, 0)).headers).toEqual({ "If-Match": '"r1"' });
  });

  it("a document replacing a rejected one is based on what the rejected one was (the copy on screen)", () => {
    let s = addOp(emptyOutbox(), sessionOp(doc("mine"), "r1", doc("")), null);
    s = resolve(s, s.entries[0]!.seq, { current: doc("theirs"), rev: "r9" }, false).state as typeof s;
    expect(s.entries[0]).toMatchObject({ state: "failed", op: { baseRev: "r9" } });
    s = addOp(s, sessionOp(doc("mine, edited"), "r1", doc("")), null);
    expect(s.entries).toHaveLength(1);
    expect(opOf(s, 0)).toMatchObject({ baseRev: "r9", base: { notes: "theirs" }, doc: { notes: "mine, edited" } });
  });

  it("a conflict merges the later queued edits of the document too (made on the pre-merge copy)", () => {
    const anc = doc("");
    let s = addOp(emptyOutbox(), sessionOp(doc("", [logged("a"), set("b")]), "r1", anc), null);
    const first = s.entries[0]!.seq;
    // Made while the first was in flight: on top of it.
    s = addOp(s, sessionOp(doc("felt good", [logged("a"), set("b")]), "r1", anc), first);
    const theirs = doc("", [set("a"), logged("b")]);
    const r = resolve(s, first, { current: theirs, rev: "r7" }, true);
    expect(r).toMatchObject({ kind: "retry", tookServer: true });
    s = r.state;
    expect(doneOf(opOf(s, 0).doc)).toEqual([true, true]);
    expect(opOf(s, 1)).toMatchObject({ baseRev: "r7", doc: { notes: "felt good" } });
    expect(doneOf(opOf(s, 1).doc)).toEqual([true, true]);
    // The merged save lands; the later edit then goes out at its revision, keeping both.
    s = ackEntry(s, first, opOf(s, 0).doc, { srev: "r8" });
    expect(opOf(s, 1).baseRev).toBe("r8");
    expect(doneOf(opOf(s, 1).doc)).toEqual([true, true]);
  });

  it("a second conflict: merged again and kept, marked failed — or carried by a later queued edit", () => {
    const anc = doc("");
    let s = addOp(emptyOutbox(), sessionOp(doc("", [logged("a"), set("b")]), "r1", anc), null);
    const first = s.entries[0]!.seq;
    let r = resolve(s, first, { current: doc("", [set("a"), logged("b", 8)]), rev: "r7" }, true);
    r = resolve(r.state, first, { current: doc("", [set("a"), logged("b", 10)]), rev: "r9" }, false);
    expect(r.kind).toBe("failed");
    const failed = r.state.entries[0]!;
    expect(failed.state).toBe("failed");
    expect((failed.op as Extract<Op, { kind: "session" }>).doc!.blocks[0]!.exercises[0]!.sets.map((x) => [x.done, x.reps])).toEqual([
      [true, 5],
      [true, 10], // the newest server value, not the one the first merge saw
    ]);
    expect(failed.op).toMatchObject({ baseRev: "r9" });

    // With a later queued edit of the same workout, that edit carries it instead.
    s = addOp(emptyOutbox(), sessionOp(doc("", [logged("a"), set("b")]), "r1", anc), null);
    s = addOp(s, sessionOp(doc("later", [logged("a"), set("b")]), "r1", anc), s.entries[0]!.seq);
    r = resolve(s, s.entries[0]!.seq, { current: doc("", [set("a"), logged("b")]), rev: "r9" }, false);
    expect(r).toMatchObject({ kind: "superseded", later: s.entries[1]!.seq });
    expect(r.state.entries).toHaveLength(1);
    expect(opOf(r.state, 0)).toMatchObject({ baseRev: "r9", doc: { notes: "later" } });
    expect(doneOf(opOf(r.state, 0).doc)).toEqual([true, true]);
  });

  it("a save whose workout was deleted later in the queue is dropped on conflict", () => {
    let s = addOp(emptyOutbox(), sessionOp(doc("draft"), null), null);
    s = addOp(s, sessionOp(null, null), s.entries[0]!.seq);
    const r = resolve(s, s.entries[0]!.seq, { current: doc("another device's"), rev: "r3" }, true);
    expect(r.kind).toBe("superseded");
    expect(r.state.entries.map((e) => isNoopDelete(e.op))).toEqual([true]); // nothing will be sent
  });

  it("a delete conflict keeps the server's copy unless it's what this device last saw", () => {
    let s = addOp(emptyOutbox(), sessionOp(null, "r1", doc("seen")), null);
    const seq = s.entries[0]!.seq;
    expect(resolve(s, seq, { current: doc("changed there"), rev: "r2" }, true)).toMatchObject({
      kind: "keptServer",
      state: { entries: [] },
    });
    const same = resolve(s, seq, { current: doc("seen"), rev: "r2" }, true);
    expect(same.kind).toBe("retry");
    s = same.state;
    expect(request(opOf(s, 0)).headers).toEqual({ "If-Match": '"r2"' });
  });

  it("an over-limit merge is trimmed; logged work over the limit fails with the reason", () => {
    const many = (p: string, n: number, done: boolean) =>
      Array.from({ length: n }, (_, i) => (done ? logged(`${p}${i}`) : set(`${p}${i}`)));
    const anc = sess([primary(many("a", 10, false))]);
    const mine = sess([primary([...many("a", 10, false), ...many("m", 15, false)])]);
    const theirs = sess([primary([...many("a", 10, false), ...many("t", 15, true)])]);
    let s = addOp(emptyOutbox(), sessionOp(mine, "r1", anc), null);
    let r = resolve(s, s.entries[0]!.seq, { current: theirs, rev: "r2" }, true);
    expect(r).toMatchObject({ kind: "retry", conflicts: ["10 unlogged sets were left out (an exercise holds at most 30 sets)"] });
    expect(validateOp(r.state.entries[0]!.op)).toBeNull();
    expect(opOf(r.state, 0).doc!.blocks[0]!.exercises[0]!.sets.filter((x) => x.done)).toHaveLength(15);

    const mineLogged = sess([primary([...many("a", 10, false), ...many("m", 16, true)])]);
    s = addOp(emptyOutbox(), sessionOp(mineLogged, "r1", anc), null);
    r = resolve(s, s.entries[0]!.seq, { current: theirs, rev: "r2" }, true);
    expect(r).toMatchObject({ kind: "failed", error: expect.stringMatching(/more than 30 logged sets/) });
  });

  it("settings: list conflicts are reported with the merge", () => {
    const weeks = settings.program.weeks;
    const anc = settings;
    const mine = { ...anc, program: { ...anc.program, weeks: weeks.map((w, i) => (i === 1 ? { ...w, reps: [9] } : w)) } };
    const theirs = { ...anc, program: { ...anc.program, weeks: weeks.map((w, i) => (i === 1 ? { ...w, reps: [7] } : w)) } };
    const s = addOp(emptyOutbox(), { kind: "settings", settings: mine, baseRev: "s1", base: anc }, null);
    expect(resolve(s, s.entries[0]!.seq, { current: theirs, rev: "s2" }, true)).toMatchObject({
      kind: "retry",
      conflicts: ["program weeks"],
    });
  });

  it("a rejected document under a later copy of it isn't shown", () => {
    const b: Bootstrap = { settings, days: [], exercises: [], maxEntries: [], sessions: [doc("server")], seenAchievements: [] };
    let s = addOp(emptyOutbox(), sessionOp(doc("rejected")), null);
    s = failEntry(s, s.entries[0]!.seq, "bad");
    // Another window's later copy, merged in (addOp would have replaced it).
    s = { ...s, entries: [...s.entries, { seq: 99, op: sessionOp(doc("later")), state: "acked", result: doc("later"), ackNo: 1 }] };
    expect(overlay(b, s.entries, {}).sessions[0]!.notes).toBe("server");
  });
});
