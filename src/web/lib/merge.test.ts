import { describe, expect, it } from "vitest";
import { defaultSettings } from "../../shared/defaults";
import type { Session, SetEntry } from "../../shared/schemas";
import { blankSet } from "../../shared/session";
import { ackEntry, addOp, emptyOutbox, request, type Op } from "./outbox-core";
import { mergeFields, mergeSession, mergeSettings } from "./merge";

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
