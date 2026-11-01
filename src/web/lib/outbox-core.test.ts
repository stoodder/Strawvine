import { describe, expect, it } from "vitest";
import type { Bootstrap, Session, Settings } from "../../shared/schemas";
import {
  ackEntry,
  addOp,
  applyAcked,
  discardFailed,
  emptyOutbox,
  ensureIdempotencyKeys,
  failEntry,
  nextSendable,
  opLabel,
  overlay,
  pendingDates,
  request,
  retryFailed,
  type OutboxState,
  type OverlayCache,
} from "./outbox-core";

const settings = { onboarded: true } as unknown as Settings;
const boot = (): Bootstrap => ({
  settings,
  days: [],
  exercises: [{ id: 1, name: "Squat", category: "primary", measure: "reps", tracksMax: true, archived: false }],
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
