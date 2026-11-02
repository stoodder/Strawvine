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
        switch (rnd(5)) {
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
        }
      }
      return { ...s, blocks };
    };
    const start = sess([
      block("X", ex(10, [set("a1"), set("a2")]), ex(11, [set("b1"), set("b2")]), ex(12, [set("c1")])),
      block("Y", ex(13, [set("d1"), set("d2")])),
      block("Z", ex(14, [set("e1")])),
    ]);
    for (let i = 0; i < 300; i++) {
      const l = mutateDoc(start, `l${i}-`);
      const s = mutateDoc(start, `s${i}-`);
      const m = mergeSession(start, l, s);
      unique(m);
      expect(m.blocks.every((b) => b.exercises.length > 0)).toBe(true);
      // Every set logged on either device is still there.
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

  it("splits a superset over 6 into another block, dropping unlogged exercises first", () => {
    const exs = Array.from({ length: 8 }, (_, i) => ({
      exerciseId: 20 + i,
      measure: "reps" as const,
      sets: [set(`s${i}`, i < 7 ? { done: true } : {})],
    }));
    const { doc, error } = fitSession(sess([{ id: "big", kind: "accessory", exercises: exs }]));
    expect(error).toBeNull();
    expect(doc.blocks.map((b) => [b.id, b.exercises.length])).toEqual([
      ["big", 6],
      ["big-2", 1],
    ]);
  });

  it("says why when only logged work is over the limit", () => {
    const { error } = fitSession(sess([accessory("x", 10, many("d", 31, true))]));
    expect(error).toMatch(/more than 30 logged sets/);
  });

  it("returns the same document when it fits", () => {
    const doc = sess([primary([set("a")])]);
    expect(fitSession(doc).doc).toBe(doc);
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
    expect(r.kind).toBe("retry");
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
