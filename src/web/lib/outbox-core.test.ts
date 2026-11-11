import { describe, expect, it } from "vitest";
import { defaultSettings } from "../../shared/defaults";
import type { Bootstrap, Session, Settings } from "../../shared/schemas";
import {
  ackEntry,
  addOp,
  allocTempId,
  applyAcked,
  dependentsOfFailed,
  discardFailed,
  BROKEN_TEXT,
  emptyOutbox,
  ensureIdempotencyKeys,
  failEntry,
  failOrSupersede,
  isNoopDelete,
  markSending,
  mergeOutbox,
  nextSendable,
  opLabel,
  overlay,
  pendingDates,
  pruneAcked,
  queueWeightedFixes,
  request,
  resolveConflict,
  retryFailed,
  savedAlready,
  validateOp,
  type OutboxState,
  type OverlayCache,
} from "./outbox-core";

const settings = { onboarded: true } as unknown as Settings;
const boot = (): Bootstrap => ({
  settings,
  days: [],
  exercises: [{ id: 1, name: "Squat", category: "primary", measure: "reps", tracksMax: true, weighted: true, archived: false }],
  maxEntries: [],
  sessions: [],
  seenAchievements: [],
});
const session = (date: string, exerciseId: number, note = ""): Session =>
  ({ date, blocks: [{ id: "a", exercises: [{ exerciseId, sets: [] }] }], notes: note }) as unknown as Session;

describe("outbox", () => {
  it("coalesces unsent day patches and moves them to the end", () => {
    let s: OutboxState = emptyOutbox();
    s = addOp(s, { kind: "day", date: "2026-01-01", patch: { steps: 1 } }, null);
    s = addOp(s, { kind: "settings", settings }, null);
    s = addOp(s, { kind: "day", date: "2026-01-01", patch: { calories: 2 } }, null);
    expect(s.entries.map((e) => e.op.kind)).toEqual(["settings", "day"]);
    expect(s.entries[1]!.op).toMatchObject({ patch: { steps: 1, calories: 2 } });
  });

  it("merges exercise edits queued offline field by field (measure, category, …), the later value winning", () => {
    let s: OutboxState = emptyOutbox();
    s = addOp(s, { kind: "updateExercise", id: 1, patch: { measure: "seconds", name: "Hang" } }, null);
    s = addOp(s, { kind: "updateExercise", id: 1, patch: { category: "core" } }, null);
    s = addOp(s, { kind: "updateExercise", id: 1, patch: { measure: "meters" } }, null);
    expect(s.entries.map((e) => e.op)).toEqual([
      { kind: "updateExercise", id: 1, patch: { measure: "meters", name: "Hang", category: "core" } },
    ]);
    // Shown at once, over the server's copy (whose other fields stay).
    expect(overlay(boot(), s.entries, {}).exercises[0]).toMatchObject({
      name: "Hang",
      category: "core",
      measure: "meters",
      tracksMax: true,
      weighted: true,
    });
    // One in flight is left alone: the next edit queues behind it.
    const flying = s.entries[0]!.seq;
    s = addOp(s, { kind: "updateExercise", id: 1, patch: { category: "carry" } }, flying);
    expect(s.entries.map((e) => (e.op as { patch: object }).patch)).toEqual([
      { measure: "meters", name: "Hang", category: "core" },
      { category: "carry" },
    ]);
  });

  it("never touches the entry in flight", () => {
    let s = addOp(emptyOutbox(), { kind: "session", date: "2026-01-01", doc: session("2026-01-01", 1, "a") }, null);
    const flying = s.entries[0]!.seq;
    s = addOp(s, { kind: "session", date: "2026-01-01", doc: session("2026-01-01", 1, "b") }, flying);
    s = addOp(s, { kind: "session", date: "2026-01-01", doc: session("2026-01-01", 1, "c") }, flying);
    expect(s.entries).toHaveLength(2);
    expect((s.entries[1]!.op as { doc: Session }).doc.notes).toBe("c");
  });

  it("drops an add+delete pair that was never sent", () => {
    let s = addOp(
      emptyOutbox(),
      { kind: "addMax", tempId: -1, exerciseId: 1, date: "2026-01-01", valueLb: 100, source: "manual", note: null, createdAt: "" },
      null,
    );
    s = addOp(s, { kind: "deleteMax", id: -1 }, null);
    expect(s.entries).toHaveLength(0);
  });

  it("remaps temp ids after a create is acked, and holds dependents until then", () => {
    let s = addOp(
      emptyOutbox(),
      { kind: "createExercise", tempId: -1, name: "Row", category: "accessory", measure: "reps", tracksMax: false },
      null,
    );
    s = addOp(s, { kind: "session", date: "2026-01-01", doc: session("2026-01-01", -1) }, null);
    s = addOp(s, { kind: "seen", keys: ["pr-1"] }, null);
    s = failEntry(s, s.entries[0]!.seq, "bad");
    expect(nextSendable(s.entries)?.op.kind).toBe("seen"); // the session waits on the failed create
    s = retryFailed(s);
    expect(nextSendable(s.entries)?.op.kind).toBe("createExercise");
    s = ackEntry(s, s.entries[0]!.seq, { id: 42, name: "Row", category: "accessory", measure: "reps", tracksMax: false, archived: false });
    expect(s.tempMap["-1"]).toBe(42);
    const sess = s.entries.find((e) => e.op.kind === "session")!.op as { doc: Session };
    expect(sess.doc.blocks[0]!.exercises[0]!.exerciseId).toBe(42);
    // Ops queued later with the stale temp id are remapped on the way in.
    s = addOp(s, { kind: "updateExercise", id: -1, patch: { archived: true } }, null);
    expect(s.entries.at(-1)!.op).toMatchObject({ id: 42 });
  });

  it("discarding a failed create drops what depends on it", () => {
    let s = addOp(
      emptyOutbox(),
      { kind: "createExercise", tempId: -1, name: "Row", category: "accessory", measure: "reps", tracksMax: false },
      null,
    );
    s = addOp(
      s,
      { kind: "addMax", tempId: -2, exerciseId: -1, date: "2026-01-01", valueLb: 1, source: "manual", note: null, createdAt: "" },
      null,
    );
    s = addOp(s, { kind: "day", date: "2026-01-01", patch: { steps: 5 } }, null);
    s = discardFailed(failEntry(s, s.entries[0]!.seq, "bad"));
    expect(s.entries.map((e) => e.op.kind)).toEqual(["day"]);
  });
});

describe("overlay", () => {
  it("shows unsynced edits over the base and keeps untouched collections' identity", () => {
    const base = boot();
    const cache: OverlayCache = {};
    let s = addOp(emptyOutbox(), { kind: "day", date: "2026-01-02", patch: { steps: 9 } }, null);
    const a = overlay(base, s.entries, cache);
    expect(a.days[0]).toMatchObject({ date: "2026-01-02", steps: 9 });
    expect(a.sessions).toBe(base.sessions);
    s = addOp(s, { kind: "session", date: "2026-01-02", doc: session("2026-01-02", 1) }, null);
    const b = overlay(base, s.entries, cache, a);
    expect(b.days).toBe(a.days); // days unchanged → same array
    expect(b.sessions).toHaveLength(1);
    expect(overlay(base, s.entries, cache, b)).toBe(b);
  });

  it("a server snapshot that predates a pending edit can't hide it", () => {
    const s = addOp(emptyOutbox(), { kind: "day", date: "2026-01-02", patch: { steps: 9 } }, null);
    const snapshot = { ...boot(), days: [{ date: "2026-01-02", steps: 1 } as Bootstrap["days"][number]] };
    expect(overlay(snapshot, s.entries, {}).days[0]!.steps).toBe(9);
  });

  it("acked results are re-applied to a base that predates them", () => {
    let s = addOp(
      emptyOutbox(),
      { kind: "addMax", tempId: -1, exerciseId: 1, date: "2026-01-01", valueLb: 100, source: "manual", note: null, createdAt: "" },
      null,
    );
    const saved = { id: 7, exerciseId: 1, date: "2026-01-01", valueLb: 100, source: "manual", note: null, createdAt: "x" };
    s = ackEntry(s, s.entries[0]!.seq, saved);
    const base = applyAcked(boot(), s.entries);
    expect(base.maxEntries).toEqual([saved]);
    expect(overlay(base, s.entries, {}).maxEntries).toEqual([saved]);
  });
});

describe("weighted exercises", () => {
  const create = {
    kind: "createExercise",
    tempId: -1,
    name: "Dead hang",
    category: "accessory",
    measure: "seconds",
    tracksMax: false,
  } as const;

  it("sends and shows the flag a create was made with", () => {
    const s = addOp(emptyOutbox(), { ...create, weighted: false }, null);
    expect(request(s.entries[0]!.op).body).toEqual({
      name: "Dead hang",
      category: "accessory",
      measure: "seconds",
      tracksMax: false,
      weighted: false,
    });
    expect(overlay(boot(), s.entries, {}).exercises.at(-1)).toMatchObject({ id: -1, measure: "seconds", weighted: false });
  });

  it("sends a weighted create without the flag, as builds and servers from before it do", () => {
    const s = addOp(emptyOutbox(), { ...create, weighted: true }, null);
    expect(request(s.entries[0]!.op).body).toEqual({ name: "Dead hang", category: "accessory", measure: "seconds", tracksMax: false });
    expect(overlay(boot(), s.entries, {}).exercises.at(-1)).toMatchObject({ id: -1, weighted: true });
  });

  it("sends a create queued before the flag existed as it was (same idempotency hash), shown as weighted", () => {
    const s = addOp(emptyOutbox(), create, null);
    expect(request(s.entries[0]!.op).body).toEqual({ name: "Dead hang", category: "accessory", measure: "seconds", tracksMax: false });
    expect(overlay(boot(), s.entries, {}).exercises.at(-1)).toMatchObject({ id: -1, weighted: true });
  });

  describe("a create that meant unweighted but was saved weighted (sent by a window on an older build)", () => {
    const saved = (weighted: boolean | undefined) => ({
      id: 42,
      name: "Dead hang",
      category: "accessory",
      measure: "seconds",
      tracksMax: false,
      archived: false,
      ...(weighted === undefined ? {} : { weighted }),
    });
    /** A create queued with `weighted` (or without it: "absent"), acked with `result`. */
    const acked = (result: unknown, weighted: boolean | "absent" = false) => {
      const s = addOp(emptyOutbox(), { ...create, ...(weighted === "absent" ? {} : { weighted }) }, null);
      return ackEntry(s, s.entries[0]!.seq, result);
    };

    it("queues a patch turning it off for the saved row, once", () => {
      const s = queueWeightedFixes(acked(saved(true)), null);
      expect(s.entries.map((e) => [e.state, e.op.kind])).toEqual([
        ["acked", "createExercise"],
        ["pending", "updateExercise"],
      ]);
      const fix = s.entries[1]!;
      expect(request(fix.op)).toEqual({ method: "PATCH", path: "/exercises/42", body: { weighted: false } });
      expect(nextSendable(s.entries)).toBe(fix);
      // Shown unweighted all along: the server's row, with the queued patch on top.
      expect(overlay(applyAcked(boot(), s.entries), s.entries, {}).exercises.at(-1)).toMatchObject({ id: 42, weighted: false });
      expect(queueWeightedFixes(s, null)).toBe(s);
      // Another window's copy carries the mark too (the acked entry's rev moved).
      const other = mergeOutbox(acked(saved(true)), s);
      expect(queueWeightedFixes(other, null).entries).toHaveLength(2);
    });

    it("leaves creates the server saved as asked, weighted ones, and failed or pending ones alone", () => {
      for (const s of [
        acked(saved(false)),
        acked(saved(true), true),
        acked(saved(true), "absent"),
        acked(saved(undefined)), // a server from before the flag: nothing to patch there
        acked(null),
        addOp(emptyOutbox(), { ...create, weighted: false }, null),
      ])
        expect(queueWeightedFixes(s, null)).toBe(s);
    });

    it("doesn't override a later choice of the flag already queued", () => {
      const s = addOp(acked(saved(true)), { kind: "updateExercise", id: 42, patch: { weighted: true } }, null);
      const fixed = queueWeightedFixes(s, null);
      expect(fixed.entries.filter((e) => e.op.kind === "updateExercise").map((e) => e.op)).toEqual([
        { kind: "updateExercise", id: 42, patch: { weighted: true } },
      ]);
      expect(queueWeightedFixes(fixed, null)).toBe(fixed);
    });

    it("merges into an unsent rename of the exercise", () => {
      const s = addOp(acked(saved(true)), { kind: "updateExercise", id: 42, patch: { name: "Hang" } }, null);
      const fixed = queueWeightedFixes(s, null);
      expect(fixed.entries.filter((e) => e.state === "pending").map((e) => e.op)).toEqual([
        { kind: "updateExercise", id: 42, patch: { name: "Hang", weighted: false } },
      ]);
    });
  });

  it("patches the flag like any other exercise field", () => {
    const s = addOp(emptyOutbox(), { kind: "updateExercise", id: 1, patch: { weighted: false } }, null);
    expect(request(s.entries[0]!.op)).toMatchObject({ method: "PATCH", path: "/exercises/1", body: { weighted: false } });
    expect(overlay(boot(), s.entries, {}).exercises[0]).toMatchObject({ id: 1, weighted: false });
  });
});

describe("idempotency keys", () => {
  const addMax = (tempId: number) =>
    ({ kind: "addMax", tempId, exerciseId: 1, date: "2026-01-01", valueLb: 100, source: "manual", note: null, createdAt: "" }) as const;
  const createExercise = {
    kind: "createExercise",
    tempId: -9,
    name: "Row",
    category: "accessory",
    measure: "reps",
    tracksMax: false,
  } as const;

  it("gives every create its own key when queued, persisted with the op and sent as a header", () => {
    let s = addOp(emptyOutbox(), addMax(-1), null);
    s = addOp(s, createExercise, null);
    s = addOp(s, { kind: "day", date: "2026-01-01", patch: { steps: 1 } }, null);
    const [max, ex, day] = s.entries.map((e) => e.op);
    const k1 = (max as { idemKey?: string }).idemKey!;
    const k2 = (ex as { idemKey?: string }).idemKey!;
    expect(k1).toMatch(/^[A-Za-z0-9._:-]{8,80}$/);
    expect(k2).toMatch(/^[A-Za-z0-9._:-]{8,80}$/);
    expect(k1).not.toBe(k2);
    expect(day).not.toHaveProperty("idemKey");

    // Survives the localStorage round trip, so a retry after a reload reuses it.
    const reloaded = JSON.parse(JSON.stringify(s)) as OutboxState;
    expect(request(reloaded.entries[0]!.op).headers).toEqual({ "Idempotency-Key": k1 });
    expect(request(reloaded.entries[1]!.op).headers).toEqual({ "Idempotency-Key": k2 });
    expect(request(day!).headers).toBeUndefined();
  });

  it("keeps the key through temp-id remapping and retries", () => {
    let s = addOp(emptyOutbox(), createExercise, null);
    s = addOp(s, { ...addMax(-2), exerciseId: -9 }, null);
    const key = (s.entries[1]!.op as { idemKey?: string }).idemKey;
    s = failEntry(s, s.entries[0]!.seq, "bad");
    s = retryFailed(s);
    s = ackEntry(s, s.entries[0]!.seq, { id: 42, name: "Row", category: "accessory", measure: "reps", tracksMax: false, archived: false });
    const op = s.entries[1]!.op;
    expect(op).toMatchObject({ exerciseId: 42, idemKey: key });
    expect(request(op).path).toBe("/exercises/42/maxes");
  });

  it("keys creates in an outbox saved before keys existed, once", () => {
    const legacy: OutboxState = {
      ...emptyOutbox(),
      entries: [
        { seq: 1, op: addMax(-1), state: "pending" },
        { seq: 2, op: addMax(-2), state: "acked", result: { id: 3 }, ackNo: 1 },
      ],
    };
    const keyed = ensureIdempotencyKeys(legacy);
    expect((keyed.entries[0]!.op as { idemKey?: string }).idemKey).toBeTruthy();
    expect(keyed.entries[1]!.op).not.toHaveProperty("idemKey");
    expect(ensureIdempotencyKeys(keyed)).toBe(keyed);
  });

  it("doesn't leak the key into the optimistic row", () => {
    const s = addOp(addOp(emptyOutbox(), addMax(-1), null), createExercise, null);
    const shown = overlay(boot(), s.entries, {});
    expect(shown.maxEntries[0]).not.toHaveProperty("idemKey");
    expect(shown.exercises.at(-1)).not.toHaveProperty("idemKey");
  });
});

describe("sync details", () => {
  it("lists dates with unsynced day or workout edits", () => {
    let s = addOp(emptyOutbox(), { kind: "day", date: "2026-01-02", patch: { steps: 1 } }, null);
    s = addOp(s, { kind: "session", date: "2026-01-03", doc: null }, null);
    s = addOp(s, { kind: "settings", settings }, null);
    s = addOp(s, { kind: "day", date: "2026-01-04", patch: { steps: 1 } }, null);
    s = ackEntry(s, s.entries.at(-1)!.seq, null);
    s = failEntry(s, s.entries[0]!.seq, "bad");
    expect([...pendingDates(s.entries)].sort()).toEqual(["2026-01-02", "2026-01-03"]);
  });

  it("labels changes for the unsynced list", () => {
    expect(opLabel({ kind: "day", date: "2026-11-02", patch: {} })).toMatch(/^Log · /);
    expect(opLabel({ kind: "session", date: "2026-11-02", doc: null })).toMatch(/^Deleted workout · /);
    expect(opLabel({ kind: "createExercise", tempId: -1, name: "Row", category: "accessory", measure: "reps", tracksMax: false })).toBe(
      "New exercise · Row",
    );
  });
});

describe("rejected entries", () => {
  const day = (patch: Record<string, number>) => ({ kind: "day", date: "2026-01-01", patch }) as const;

  it("never merges a later edit into a failed entry; the later one is still sent", () => {
    let s = addOp(emptyOutbox(), day({ steps: 999_999 }), null);
    s = failEntry(s, s.entries[0]!.seq, "too many");
    s = addOp(s, day({ calories: 5 }), null);
    expect(s.entries.map((e) => [e.state, e.op])).toEqual([
      ["failed", day({ steps: 999_999 })],
      ["pending", day({ calories: 5 })],
    ]);
    expect(nextSendable(s.entries)?.op).toEqual(day({ calories: 5 }));
    // Discard drops only the failed one.
    s = discardFailed(s);
    expect(s.entries.map((e) => e.op)).toEqual([day({ calories: 5 })]);
  });

  it("a newer whole document supersedes a failed one", () => {
    let s = addOp(emptyOutbox(), { kind: "session", date: "2026-01-01", doc: session("2026-01-01", 1, "a") }, null);
    s = failEntry(s, s.entries[0]!.seq, "bad");
    s = addOp(s, { kind: "session", date: "2026-01-01", doc: session("2026-01-01", 1, "b") }, null);
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]).toMatchObject({ state: "pending", op: { doc: { notes: "b" } } });
  });

  it("names the edits a discard takes with it", () => {
    let s = addOp(
      emptyOutbox(),
      { kind: "createExercise", tempId: -1, name: "Row", category: "accessory", measure: "reps", tracksMax: false },
      null,
    );
    s = addOp(s, { kind: "updateExercise", id: -1, patch: { archived: true } }, null);
    s = addOp(s, day({ steps: 1 }), null);
    s = failEntry(s, s.entries[0]!.seq, "bad");
    expect(dependentsOfFailed(s).map((e) => e.op.kind)).toEqual(["updateExercise"]);
    expect(discardFailed(s).entries.map((e) => e.op.kind)).toEqual(["day"]);
  });

  it("validates the limits a workout can hit before queueing", () => {
    const ex = { exerciseId: 1, measure: "reps", sets: [] };
    const doc = (exercises: number) =>
      ({
        ...session("2026-01-01", 1),
        label: "",
        blocks: [{ id: "a", kind: "accessory", exercises: Array(exercises).fill(ex) }],
      }) as unknown as Session;
    expect(validateOp({ kind: "session", date: "2026-01-01", doc: doc(6) })).toBeNull();
    expect(validateOp({ kind: "session", date: "2026-01-01", doc: doc(7) })).toMatch(/superset/);
    expect(validateOp({ kind: "day", date: "2026-01-01", patch: { steps: 1 } })).toBeNull();
    // Legacy sessions with null notes/label must validate instead of throwing (finishing such a session was lost).
    const legacy = { ...doc(1), notes: null, label: null } as unknown as Parameters<typeof validateOp>[0] extends { doc?: infer D }
      ? D
      : never;
    expect(() => validateOp({ kind: "session", date: "2026-01-01", doc: legacy })).not.toThrow();
    expect(validateOp({ kind: "session", date: "2026-01-01", doc: legacy })).toBeNull();
  });
});

describe("two windows", () => {
  it("seqs and temp ids carry the tab number, so concurrent windows never collide", () => {
    const a = addOp(emptyOutbox(), { kind: "day", date: "2026-01-01", patch: { steps: 1 } }, null, 7);
    const b = addOp(emptyOutbox(), { kind: "day", date: "2026-01-02", patch: { steps: 2 } }, null, 9);
    expect(a.entries[0]!.seq).not.toBe(b.entries[0]!.seq);
    expect(allocTempId(emptyOutbox(), 7)[0]).not.toBe(allocTempId(emptyOutbox(), 9)[0]);
    expect(allocTempId(emptyOutbox(), 7)[0]).toBeLessThan(0);
  });

  it("merging keeps both windows' edits, an ack over a pending copy, and honours removals", () => {
    const start = addOp(emptyOutbox(), { kind: "day", date: "2026-01-01", patch: { steps: 1 } }, null, 1);
    // Both windows saw `start`; then each changes it without seeing the other.
    const a = addOp(ackEntry(start, start.entries[0]!.seq, { date: "2026-01-01", steps: 1 }), { kind: "settings", settings }, null, 1);
    const b = addOp(start, { kind: "day", date: "2026-01-03", patch: { steps: 3 } }, null, 2);
    const m = mergeOutbox(a, b);
    expect(m.entries.map((e) => [e.op.kind, e.state])).toEqual([
      ["day", "acked"],
      ["settings", "pending"],
      ["day", "pending"],
    ]);
    expect(mergeOutbox(b, a).entries.map((e) => e.seq)).toEqual(m.entries.map((e) => e.seq));
    // A prune in one window isn't undone by the other's older copy.
    const pruned = pruneAcked(m, new Set([m.entries[0]!.seq]));
    expect(mergeOutbox(pruned, a).entries).toHaveLength(2);
    // Nothing new: same object back.
    expect(mergeOutbox(m, JSON.parse(JSON.stringify(m)) as OutboxState)).toBe(m);
  });

  it("a sign-out reset (newer epoch) replaces the older generation", () => {
    const old = addOp(emptyOutbox(), { kind: "day", date: "2026-01-01", patch: { steps: 1 } }, null, 1);
    const reset: OutboxState = { ...emptyOutbox(), epoch: 5 };
    expect(mergeOutbox(old, reset).entries).toEqual([]);
    expect(mergeOutbox(reset, old).entries).toEqual([]);
  });
});

describe("identity", () => {
  it("an ack that confirms what's shown keeps the displayed arrays", () => {
    const b0 = { ...boot(), days: [{ date: "2026-01-01", steps: 1 } as Bootstrap["days"][number]] };
    const cache: OverlayCache = {};
    let s = addOp(emptyOutbox(), { kind: "day", date: "2026-01-01", patch: { steps: 2 } }, null);
    const shown = overlay(b0, s.entries, cache);
    const result = { ...shown.days[0]! };
    s = ackEntry(s, s.entries[0]!.seq, result);
    const b1 = applyAcked(b0, s.entries);
    expect(b1.days).not.toBe(b0.days);
    const after = overlay(b1, s.entries, cache, shown);
    expect(after).toBe(shown); // nothing recomputes
    // And re-applying the same result to a base that has it changes nothing.
    expect(applyAcked(b1, s.entries)).toBe(b1);
  });

  it("recomputes when a queued op is rewritten in place (temp id remapped), not keyed on seqs", () => {
    const cache: OverlayCache = {};
    let s = addOp(
      emptyOutbox(),
      { kind: "addMax", tempId: -1, exerciseId: 1, date: "2026-01-01", valueLb: 100, source: "amrap", note: null, createdAt: "" },
      null,
    );
    s = addOp(s, { kind: "seen", keys: ["max--1"] }, null);
    const shown = overlay(boot(), s.entries, cache);
    expect(shown.seenAchievements).toEqual(["max--1"]);
    s = ackEntry(s, s.entries[0]!.seq, {
      id: 7,
      exerciseId: 1,
      date: "2026-01-01",
      valueLb: 100,
      source: "amrap",
      note: null,
      createdAt: "x",
    });
    const b1 = applyAcked(boot(), s.entries);
    expect(overlay(b1, s.entries, cache, shown).seenAchievements).toEqual(["max-7"]);
  });

  it("sends createdAt with a queued max", () => {
    const op = {
      kind: "addMax",
      tempId: -1,
      exerciseId: 1,
      date: "2026-01-01",
      valueLb: 100,
      source: "manual",
      note: null,
      createdAt: "2026-01-01T10:00:00.000Z",
    } as const;
    expect(request(op).body).toMatchObject({ createdAt: "2026-01-01T10:00:00.000Z" });
  });
});

describe("a rejected edit under a newer one", () => {
  it("doesn't cover a field a later (even acked) edit set", () => {
    const b0 = { ...boot(), days: [{ date: "2026-01-01", journal: "old", steps: 1 } as unknown as Bootstrap["days"][number]] };
    let s = addOp(emptyOutbox(), { kind: "day", date: "2026-01-01", patch: { journal: "rejected", steps: 99 } }, null);
    s = failEntry(s, s.entries[0]!.seq, "bad");
    s = addOp(s, { kind: "day", date: "2026-01-01", patch: { journal: "later" } }, null);
    s = ackEntry(s, s.entries[1]!.seq, { date: "2026-01-01", journal: "later", steps: 1 });
    const cache: OverlayCache = {};
    const shown = overlay(applyAcked(b0, s.entries), s.entries, cache);
    expect(shown.days[0]).toMatchObject({ journal: "later", steps: 99 });
    expect(overlay(applyAcked(b0, s.entries), s.entries, cache, shown)).toBe(shown);
  });
});

/**
 * A whole-document save whose answer never arrived may be on the server. Coalescing a later edit
 * into it used to leave that edit on the base from *before* the save; the retry's 409 then
 * carried this device's own save, and the merge kept it over every field the later edit had put
 * back (base == mine: "not changed here") — an Undo, silently dropped.
 */
describe("a save that went out and was never answered", () => {
  const S0: Settings = {
    ...defaultSettings({ bench: 1, deadlift: 2, backSquat: 3, frontSquat: 4, strictPress: 5 }, "2026-10-26"),
    onboarded: true,
  };
  const start = (s: Settings, cycleStartDate: string): Settings => ({ ...s, program: { ...s.program, cycleStartDate } });
  const steps = (s: Settings, n: number): Settings => ({ ...s, targets: { ...s.targets, steps: n } });
  const delayed = start(S0, "2026-11-02");
  const save = (settings: Settings, baseRev = "r0", base = S0) => ({ kind: "settings", settings, baseRev, base }) as const;
  const docs = (s: OutboxState) => s.entries.map((e) => (e.op as { settings: Settings }).settings);
  /** "Delay a week" is sent; the connection drops before the answer (the sender clears its marker and backs off). */
  const sentAndLost = (): OutboxState => {
    let s = addOp(emptyOutbox(), save(delayed), null);
    s = markSending(s, s.entries[0]!.seq, 1000);
    return { ...s, inflight: null };
  };

  it("is left as it was sent: the Undo queues behind it, and later edits coalesce into the Undo", () => {
    let s = sentAndLost();
    expect(s.entries[0]).toMatchObject({ state: "pending", tried: true });
    s = addOp(s, save(S0), null); // Undo, made on the same server copy
    expect(docs(s)).toEqual([delayed, S0]);
    s = addOp(s, save(steps(S0, 12000)), null);
    expect(docs(s)).toEqual([delayed, steps(S0, 12000)]);
    expect(s.entries.map((e) => e.tried ?? false)).toEqual([true, false]);
  });

  it("the retry's 409 with this very document is its answer: acked, and the Undo re-based on it", () => {
    let s = addOp(sentAndLost(), save(S0), null);
    const [first, undo] = s.entries;
    const conflict = { current: delayed, rev: "r1" };
    expect(savedAlready(first!.op, conflict)).toBe(true);
    s = ackEntry(s, first!.seq, conflict.current, { srev: conflict.rev });
    expect(s.entries.find((e) => e.seq === undo!.seq)!.op).toEqual(save(S0, "r1", delayed));
    expect(request(nextSendable(s.entries)!.op).headers).toEqual({ "If-Match": '"r1"' });
  });

  it("a 409 with anything else is merged with the right ancestor: the Undo still takes the date back", () => {
    let s = addOp(sentAndLost(), save(steps(S0, 12000)), null); // Undo + a new steps target
    const first = s.entries[0]!;
    // The server has this device's save, and another device's Zone 2 target on top.
    const theirs = { ...delayed, targets: { ...delayed.targets, zone2Minutes: 45 } };
    expect(savedAlready(first.op, { current: theirs, rev: "r2" })).toBe(false);
    const r = resolveConflict(s, first.seq, { current: theirs, rev: "r2" }, true);
    expect(r.kind).toBe("retry");
    s = (r as { state: OutboxState }).state;
    expect(docs(s)).toEqual([theirs, { ...steps(S0, 12000), targets: { ...S0.targets, steps: 12000, zone2Minutes: 45 } }]);
    expect(s.entries.map((e) => (e.op as { baseRev: string }).baseRev)).toEqual(["r2", "r2"]);
  });

  it("a 409 proves the request wasn't applied: its merged copy takes later edits again", () => {
    let s = sentAndLost();
    const seq = s.entries[0]!.seq;
    const theirs = steps(S0, 9000); // another device's save; this device's never arrived
    s = (resolveConflict(s, seq, { current: theirs, rev: "r1" }, true) as { state: OutboxState }).state;
    expect(s.entries[0]!.tried).toBeUndefined();
    s = addOp(s, { kind: "settings", settings: theirs, baseRev: "r1", base: theirs }, null); // Undo of the delay
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]!.op).toEqual({ kind: "settings", settings: theirs, baseRev: "r1", base: theirs });
  });

  it("an outbox from a build without the mark: the entry a killed window was sending is left alone too", () => {
    let s = addOp(emptyOutbox(), save(delayed), null);
    s = { ...s, inflight: { seq: s.entries[0]!.seq, at: 1000 } }; // as stored by that build; long expired
    s = addOp(s, save(S0), null);
    expect(docs(s)).toEqual([delayed, S0]);
  });

  it("workouts alike — and a delete behind a create that may have landed is kept, to be sent at its revision", () => {
    const D = "2026-01-01";
    const doc = session(D, 1, "a");
    let s = addOp(emptyOutbox(), { kind: "session", date: D, doc, baseRev: null, base: null }, null);
    s = { ...markSending(s, s.entries[0]!.seq, 1000), inflight: null };
    s = addOp(s, { kind: "session", date: D, doc: null, baseRev: null, base: null }, null);
    expect(s.entries.map((e) => (e.op as { doc: Session | null }).doc)).toEqual([doc, null]);
    // The create is on the server (the retry's 409 says so): the delete goes out for that revision.
    expect(savedAlready(s.entries[0]!.op, { current: doc, rev: "r1" })).toBe(true);
    s = ackEntry(s, s.entries[0]!.seq, doc, { srev: "r1" });
    expect(request(nextSendable(s.entries)!.op)).toMatchObject({ method: "DELETE", headers: { "If-Match": '"r1"' } });
  });

  it("day and exercise patches aren't version-checked: they still coalesce, and carry no mark", () => {
    let s = addOp(emptyOutbox(), { kind: "day", date: "2026-01-01", patch: { steps: 1 } }, null);
    const before = s.entries[0]!;
    s = { ...markSending(s, before.seq, 1000), inflight: null };
    expect(s.entries[0]).toBe(before);
    s = addOp(s, { kind: "day", date: "2026-01-01", patch: { steps: null } }, null);
    expect(s.entries.map((e) => e.op)).toEqual([{ kind: "day", date: "2026-01-01", patch: { steps: null } }]);
  });

  it("the mark travels to another window's copy of the entry", () => {
    const a = addOp(emptyOutbox(), save(delayed), null);
    const b = markSending(a, a.entries[0]!.seq, 1000);
    expect(mergeOutbox(a, b).entries[0]!.tried).toBe(true);
    expect(mergeOutbox(b, a).entries[0]!.tried).toBe(true);
  });

  it("sending also writes the cross-window marker (which entry, since when) — for every kind of entry", () => {
    let s = addOp(emptyOutbox(), save(delayed), null);
    s = addOp(s, { kind: "day", date: "2026-01-01", patch: { steps: 1 } }, null);
    const [doc, day] = s.entries;
    expect(markSending(s, doc!.seq, 1000).inflight).toEqual({ seq: doc!.seq, at: 1000 });
    expect(markSending(s, day!.seq, 2000).inflight).toEqual({ seq: day!.seq, at: 2000 });
  });

  it("a day or exercise patch a killed window was sending still takes later patches (only whole documents are left alone)", () => {
    let s = addOp(emptyOutbox(), { kind: "day", date: "2026-01-01", patch: { steps: 1 } }, null);
    s = addOp(s, { kind: "updateExercise", id: 1, patch: { name: "Hang" } }, null);
    const [day, exercise] = s.entries;
    // The stored marker still names the entry (the window died mid-request); nothing is in flight now.
    s = addOp({ ...s, inflight: { seq: day!.seq, at: 1000 } }, { kind: "day", date: "2026-01-01", patch: { calories: 2 } }, null);
    s = addOp({ ...s, inflight: { seq: exercise!.seq, at: 1000 } }, { kind: "updateExercise", id: 1, patch: { category: "core" } }, null);
    expect(s.entries.map((e) => e.op)).toEqual([
      { kind: "day", date: "2026-01-01", patch: { steps: 1, calories: 2 } },
      { kind: "updateExercise", id: 1, patch: { name: "Hang", category: "core" } },
    ]);
  });

  it("a delete re-sent at the server's new revision is a new request: later edits replace it again", () => {
    const D = "2026-01-01";
    const doc = session(D, 1, "a");
    let s = addOp(emptyOutbox(), { kind: "session", date: D, doc: null, baseRev: "r1", base: doc }, null);
    s = { ...markSending(s, s.entries[0]!.seq, 1000), inflight: null };
    expect(s.entries[0]!.tried).toBe(true);
    // 409: the same document under a newer revision (saved again unchanged elsewhere) — the delete stands.
    const r = resolveConflict(s, s.entries[0]!.seq, { current: doc, rev: "r2" }, true);
    expect(r.kind).toBe("retry");
    s = (r as { state: OutboxState }).state;
    expect(s.entries[0]!.tried).toBeUndefined(); // that request wasn't applied
    expect(s.entries[0]!.op).toEqual({ kind: "session", date: D, doc: null, baseRev: "r2", base: doc });
    // "Undo delete": coalesced into it (nothing of the delete is on the server), on its base.
    s = addOp(s, { kind: "session", date: D, doc, baseRev: "r2", base: doc }, null);
    expect(s.entries.map((e) => e.op)).toEqual([{ kind: "session", date: D, doc, baseRev: "r2", base: doc }]);
  });
});

/**
 * The screen shows an unsettled save's document whatever the device's server copy says. So an
 * edit queued behind one (it can't be merged into it) is based on what that save is based on —
 * not on a server copy refreshed since, whose revision would let the edit through over changes
 * from another device that its screen never showed.
 */
describe("an edit queued behind a save that may have reached the server", () => {
  const D = "2026-01-01";
  const before = session(D, 1, "as first downloaded"); // the server's r1
  const mine = session(D, 1, "this device's edit");
  const theirs = session(D, 2, "another device's save"); // the server's r2, in this device's refreshed copy
  const op = (doc: Session | null, baseRev: string | null, base: Session | null) =>
    ({ kind: "session", date: D, doc, baseRev, base }) as const;
  /** `first` went out and was never answered; then the device's server copy was refreshed. */
  const tried = (first: ReturnType<typeof op>): OutboxState => {
    const s = addOp(emptyOutbox(), first, null);
    return { ...markSending(s, s.entries[0]!.seq, 1000), inflight: null };
  };
  const send = (s: OutboxState) => request(nextSendable(s.entries)!.op);
  const stateOf = (r: unknown) => (r as { state: OutboxState }).state;

  it("a delete: checked against the revision its screen was built on, so the other device's workout is kept", () => {
    let s = tried(op(mine, "r1", before));
    s = addOp(s, op(null, "r2", theirs), null); // as `enqueue` bases it: on the refreshed copy
    expect(s.entries[1]!.op).toEqual(op(null, "r1", before));
    // The save's retry is answered 409 and dropped for the delete…
    const r = resolveConflict(s, s.entries[0]!.seq, { current: theirs, rev: "r2" }, true);
    expect(r.kind).toBe("superseded");
    s = stateOf(r);
    // …which doesn't pass (at r2 it would have, deleting what the other device logged)…
    expect(send(s)).toMatchObject({ method: "DELETE", headers: { "If-Match": '"r1"' } });
    // …and is refused: the other device's copy isn't what this device deleted.
    expect(resolveConflict(s, s.entries[0]!.seq, { current: theirs, rev: "r2" }, true).kind).toBe("keptServer");
  });

  it("behind the save in flight alike", () => {
    let s = addOp(emptyOutbox(), op(mine, "r1", before), null);
    const seq = s.entries[0]!.seq;
    s = addOp(markSending(s, seq, 1000), op(null, "r2", theirs), seq);
    expect(s.entries.map((e) => e.op)).toEqual([op(mine, "r1", before), op(null, "r1", before)]);
  });

  it("a workout rebuilt behind a delete that never arrived: merged with the other device's, not saved over it", () => {
    let s = tried(op(null, "r1", before));
    const rebuilt = session(D, 3, "rebuilt here");
    s = addOp(s, op(rebuilt, "r2", theirs), null);
    expect(s.entries[1]!.op).toEqual(op(rebuilt, "r1", before));
    // The delete's retry: 409, the other device's copy wins over it.
    const r = resolveConflict(s, s.entries[0]!.seq, { current: theirs, rev: "r2" }, true);
    expect(r.kind).toBe("keptServer");
    // The rebuild goes out checked against r1 — a 409 and a merge — not against r2.
    expect(send(stateOf(r))).toMatchObject({ method: "PUT", headers: { "If-Match": '"r1"' } });
  });

  it("the save refused (4xx) and dropped for the edit behind it: that edit is still checked against the old revision", () => {
    let s = tried(op(mine, "r1", before));
    const next = session(D, 1, "this device's next edit");
    s = addOp(s, op(next, "r2", theirs), null);
    const r = failOrSupersede(s, s.entries[0]!.seq, "Forbidden");
    expect(r.supersededBy).toBe(s.entries[1]!.seq);
    expect(send(r.state)).toMatchObject({ method: "PUT", body: next, headers: { "If-Match": '"r1"' } });
  });

  it("a draft whose create never arrived, deleted: nothing is sent, so another device's workout that day stays", () => {
    let s = tried(op(mine, null, null));
    s = addOp(s, op(null, "r2", theirs), null); // the refreshed copy holds the other device's workout
    expect(s.entries[1]!.op).toEqual(op(null, null, null));
    // The create's retry: 409 (a workout exists), dropped for the delete…
    const r = resolveConflict(s, s.entries[0]!.seq, { current: theirs, rev: "r2" }, true);
    expect(r.kind).toBe("superseded");
    // …of something the server never had from this device: no request (`replay` drops it).
    const left = stateOf(r).entries;
    expect(left).toHaveLength(1);
    expect(isNoopDelete(left[0]!.op)).toBe(true);
  });

  it("settings alike", () => {
    const S = (n: number) => ({ onboarded: true, targets: { steps: n } }) as unknown as Settings;
    let s = addOp(emptyOutbox(), { kind: "settings", settings: S(2), baseRev: "s1", base: S(1) }, null);
    s = { ...markSending(s, s.entries[0]!.seq, 1000), inflight: null };
    s = addOp(s, { kind: "settings", settings: S(3), baseRev: "s2", base: S(9) }, null);
    expect(s.entries[1]!.op).toEqual({ kind: "settings", settings: S(3), baseRev: "s1", base: S(1) });
  });

  it("when the save is answered, the edit behind it follows on what the server saved (as before)", () => {
    let s = tried(op(mine, "r1", before));
    s = addOp(s, op(null, "r2", theirs), null);
    s = ackEntry(s, s.entries[0]!.seq, mine, { srev: "r3" });
    expect(send(s)).toMatchObject({ method: "DELETE", headers: { "If-Match": '"r3"' } });
  });

  it("a save from a copy without revisions (no base recorded) leaves the edit behind it its own", () => {
    let s = addOp(emptyOutbox(), { kind: "session", date: D, doc: mine }, null);
    s = { ...markSending(s, s.entries[0]!.seq, 1000), inflight: null };
    s = addOp(s, op(null, "r2", theirs), null);
    expect(s.entries[1]!.op).toEqual(op(null, "r2", theirs));
  });

  it("the price: a save that did land, then refused on its retry — the delete behind it is refused too, and the workout kept", () => {
    let s = tried(op(mine, "r1", before));
    s = addOp(s, op(null, "r2", mine), null); // the refreshed copy is this device's own save, at r2
    const r = failOrSupersede(s, s.entries[0]!.seq, "Forbidden"); // a proxy's 403 on the retry
    expect(send(r.state)).toMatchObject({ method: "DELETE", headers: { "If-Match": '"r1"' } });
    // 409 with this device's own save — not what the delete is based on: kept, with the notice.
    expect(resolveConflict(r.state, r.state.entries[0]!.seq, { current: mine, rev: "r2" }, true).kind).toBe("keptServer");
  });
});

describe("text the database can't store", () => {
  const D = "2026-01-01";
  const half = "great \ud83d"; // an emoji cut in half
  const whole = "great \ud83d\ude00";
  const doc = (over: Partial<Session>): Session => ({ ...session(D, 1), label: "Push", ...over });

  it("is refused wherever it would be sent: notes, names, labels, journal, object keys", () => {
    const S = { onboarded: true, program: { name: "Mine", days: [{ label: half }] } } as unknown as Settings;
    for (const op of [
      { kind: "session", date: D, doc: doc({ notes: half }) },
      { kind: "session", date: D, doc: doc({ label: "\ude00 Push" }) },
      { kind: "settings", settings: S },
      { kind: "day", date: D, patch: { journal: half } },
      { kind: "day", date: D, patch: { micros: { [half]: 1 } } },
      { kind: "updateExercise", id: 1, patch: { name: half } },
      { kind: "createExercise", tempId: -1, name: half, category: "accessory", measure: "reps", tracksMax: false },
      { kind: "addMax", tempId: -1, exerciseId: 1, date: D, valueLb: 100, source: "manual", note: half, createdAt: "" },
    ] as const)
      expect(validateOp(op as Parameters<typeof validateOp>[0]), op.kind).toBe(BROKEN_TEXT);
  });

  it("whole emoji and other characters beyond U+FFFF are fine", () => {
    expect(validateOp({ kind: "session", date: D, doc: doc({ notes: whole, label: "\ud83d\udcaa Push" }) })).toBeNull();
    expect(validateOp({ kind: "day", date: D, patch: { journal: whole, micros: { "\ud83e\udd66": 1 } } })).toBeNull();
  });

  it("doesn't look at what isn't sent (the merge ancestor), deletes, or bookkeeping", () => {
    expect(validateOp({ kind: "session", date: D, doc: doc({ notes: "ok" }), baseRev: "r1", base: doc({ notes: half }) })).toBeNull();
    expect(validateOp({ kind: "session", date: D, doc: null, baseRev: "r1", base: doc({ notes: half }) })).toBeNull();
    expect(validateOp({ kind: "seen", keys: [`bench-${half}-${D}`] })).toBeNull();
  });
});
