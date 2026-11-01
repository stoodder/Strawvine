/**
 * The write outbox, as pure functions (no browser APIs) so it can be unit-tested.
 *
 * Every local edit becomes an `Op`, stored in an ordered list of entries that is persisted
 * before the request goes out. What the UI shows is always `overlay(base, entries)`: the last
 * server-confirmed copy (`base`) with every not-yet-confirmed op re-applied on top, so neither a
 * server snapshot nor a server response can ever undo an edit the server hasn't applied yet.
 *
 * Entry lifecycle: pending → (sent) → acked, or → failed (a 4xx; kept and still shown locally
 * until retried or discarded). Acked entries keep the server's response until the base that
 * includes it has been written to disk, so a crash between the two can't lose it.
 */
import { formatShortDate } from "../../shared/dates";
import { emptyDayLog } from "../../shared/empty";
import type {
  Bootstrap,
  DayLog,
  DayLogPatch,
  Exercise,
  ExerciseCategory,
  Measure,
  MaxEntry,
  MaxSource,
  Session,
  Settings,
} from "../../shared/schemas";

export type ExercisePatch = Partial<Omit<Exercise, "id">>;

export type Op =
  | { kind: "day"; date: string; patch: DayLogPatch }
  /** `doc: null` deletes the session. */
  | { kind: "session"; date: string; doc: Session | null }
  | { kind: "settings"; settings: Settings }
  | {
      kind: "addMax";
      tempId: number;
      exerciseId: number;
      date: string;
      valueLb: number;
      source: MaxSource;
      note: string | null;
      createdAt: string;
      /** Sent as `Idempotency-Key`; assigned by `addOp` when missing (see `ensureIdempotencyKeys`). */
      idemKey?: string;
    }
  | { kind: "deleteMax"; id: number }
  | {
      kind: "createExercise";
      tempId: number;
      name: string;
      category: ExerciseCategory;
      measure: Measure;
      tracksMax: boolean;
      /** Sent as `Idempotency-Key`; assigned by `addOp` when missing. */
      idemKey?: string;
    }
  | { kind: "updateExercise"; id: number; patch: ExercisePatch }
  | { kind: "seen"; keys: string[] };

export interface Entry {
  /** Unique, increasing; a coalesced edit gets a fresh seq (it moves to the end of the queue). */
  seq: number;
  op: Op;
  state: "pending" | "failed" | "acked";
  /** Readable reason for a `failed` entry. */
  error?: string;
  /** Server response of an `acked` entry. */
  result?: unknown;
  /** Order in which entries were acked (results must be re-applied in that order). */
  ackNo?: number;
}

export interface OutboxState {
  entries: Entry[];
  nextSeq: number;
  nextAck: number;
  /** Next temporary (negative) id for rows created offline. */
  nextTemp: number;
  /** Temporary id → the server's id, for ops (or stale UI state) still holding a temp id. */
  tempMap: Record<string, number>;
}

export const emptyOutbox = (): OutboxState => ({ entries: [], nextSeq: 1, nextAck: 1, nextTemp: -1, tempMap: {} });

export type Coll = "days" | "sessions" | "settings" | "maxEntries" | "exercises" | "seenAchievements";
export const COLLS: readonly Coll[] = ["days", "sessions", "settings", "maxEntries", "exercises", "seenAchievements"];

export function collOf(op: Op): Coll {
  switch (op.kind) {
    case "day":
      return "days";
    case "session":
      return "sessions";
    case "settings":
      return "settings";
    case "addMax":
    case "deleteMax":
      return "maxEntries";
    case "createExercise":
    case "updateExercise":
      return "exercises";
    case "seen":
      return "seenAchievements";
  }
}

/** Ops with the same key replace/merge into each other while unsent. */
function opKey(op: Op): string | null {
  switch (op.kind) {
    case "day":
      return `day:${op.date}`;
    case "session":
      return `session:${op.date}`;
    case "settings":
      return "settings";
    case "updateExercise":
      return `exercise:${op.id}`;
    case "seen":
      return "seen";
    default:
      return null;
  }
}

function merge(a: Op, b: Op): Op {
  if (a.kind === "day" && b.kind === "day") return { ...b, patch: { ...a.patch, ...b.patch } };
  if (a.kind === "updateExercise" && b.kind === "updateExercise") return { ...b, patch: { ...a.patch, ...b.patch } };
  if (a.kind === "seen" && b.kind === "seen") return { kind: "seen", keys: [...new Set([...a.keys, ...b.keys])] };
  return b; // whole-document ops: latest wins
}

const isCreator = (op: Op): op is Extract<Op, { tempId: number }> => op.kind === "addMax" || op.kind === "createExercise";

// ---------------------------------------------------------------------------
// Idempotency keys
// ---------------------------------------------------------------------------

/** A fresh idempotency key (a UUID where available). */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const rand = () => Math.random().toString(36).slice(2, 10).padEnd(8, "0");
  return `k-${Date.now().toString(36)}-${rand()}${rand()}${rand()}`;
}

/** The op with an idempotency key if it creates a row and has none yet (same op otherwise). */
function withIdempotencyKey(op: Op): Op {
  return isCreator(op) && !op.idemKey ? { ...op, idemKey: newIdempotencyKey() } : op;
}

/**
 * Gives every unacked create an idempotency key — for outboxes persisted before keys existed.
 * Returns the same state when nothing changed.
 */
export function ensureIdempotencyKeys(s: OutboxState): OutboxState {
  if (!s.entries.some((e) => e.state !== "acked" && isCreator(e.op) && !e.op.idemKey)) return s;
  return { ...s, entries: s.entries.map((e) => (e.state === "acked" ? e : { ...e, op: withIdempotencyKey(e.op) })) };
}

// ---------------------------------------------------------------------------
// Temporary ids
// ---------------------------------------------------------------------------

const isExerciseRef = (key: string) => key === "exerciseId" || key.endsWith("ExerciseId");
const SEEN_MAX = /^max-(-\d+)$/;

/** Deep-maps every exercise reference (`exerciseId`, `primaryExerciseId`, …), keeping identity when nothing changes. */
function mapRefs(v: unknown, f: (id: number) => number): unknown {
  if (Array.isArray(v)) {
    let out: unknown[] | null = null;
    v.forEach((x, i) => {
      const y = mapRefs(x, f);
      if (y !== x) (out ??= [...v])[i] = y;
    });
    return out ?? v;
  }
  if (v && typeof v === "object") {
    let out: Record<string, unknown> | null = null;
    for (const [k, x] of Object.entries(v)) {
      const y = isExerciseRef(k) && typeof x === "number" ? f(x) : mapRefs(x, f);
      if (y !== x) (out ??= { ...(v as Record<string, unknown>) })[k] = y;
    }
    return out ?? v;
  }
  return v;
}

/** Replaces temp ids the server has since assigned real ids to. */
export function remapOp(op: Op, map: Record<string, number>): Op {
  const f = (id: number) => (id < 0 ? (map[id] ?? id) : id);
  switch (op.kind) {
    case "deleteMax":
    case "updateExercise": {
      const id = f(op.id);
      return id === op.id ? op : { ...op, id };
    }
    case "seen": {
      let changed = false;
      const keys = op.keys.map((k) => {
        const m = SEEN_MAX.exec(k);
        const real = m ? map[m[1]!] : undefined;
        if (real === undefined) return k;
        changed = true;
        return `max-${real}`;
      });
      return changed ? { ...op, keys } : op;
    }
    case "createExercise":
      return op;
    default:
      return mapRefs(op, f) as Op;
  }
}

/** Temp ids an op refers to (other than one it creates itself). */
export function tempRefs(op: Op): number[] {
  const out: number[] = [];
  if ((op.kind === "deleteMax" || op.kind === "updateExercise") && op.id < 0) out.push(op.id);
  if (op.kind === "seen")
    for (const k of op.keys) {
      const m = SEEN_MAX.exec(k);
      if (m) out.push(Number(m[1]));
    }
  if (op.kind !== "createExercise")
    mapRefs(op, (id) => {
      if (id < 0) out.push(id);
      return id;
    });
  return out;
}

// ---------------------------------------------------------------------------
// Queue operations
// ---------------------------------------------------------------------------

/**
 * Appends an op, coalescing it with the latest unsent op on the same resource (which then
 * moves to the end, after anything it may depend on). An entry that is in flight is never touched.
 */
export function addOp(s: OutboxState, input: Op, inflight: number | null): OutboxState {
  let op = withIdempotencyKey(remapOp(input, s.tempMap));
  const entries = [...s.entries];

  // Deleting something that was never sent: drop both.
  if (op.kind === "deleteMax" && op.id < 0) {
    const tempId = op.id;
    const i = entries.findIndex((e) => e.state !== "acked" && e.op.kind === "addMax" && e.op.tempId === tempId);
    if (i >= 0 && entries[i]!.seq !== inflight) {
      entries.splice(i, 1);
      return { ...s, entries };
    }
  }

  const key = opKey(op);
  if (key) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      if (e.state === "acked" || opKey(e.op) !== key) continue;
      if (e.seq !== inflight) {
        entries.splice(i, 1);
        op = merge(e.op, op);
      }
      break;
    }
  }
  entries.push({ seq: s.nextSeq, op, state: "pending" });
  return { ...s, entries, nextSeq: s.nextSeq + 1 };
}

/** The next entry to send: pending, and not waiting on a row it references being created. */
export function nextSendable(entries: readonly Entry[]): Entry | undefined {
  const unresolved = new Set<number>();
  for (const e of entries) if (e.state !== "acked" && isCreator(e.op)) unresolved.add(e.op.tempId);
  return entries.find((e) => e.state === "pending" && !tempRefs(e.op).some((t) => unresolved.has(t)));
}

/** Marks an entry acked with the server's response, remapping temp ids in everything still queued. */
export function ackEntry(s: OutboxState, seq: number, result: unknown): OutboxState {
  const e = s.entries.find((x) => x.seq === seq);
  if (!e) return s;
  let tempMap = s.tempMap;
  if (isCreator(e.op) && result && typeof (result as { id?: unknown }).id === "number") {
    const pairs: [string, number][] = Object.entries({ ...tempMap, [e.op.tempId]: (result as { id: number }).id });
    tempMap = Object.fromEntries(pairs.slice(-200));
  }
  const entries = s.entries.map((x) => {
    if (x.seq === seq) return { ...x, state: "acked" as const, result, ackNo: s.nextAck, error: undefined };
    if (x.state === "acked" || tempMap === s.tempMap) return x;
    const op = remapOp(x.op, tempMap);
    return op === x.op ? x : { ...x, op };
  });
  return { ...s, entries, tempMap, nextAck: s.nextAck + 1 };
}

export function failEntry(s: OutboxState, seq: number, error: string): OutboxState {
  return { ...s, entries: s.entries.map((e) => (e.seq === seq ? { ...e, state: "failed" as const, error } : e)) };
}

export function retryFailed(s: OutboxState): OutboxState {
  if (!s.entries.some((e) => e.state === "failed")) return s;
  return { ...s, entries: s.entries.map((e) => (e.state === "failed" ? { ...e, state: "pending" as const, error: undefined } : e)) };
}

/** Drops failed entries, and anything that depends on a row a dropped entry would have created. */
export function discardFailed(s: OutboxState): OutboxState {
  const dropped = new Set<number>();
  for (const e of s.entries) if (e.state === "failed" && isCreator(e.op)) dropped.add(e.op.tempId);
  const entries = s.entries.filter((e) => e.state !== "failed" && !(e.state !== "acked" && tempRefs(e.op).some((t) => dropped.has(t))));
  return { ...s, entries };
}

/** Removes acked entries (their results are now part of a persisted base). */
export function pruneAcked(s: OutboxState, seqs: ReadonlySet<number>): OutboxState {
  if (!s.entries.some((e) => e.state === "acked" && seqs.has(e.seq))) return s;
  return { ...s, entries: s.entries.filter((e) => !(e.state === "acked" && seqs.has(e.seq))) };
}

export const unsynced = (s: OutboxState) => s.entries.filter((e) => e.state !== "acked");

/** Dates with an unsynced day-log or workout edit (pending or failed). */
export function pendingDates(entries: readonly Entry[]): Set<string> {
  const out = new Set<string>();
  for (const e of entries) if (e.state !== "acked" && (e.op.kind === "day" || e.op.kind === "session")) out.add(e.op.date);
  return out;
}

// ---------------------------------------------------------------------------
// Applying ops and results
// ---------------------------------------------------------------------------

const byDate = (a: { date: string }, b: { date: string }) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

function upsertByDate<T extends { date: string }>(xs: T[], x: T): T[] {
  const i = xs.findIndex((y) => y.date === x.date);
  if (i < 0) return [...xs, x].sort(byDate);
  const out = [...xs];
  out[i] = x;
  return out;
}

function upsertById<T extends { id: number }>(xs: T[], x: T): T[] {
  const i = xs.findIndex((y) => y.id === x.id);
  if (i < 0) return [...xs, x];
  const out = [...xs];
  out[i] = x;
  return out;
}

function addKeys(seen: string[], keys: string[]): string[] {
  const have = new Set(seen);
  const fresh = keys.filter((k) => !have.has(k));
  return fresh.length ? [...seen, ...fresh] : seen;
}

/** The local (optimistic) effect of an op. Touches only `collOf(op)`. */
export function applyOp(b: Bootstrap, op: Op): Bootstrap {
  switch (op.kind) {
    case "day": {
      const existing = b.days.find((d) => d.date === op.date);
      return { ...b, days: upsertByDate(b.days, { ...(existing ?? emptyDayLog(op.date)), ...op.patch }) };
    }
    case "session":
      return {
        ...b,
        sessions: op.doc ? upsertByDate(b.sessions, op.doc) : b.sessions.filter((s) => s.date !== op.date),
      };
    case "settings":
      return { ...b, settings: op.settings };
    case "addMax": {
      if (b.maxEntries.some((e) => e.id === op.tempId)) return b;
      const { tempId, kind: _k, idemKey: _i, ...rest } = op;
      return { ...b, maxEntries: [...b.maxEntries, { id: tempId, ...rest }] };
    }
    case "deleteMax":
      return { ...b, maxEntries: b.maxEntries.filter((e) => e.id !== op.id) };
    case "createExercise": {
      if (b.exercises.some((e) => e.id === op.tempId)) return b;
      const { tempId, kind: _k, idemKey: _i, ...rest } = op;
      return { ...b, exercises: [...b.exercises, { id: tempId, archived: false, ...rest }] };
    }
    case "updateExercise":
      return { ...b, exercises: b.exercises.map((e) => (e.id === op.id ? { ...e, ...op.patch } : e)) };
    case "seen":
      return { ...b, seenAchievements: addKeys(b.seenAchievements, op.keys) };
  }
}

/** The server-confirmed effect of an acked op, given its response body. */
export function applyResult(b: Bootstrap, op: Op, result: unknown): Bootstrap {
  switch (op.kind) {
    case "day":
      return result ? { ...b, days: upsertByDate(b.days, result as DayLog) } : applyOp(b, op);
    case "session":
      return op.doc && result ? { ...b, sessions: upsertByDate(b.sessions, result as Session) } : applyOp(b, op);
    case "settings":
      return { ...b, settings: (result as Settings | null) ?? op.settings };
    case "addMax":
      if (!result) return b;
      return {
        ...b,
        maxEntries: upsertById(
          b.maxEntries.filter((e) => e.id !== op.tempId),
          result as MaxEntry,
        ),
      };
    case "createExercise":
      if (!result) return b;
      return {
        ...b,
        exercises: upsertById(
          b.exercises.filter((e) => e.id !== op.tempId),
          result as Exercise,
        ),
      };
    case "updateExercise":
      return result && typeof (result as Exercise).id === "number"
        ? { ...b, exercises: upsertById(b.exercises, result as Exercise) }
        : applyOp(b, op);
    case "deleteMax":
    case "seen":
      return applyOp(b, op);
  }
}

/** Re-applies acked results (in ack order) onto a base that may predate them. */
export function applyAcked(b: Bootstrap, entries: readonly Entry[]): Bootstrap {
  return entries
    .filter((e) => e.state === "acked")
    .sort((x, y) => (x.ackNo ?? 0) - (y.ackNo ?? 0))
    .reduce((acc, e) => applyResult(acc, e.op, e.result), b);
}

// ---------------------------------------------------------------------------
// Overlay
// ---------------------------------------------------------------------------

export type OverlayCache = Partial<Record<Coll, { base: unknown; key: string; value: unknown }>>;

/**
 * base + every unsynced op, recomputing only collections whose inputs changed so untouched
 * collections keep their identity (memoized consumers don't recompute).
 */
export function overlay(base: Bootstrap, entries: readonly Entry[], cache: OverlayCache, prev?: Bootstrap): Bootstrap {
  const live = entries.filter((e) => e.state !== "acked");
  const out = { ...base } as Record<Coll, unknown>;
  for (const c of COLLS) {
    const ops = live.filter((e) => collOf(e.op) === c);
    const key = ops.map((e) => e.seq).join(",");
    const hit = cache[c];
    if (hit && hit.base === base[c] && hit.key === key) {
      out[c] = hit.value;
      continue;
    }
    const value = ops.length ? ops.reduce((acc, e) => applyOp(acc, e.op), base)[c] : base[c];
    cache[c] = { base: base[c], key, value };
    out[c] = value;
  }
  const next = out as unknown as Bootstrap;
  if (prev && COLLS.every((c) => prev[c] === next[c])) return prev;
  return next;
}

/** Short label for messages ("Couldn't save your workout"). */
export function describe(op: Op): string {
  switch (op.kind) {
    case "day":
      return `your log for ${op.date}`;
    case "session":
      return op.doc ? `your workout for ${op.date}` : `the workout deletion for ${op.date}`;
    case "settings":
      return "your settings";
    case "addMax":
      return "a new max";
    case "deleteMax":
      return "a max deletion";
    case "createExercise":
      return `the exercise “${op.name}”`;
    case "updateExercise":
      return "an exercise change";
    case "seen":
      return "achievements";
  }
}

/** Title-style label for a list of unsynced changes ("Log · Nov 2", "Workout · Nov 3", "New max"). */
export function opLabel(op: Op): string {
  switch (op.kind) {
    case "day":
      return `Log · ${formatShortDate(op.date)}`;
    case "session":
      return op.doc ? `Workout · ${formatShortDate(op.date)}` : `Deleted workout · ${formatShortDate(op.date)}`;
    case "settings":
      return "Settings";
    case "addMax":
      return `New max · ${op.valueLb} lb`;
    case "deleteMax":
      return "Deleted max";
    case "createExercise":
      return `New exercise · ${op.name}`;
    case "updateExercise":
      return "Exercise change";
    case "seen":
      return "Achievements seen";
  }
}

export interface OpRequest {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

const idemHeaders = (op: { idemKey?: string }) => (op.idemKey ? { "Idempotency-Key": op.idemKey } : undefined);

export function request(op: Op): OpRequest {
  switch (op.kind) {
    case "day":
      return { method: "PUT", path: `/days/${op.date}`, body: op.patch };
    case "session":
      return op.doc ? { method: "PUT", path: `/sessions/${op.date}`, body: op.doc } : { method: "DELETE", path: `/sessions/${op.date}` };
    case "settings":
      return { method: "PUT", path: "/settings", body: op.settings };
    case "addMax":
      return {
        method: "POST",
        path: `/exercises/${op.exerciseId}/maxes`,
        body: { date: op.date, valueLb: op.valueLb, source: op.source, note: op.note },
        headers: idemHeaders(op),
      };
    case "deleteMax":
      return { method: "DELETE", path: `/maxes/${op.id}` };
    case "createExercise":
      return {
        method: "POST",
        path: "/exercises",
        body: { name: op.name, category: op.category, measure: op.measure, tracksMax: op.tracksMax },
        headers: idemHeaders(op),
      };
    case "updateExercise":
      return { method: "PATCH", path: `/exercises/${op.id}`, body: op.patch };
    case "seen":
      return { method: "POST", path: "/achievements/seen", body: { keys: op.keys } };
  }
}
