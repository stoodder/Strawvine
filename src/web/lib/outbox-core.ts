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
import { hasIllFormedText } from "../../shared/text";
import { deepEqual, fitSession, mergeSession, mergeSettingsDetailed, SESSION_LIMITS } from "./merge";
import type {
  Bootstrap,
  DayLog,
  DayLogPatch,
  Exercise,
  ExerciseCategory,
  Measure,
  MaxEntry,
  MaxSource,
  Revs,
  Session,
  Settings,
} from "../../shared/schemas";

export { deepEqual };

export type ExercisePatch = Partial<Omit<Exercise, "id">>;

/**
 * What a whole-document edit was based on, for version-checked saves: the server revision
 * (`baseRev`; null = the server had no such document; absent = unknown, so the save isn't
 * checked) and the server's document at that revision (`base`, the merge ancestor on a 409).
 */
export interface DocBase<T> {
  baseRev?: string | null;
  base?: T | null;
}

export type Op =
  | { kind: "day"; date: string; patch: DayLogPatch }
  /** `doc: null` deletes the session. */
  | ({ kind: "session"; date: string; doc: Session | null } & DocBase<Session>)
  | ({ kind: "settings"; settings: Settings } & DocBase<Settings>)
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
      /**
       * Mark the saved entry's achievement (`max-<id>`) seen in the same update that applies the
       * server's row, so no celebration can see it unseen (the caller already showed the gain).
       */
      markSeenOnAck?: boolean;
    }
  | { kind: "deleteMax"; id: number }
  | {
      kind: "createExercise";
      tempId: number;
      name: string;
      category: ExerciseCategory;
      measure: Measure;
      tracksMax: boolean;
      /** Absent on creates queued by builds from before the flag: weighted, as the server stores it. */
      weighted?: boolean;
      /** Sent as `Idempotency-Key`; assigned by `addOp` when missing. */
      idemKey?: string;
    }
  | { kind: "updateExercise"; id: number; patch: ExercisePatch }
  | { kind: "seen"; keys: string[] };

export interface Entry {
  /**
   * Unique, increasing; a coalesced edit gets a fresh seq (it moves to the end of the queue).
   * Seqs carry the allocating tab's number in their low bits (see `TAB_SPACE`), so two windows
   * never hand out the same one.
   */
  seq: number;
  /** Bumped whenever the entry changes (state, remapped ids): the newer copy wins a cross-tab merge. */
  rev?: number;
  op: Op;
  state: "pending" | "failed" | "acked";
  /** Readable reason for a `failed` entry. */
  error?: string;
  /** Server response of an `acked` entry. */
  result?: unknown;
  /** Order in which entries were acked (results must be re-applied in that order). */
  ackNo?: number;
  /** Of an acked whole-document save: the document's new server revision (null: deleted). */
  srev?: string | null;
  /** Of an acked write: the dataset version before and after it (`x-dataset-etag-prev` / `x-dataset-etag`). */
  etags?: AckEtags;
  /** Of an acked exercise create: its `weighted: false` follow-up is queued (see `queueWeightedFixes`). */
  weightedFix?: boolean;
  /**
   * Of an unacked whole-document save or delete: a request carrying this very op has gone out
   * (`markSending`), and nothing since has shown the server didn't apply it — the answer may
   * simply have been lost (a dropped connection, a timeout, the app killed mid-request). Nothing
   * is coalesced into such an entry (`addOp`). Cleared when a 409 rewrites the op
   * (`resolveConflict`): that request wasn't applied.
   */
  tried?: boolean;
}

export interface AckEtags {
  /** Missing when the server couldn't tell (the write wasn't serialised). */
  prev: string | null;
  next: string;
}

/** What a server response says besides its body. */
export interface AckMeta {
  srev?: string | null;
  etags?: AckEtags;
}

export interface OutboxState {
  entries: Entry[];
  nextSeq: number;
  nextAck: number;
  /** Next temporary (negative) id for rows created offline. */
  nextTemp: number;
  /** Temporary id → the server's id, for ops (or stale UI state) still holding a temp id. */
  tempMap: Record<string, number>;
  /** Seqs of entries removed recently (tombstones), so a merge with another tab's copy can't resurrect them. */
  removed?: number[];
  /** When this outbox was last reset (sign-out): a merge keeps only the newest generation. */
  epoch?: number;
  /** The entry some tab is sending right now (never coalesced into), and since when. */
  inflight?: { seq: number; at: number } | null;
}

export const emptyOutbox = (): OutboxState => ({ entries: [], nextSeq: 1, nextAck: 1, nextTemp: -1, tempMap: {} });

/**
 * Seqs and temp ids are `counter * TAB_SPACE + tab`: the shared counter keeps them ordered, the
 * tab number (1 … TAB_SPACE-1) keeps two windows that allocate at the same moment apart.
 * `tab = 0` (tests, single window) gives plain 1, 2, 3 ….
 */
export const TAB_SPACE = 2 ** 20;
const withTab = (counter: number, tab: number) => (tab ? counter * TAB_SPACE + tab : counter);

/** A fresh temporary (negative) id, and the state that has used it up. */
export function allocTempId(s: OutboxState, tab = 0): [number, OutboxState] {
  const id = tab ? s.nextTemp * TAB_SPACE - tab : s.nextTemp;
  return [id, { ...s, nextTemp: s.nextTemp - 1 }];
}

const MAX_TOMBSTONES = 500;
function tombstone(s: OutboxState, seqs: Iterable<number>): number[] {
  const out = [...(s.removed ?? []), ...seqs];
  return out.length > MAX_TOMBSTONES ? out.slice(-MAX_TOMBSTONES) : out;
}
const bump = (e: Entry): number => (e.rev ?? 0) + 1;

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
  // Whole-document ops: the latest document wins, based on what the first unsent edit was based on.
  if ((a.kind === "session" && b.kind === "session") || (a.kind === "settings" && b.kind === "settings")) return withDocBase(b, a);
  return b;
}

/**
 * `op` with `from`'s document base. When `from` has none (queued by a build that didn't record
 * one for deletes, or from a copy without revisions), `op` keeps its own.
 */
function withDocBase<T extends Op & DocBase<unknown>>(op: T, from: DocBase<unknown>): T {
  if (from.baseRev === undefined) return op;
  return { ...op, baseRev: from.baseRev, base: from.base ?? null };
}

/**
 * A whole-document op queued behind an unsettled entry of the same document (one in flight, or
 * one that went out and may be on the server — `maybeSent`), which it can't be merged into.
 *
 * It was made on a screen showing that entry's document — the overlay shows the entry's copy
 * whatever the device's server copy says — so it is based on what that entry is based on, not
 * on the device's server copy as of now. The two differ once a revalidation takes in another
 * device's save while the entry is still unanswered: the newer revision would then make the
 * follower's `If-Match` pass over changes its screen never showed. E.g. the tried save is
 * answered 409 and dropped for a delete queued behind it (`resolveConflict`): at the refreshed
 * revision that delete goes through and removes sets logged on the other device, without a
 * word; at the entry's revision it is refused ("…changed on another device, so it wasn't
 * deleted"). Likewise a rebuild behind a tried delete, an edit behind a tried save that is then
 * refused (4xx) and dropped, or the delete of a draft whose create never arrived while another
 * device made a workout that day (inheriting "no such document", it sends nothing).
 *
 * When the entry is acked the follower is re-based on what the server saved (`ackEntry`), and a
 * 409 re-bases it on the merged copy (`resolveConflict`) — so inheriting only matters when the
 * entry is dropped unanswered, or answered with something that proves nothing.
 *
 * The price: the tried save did reach the server (its answer was lost), the device's copy has
 * taken that save in since (a revalidation, or the retry's own 409), and the retry doesn't
 * settle it as this device's own (`savedAlready`) — because it is refused with a non-409 4xx (a
 * proxy's 403, a rule tightened since), because the server saved the document in another shape
 * than it was sent (a key it doesn't know dropped, a main-lift block normalized), or because
 * the window handling the retry runs a build from before `savedAlready`. The save is then
 * dropped for what is queued behind it, which meets this device's own save as if it were
 * another device's: a delete — let through on the refreshed revision — is answered 409 and the
 * workout kept, with the "changed on another device" notice, to be deleted again; a rebuilt
 * workout is merged with it (an exercise can show twice). Keeping too much there, rather than
 * ever deleting or overwriting work the screen never showed. (For an edit in that spot see the
 * note on `failOrSupersede`.)
 */
function behind(op: Op, ahead: Op): Op {
  if (op.kind !== "session" && op.kind !== "settings") return op;
  return withDocBase(op, ahead as DocBase<unknown>);
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
 * moves to the end, after anything it may depend on). An entry that is in flight is never
 * touched — nor a whole document that went out before and may be on the server (`maybeSent`):
 * replacing it would lose what the server may hold, the ancestor a merge needs — and the new op
 * is queued behind it. Nothing is merged into a rejected (failed) entry: a later day/exercise patch is
 * queued separately (it doesn't depend on the rejected fields), while a whole-document op
 * (session, settings) supersedes the rejected one — the caller validates it first. A document
 * replacing queued or rejected copies — or queued behind one it can't replace (`behind`) — was
 * made on what they showed, so it takes over what the first of them was based on
 * (`baseRev`/`base`), whatever the device's server copy has become since.
 *
 * Deleting a workout the server never had (its only save is still unsent — or there was none):
 * nothing is sent, and the unsent save goes too. A delete queued behind a save in flight stays
 * (it's re-based on that save when it lands).
 */
export function addOp(s: OutboxState, input: Op, inflight: number | null, tab = 0): OutboxState {
  let op = withIdempotencyKey(remapOp(input, s.tempMap));
  const entries = [...s.entries];
  const dropped: number[] = [];

  // Deleting something that was never sent: drop both.
  if (op.kind === "deleteMax" && op.id < 0) {
    const tempId = op.id;
    const i = entries.findIndex((e) => e.state !== "acked" && e.op.kind === "addMax" && e.op.tempId === tempId);
    if (i >= 0 && entries[i]!.seq !== inflight) {
      dropped.push(entries[i]!.seq);
      entries.splice(i, 1);
      return { ...s, entries, removed: tombstone(s, dropped) };
    }
  }

  const key = opKey(op);
  if (key) {
    const wholeDoc = op.kind === "session" || op.kind === "settings";
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      if (e.state === "acked" || opKey(e.op) !== key) continue;
      if (e.seq === inflight) {
        if (wholeDoc) op = behind(op, e.op);
        break;
      }
      if (e.state === "failed") {
        if (wholeDoc) {
          dropped.push(e.seq);
          entries.splice(i, 1);
          // The rejected document is what the screen showed (a merged copy, after a conflict).
          if ((e.op as DocBase<unknown>).baseRev !== undefined) op = withDocBase(op as Op & DocBase<unknown>, e.op as DocBase<unknown>);
          continue; // an older pending copy may sit before it
        }
        break;
      }
      if (wholeDoc && maybeSent(s, e)) {
        op = behind(op, e.op);
        break;
      }
      dropped.push(e.seq);
      entries.splice(i, 1);
      op = merge(e.op, op);
      break;
    }
  }
  if (op.kind === "session" && !op.doc && op.baseRev === null && !entries.some((e) => e.state !== "acked" && opKey(e.op) === key)) {
    // Nothing of it on the server: there's nothing to delete.
    return dropped.length ? { ...s, entries, removed: tombstone(s, dropped) } : s;
  }
  entries.push({ seq: withTab(s.nextSeq, tab), op, state: "pending" });
  return { ...s, entries, nextSeq: s.nextSeq + 1, ...(dropped.length ? { removed: tombstone(s, dropped) } : {}) };
}

/**
 * Whether a request carrying this pending whole-document op may have reached the server without
 * this device learning the outcome: it went out (`tried`), or — in an outbox written by a build
 * from before that mark — it is the entry a window was sending when it was killed (the stored
 * `inflight` marker still names it; an answer of any kind clears the marker).
 *
 * Why it matters: a save the server applied but never acked is, as far as this device knows, not
 * saved — its `base` is still the copy from before it. Were a later edit coalesced into it, the
 * queued document would be the later one on that old base; the retry is then answered 409 with
 * this device's own earlier save, and the three-way merge reads every field the later edit put
 * back to its old value as "not changed here" and keeps the server's — an Undo (a set un-logged,
 * a goal cleared and restored…) silently lost. Kept apart, the earlier save is settled first
 * (`savedAlready`, or a merge with the right ancestor) and the later edit is re-based on it.
 */
function maybeSent(s: OutboxState, e: Entry): boolean {
  return e.tried === true || s.inflight?.seq === e.seq;
}

/**
 * Entry `seq` is being sent now (`at`: ms since epoch): the cross-window `inflight` marker, and
 * for a whole document the lasting `tried` mark (see `maybeSent`).
 */
export function markSending(s: OutboxState, seq: number, at: number): OutboxState {
  return {
    ...s,
    inflight: { seq, at },
    entries: s.entries.map((e) =>
      e.seq === seq && !e.tried && (e.op.kind === "session" || e.op.kind === "settings") ? { ...e, tried: true, rev: bump(e) } : e,
    ),
  };
}

/**
 * Follow-ups for exercise creates the server saved weighted although they asked for unweighted:
 * windows share the outbox, and one running a build from before the flag sends a create another
 * window queued without the flag (the server then stores the default, weighted), or a retry
 * replays such a first attempt. For each acked create like that, queues `updateExercise
 * {weighted: false}` for the saved row (any build sends a patch as it is) and marks the entry
 * (`weightedFix`) so it's queued once — unless an unsent patch of that exercise already sets the
 * flag (a later choice). Returns the same state when there is nothing to do.
 */
export function queueWeightedFixes(s: OutboxState, inflight: number | null, tab = 0): OutboxState {
  const due = s.entries.filter(
    (e) =>
      e.state === "acked" &&
      !e.weightedFix &&
      e.op.kind === "createExercise" &&
      e.op.weighted === false &&
      typeof (e.result as Exercise | null)?.id === "number" &&
      (e.result as Exercise).weighted === true,
  );
  if (!due.length) return s;
  const marked = new Set(due.map((e) => e.seq));
  let next: OutboxState = {
    ...s,
    entries: s.entries.map((e) => (marked.has(e.seq) ? { ...e, weightedFix: true, rev: bump(e) } : e)),
  };
  for (const e of due) {
    const id = (e.result as Exercise).id;
    const decided = s.entries.some(
      (x) => x.state !== "acked" && x.op.kind === "updateExercise" && x.op.id === id && x.op.patch.weighted !== undefined,
    );
    if (!decided) next = addOp(next, { kind: "updateExercise", id, patch: { weighted: false } }, inflight, tab);
  }
  return next;
}

/** A workout delete with nothing to delete on the server (see `addOp`): settled without a request. */
export const isNoopDelete = (op: Op) => op.kind === "session" && !op.doc && op.baseRev === null;

/** The next entry to send: pending, and not waiting on a row it references being created. */
export function nextSendable(entries: readonly Entry[]): Entry | undefined {
  const unresolved = new Set<number>();
  for (const e of entries) if (e.state !== "acked" && isCreator(e.op)) unresolved.add(e.op.tempId);
  return entries.find((e) => e.state === "pending" && !tempRefs(e.op).some((t) => unresolved.has(t)));
}

/**
 * Marks an entry acked with the server's response, remapping temp ids in everything still queued.
 * A saved whole document also re-bases later unsent edits of it on the new revision (they were
 * made on top of this one; when the server's copy differs — a merge — they're merged onto it).
 */
export function ackEntry(s: OutboxState, seq: number, result: unknown, meta: AckMeta = {}): OutboxState {
  const e = s.entries.find((x) => x.seq === seq);
  if (!e) return s;
  let tempMap = s.tempMap;
  if (isCreator(e.op) && result && typeof (result as { id?: unknown }).id === "number") {
    const pairs: [string, number][] = Object.entries({ ...tempMap, [e.op.tempId]: (result as { id: number }).id });
    tempMap = Object.fromEntries(pairs.slice(-200));
  }
  const key = opKey(e.op);
  const at = s.entries.indexOf(e);
  const entries = s.entries.map((x, i) => {
    if (x.seq === seq)
      return {
        ...x,
        state: "acked" as const,
        result,
        ackNo: s.nextAck,
        error: undefined,
        rev: bump(x),
        ...(meta.srev !== undefined ? { srev: meta.srev } : {}),
        ...(meta.etags ? { etags: meta.etags } : {}),
      };
    if (x.state === "acked") return x;
    let op = tempMap === s.tempMap ? x.op : remapOp(x.op, tempMap);
    if (i > at && meta.srev !== undefined && key && opKey(op) === key) op = rebase(op, e.op, result, meta.srev);
    return op === x.op ? x : { ...x, op, rev: bump(x) };
  });
  return { ...s, entries, tempMap, nextAck: s.nextAck + 1 };
}

/** A later edit of the same document, re-based on what the server saved for `saved` (at revision `srev`). */
function rebase(later: Op, saved: Op, result: unknown, srev: string | null): Op {
  if (later.kind === "session" && saved.kind === "session") {
    const server = saved.doc ? ((result as Session | null) ?? saved.doc) : null;
    const doc =
      later.doc && saved.doc && server && !deepEqual(server, saved.doc)
        ? fitSession(mergeSession(saved.doc, later.doc, server)).doc
        : later.doc;
    return { ...later, doc, baseRev: srev, base: server };
  }
  if (later.kind === "settings" && saved.kind === "settings") {
    const server = (result as Settings | null) ?? saved.settings;
    const settings = deepEqual(server, saved.settings)
      ? later.settings
      : mergeSettingsDetailed(saved.settings, later.settings, server).value;
    return { ...later, settings, baseRev: srev, base: server };
  }
  return later;
}

/** The server's answer to a version-checked write that lost the race (409). */
export interface Conflict {
  /** Its current document (null: none). */
  current: unknown;
  /** That document's revision (null: none). */
  rev: string | null;
}

/**
 * A 409 that isn't a conflict at all: the server's copy is exactly the document this save
 * carries — its own earlier attempt, applied although the answer never arrived (or the same
 * document saved by another window or device). There is nothing to merge or send: the caller
 * acks the entry with the server's copy and revision, which re-bases the edits queued behind it
 * (`ackEntry`) — a delete queued behind a lost create then deletes what that create made.
 */
export function savedAlready(op: Op, c: Conflict): boolean {
  if (c.current === null || c.current === undefined || c.rev === null) return false;
  if (op.kind === "session") return !!op.doc && deepEqual(c.current, op.doc);
  if (op.kind === "settings") return deepEqual(c.current, op.settings);
  return false;
}

/**
 * In every merged resolution, `conflicts` says what the merge couldn't keep as both devices had
 * it: for settings, the lists both changed (this device's kept, e.g. "program weeks"); for a
 * workout, the unlogged work left out to fit the server's limits (`fitSession`'s notices).
 */
export type ConflictResolution =
  /** Merged onto the server's copy: send the entry again (it's next). */
  | { kind: "retry"; state: OutboxState; tookServer: boolean; conflicts: string[] }
  /** Merged and shown here, but not sent again: marked failed with `error` (Retry merges again). */
  | { kind: "failed"; state: OutboxState; tookServer: boolean; conflicts: string[]; error: string }
  /**
   * The entry was dropped: a later queued edit of the same document already carries it
   * (`later`: that edit's seq — merged too, so it's what reaches the server), or deletes it.
   */
  | { kind: "superseded"; state: OutboxState; tookServer: boolean; conflicts: string[]; later: number }
  /** A delete the server's newer copy wins over: the entry was dropped and the server's copy stands. */
  | { kind: "keptServer"; state: OutboxState }
  /** Not a conflict this can resolve: treat as a rejection. */
  | { kind: "none" };

/**
 * A 409 for entry `seq`: the document changed on the server since the edit's `baseRev`.
 *
 * - A save is merged onto the server's copy (`mergeSession` / `mergeSettings`, ancestor = the
 *   edit's `base`), brought within the server's limits (`fitSession`), and re-based on the
 *   server's revision. Later queued edits of the same document were made on top of the pre-merge
 *   copy, so they're merged onto the merged one too (ancestor = the pre-merge copy) and re-based
 *   likewise — otherwise, once the merged save lands, they'd overwrite it with what they were
 *   built on. Then: sent again (`retry`), or, when `retry` is false (a second conflict in a row)
 *   or the merge can't fit the limits, marked failed — unless a later queued edit of the same
 *   document exists, which then carries it (`superseded`). When a later queued edit deletes the
 *   document, the save is simply dropped.
 * - A delete stands only if the server's copy is still what this device last saw (`base`): then
 *   it's sent again at the new revision. Otherwise the server's copy (changed on another device)
 *   is kept and the delete is dropped (`keptServer`).
 */
export function resolveConflict(s: OutboxState, seq: number, c: Conflict, retry: boolean): ConflictResolution {
  const at = s.entries.findIndex((x) => x.seq === seq);
  const e = s.entries[at];
  if (!e || e.state === "acked") return { kind: "none" };
  const op = e.op;
  const key = opKey(op);
  const laterIdx = s.entries.flatMap((x, i) => (i > at && x.state !== "acked" && opKey(x.op) === key ? [i] : []));
  const rev = c.rev ?? null;

  if (op.kind === "session" && !op.doc) {
    const current = c.current as Session | null;
    if (!current) return { kind: "keptServer", state: removeEntries(s, [seq]) }; // already gone
    if (retry && op.base && deepEqual(current, op.base)) {
      const next: Op = { ...op, baseRev: rev, base: current };
      return { kind: "retry", state: replaceOp(s, seq, next), tookServer: false, conflicts: [] };
    }
    return { kind: "keptServer", state: removeEntries(s, [seq]) };
  }

  let next: Op;
  let pre: Session | Settings;
  let merged: Session | Settings;
  let error: string | null = null;
  let conflicts: string[] = [];
  if (op.kind === "session" && op.doc) {
    const current = c.current as Session | null;
    const fit = fitSession(current ? mergeSession(op.base ?? null, op.doc, current) : op.doc);
    error = fit.error;
    conflicts = fit.notices;
    pre = op.doc;
    merged = fit.doc;
    next = { ...op, doc: fit.doc, baseRev: rev, base: current };
  } else if (op.kind === "settings" && c.current) {
    const current = c.current as Settings;
    const m = mergeSettingsDetailed(op.base ?? null, op.settings, current);
    conflicts = m.conflicts;
    pre = op.settings;
    merged = m.value;
    next = { ...op, settings: m.value, baseRev: rev, base: current };
  } else return { kind: "none" };
  const tookServer = !deepEqual(merged, pre);

  const laterDelete = laterIdx.find((i) => {
    const o = s.entries[i]!.op;
    return o.kind === "session" && !o.doc;
  });
  if (laterDelete !== undefined) {
    return { kind: "superseded", state: removeEntries(s, [seq]), tookServer: false, conflicts: [], later: s.entries[laterDelete]!.seq };
  }

  // Later edits of this document: merged onto the merged copy, based on the server's revision.
  const laterSet = new Set(laterIdx);
  const entries = s.entries.map((x, i) => {
    if (x.seq === seq) return untried({ ...x, op: next, rev: bump(x) });
    if (!laterSet.has(i)) return x;
    const lo = x.op;
    let op2: Op = lo;
    if (lo.kind === "session" && lo.doc && next.kind === "session" && next.doc) {
      const fit = fitSession(mergeSession(pre as Session, lo.doc, next.doc));
      conflicts = [...new Set([...conflicts, ...fit.notices])];
      op2 = { ...lo, doc: fit.doc, baseRev: rev, base: next.base ?? null };
    } else if (lo.kind === "settings" && next.kind === "settings") {
      const m = mergeSettingsDetailed(pre as Settings, lo.settings, next.settings);
      conflicts = [...new Set([...conflicts, ...m.conflicts])];
      op2 = { ...lo, settings: m.value, baseRev: rev, base: next.base ?? null };
    }
    return op2 === lo ? x : { ...x, op: op2, rev: bump(x) };
  });
  let state: OutboxState = { ...s, entries };
  if (!error && retry) return { kind: "retry", state, tookServer, conflicts };
  const lastLater = laterIdx.at(-1);
  if (lastLater !== undefined) {
    return { kind: "superseded", state: removeEntries(state, [seq]), tookServer, conflicts, later: s.entries[lastLater]!.seq };
  }
  error ??= "Changed on another device again while saving — your changes are merged here; tap Retry.";
  state = failEntry(state, seq, error);
  return { kind: "failed", state, tookServer, conflicts, error };
}

/** The entry once a 409 has answered its request: the server didn't apply it, and its op is re-based on what the server has. */
function untried(e: Entry): Entry {
  if (!e.tried) return e;
  const { tried: _tried, ...rest } = e;
  return rest;
}

function replaceOp(s: OutboxState, seq: number, op: Op): OutboxState {
  return { ...s, entries: s.entries.map((x) => (x.seq === seq ? untried({ ...x, op, rev: bump(x) }) : x)) };
}

/**
 * Marks a rejected entry failed — or, for a whole document with a later queued edit of it (made
 * on top of this one, so carrying its changes), drops it: the later edit is what gets saved.
 * Returns the later edit's seq when it superseded the rejected one.
 *
 * Known gap (as in every build so far; SPEC §8): the rejection is taken as "the server doesn't
 * have this save". A save that did reach the server on an earlier attempt (its answer lost) and
 * is then refused on the retry with a non-409 4xx — a proxy or captive portal answering 403, a
 * rule tightened since — is still on the server. The later edit goes out on the base it
 * inherited (`behind`), is answered 409 with this device's own earlier save, and is merged with
 * the ancestor from before it: whatever that edit put *back* (an Undo, a set un-logged) reads as
 * "not changed here" and the server's value stays, under a "Merged changes" toast; an edit that
 * changes something else is merged correctly. The same holds for an edit made after such an
 * entry was marked failed (`addOp` replaces it, inheriting its base). Closing it means telling
 * "refused" from "refused this time" (e.g. keeping the entry's document as the ancestor of
 * what follows); not done here.
 */
export function failOrSupersede(s: OutboxState, seq: number, error: string): { state: OutboxState; supersededBy: number | null } {
  const at = s.entries.findIndex((x) => x.seq === seq);
  const e = s.entries[at];
  if (!e) return { state: s, supersededBy: null };
  if (e.op.kind === "session" || e.op.kind === "settings") {
    const key = opKey(e.op);
    for (let i = s.entries.length - 1; i > at; i--) {
      const x = s.entries[i]!;
      if (x.state !== "acked" && opKey(x.op) === key) return { state: removeEntries(s, [seq]), supersededBy: x.seq };
    }
  }
  return { state: failEntry(s, seq, error), supersededBy: null };
}

export function failEntry(s: OutboxState, seq: number, error: string): OutboxState {
  return { ...s, entries: s.entries.map((e) => (e.seq === seq ? { ...e, state: "failed" as const, error, rev: bump(e) } : e)) };
}

export function retryFailed(s: OutboxState): OutboxState {
  if (!s.entries.some((e) => e.state === "failed")) return s;
  return {
    ...s,
    entries: s.entries.map((e) => (e.state === "failed" ? { ...e, state: "pending" as const, error: undefined, rev: bump(e) } : e)),
  };
}

/**
 * Entries that can never be sent if the failed entries are discarded: unsynced entries that
 * reference a row only a failed create would have made.
 */
export function dependentsOfFailed(s: OutboxState): Entry[] {
  const dropped = new Set<number>();
  for (const e of s.entries) if (e.state === "failed" && isCreator(e.op)) dropped.add(e.op.tempId);
  if (!dropped.size) return [];
  // Transitively: a pending create that references a dropped row drops its own row too.
  const out: Entry[] = [];
  for (const e of s.entries) {
    if (e.state !== "pending" || !tempRefs(e.op).some((t) => dropped.has(t))) continue;
    out.push(e);
    if (isCreator(e.op)) dropped.add(e.op.tempId);
  }
  return out;
}

/** Drops the failed entries — only those, plus entries that depend on a row a dropped create would have made. */
export function discardFailed(s: OutboxState): OutboxState {
  const gone = new Set<number>([
    ...s.entries.filter((e) => e.state === "failed").map((e) => e.seq),
    ...dependentsOfFailed(s).map((e) => e.seq),
  ]);
  if (!gone.size) return s;
  return { ...s, entries: s.entries.filter((e) => !gone.has(e.seq)), removed: tombstone(s, gone) };
}

/** Removes acked entries (their results are now part of a persisted base). */
export function pruneAcked(s: OutboxState, seqs: ReadonlySet<number>): OutboxState {
  const gone = s.entries.filter((e) => e.state === "acked" && seqs.has(e.seq)).map((e) => e.seq);
  if (!gone.length) return s;
  const set = new Set(gone);
  return { ...s, entries: s.entries.filter((e) => !set.has(e.seq)), removed: tombstone(s, gone) };
}

/** Removes entries outright (e.g. rejected bookkeeping), leaving tombstones. */
export function removeEntries(s: OutboxState, seqs: readonly number[]): OutboxState {
  const set = new Set(seqs);
  if (!s.entries.some((e) => set.has(e.seq))) return s;
  return { ...s, entries: s.entries.filter((e) => !set.has(e.seq)), removed: tombstone(s, seqs) };
}

/**
 * Merges this tab's outbox with the copy another tab wrote (localStorage is the source of
 * truth, but two windows can write it moments apart). Entries are united by seq minus
 * tombstones; for an entry both have, an acked copy beats an unacked one, else the higher
 * `rev` wins. A newer `epoch` (a sign-out reset) replaces the older generation wholesale.
 * Returns `local` itself when the stored copy adds nothing.
 */
export function mergeOutbox(local: OutboxState, stored: OutboxState): OutboxState {
  const le = local.epoch ?? 0;
  const se = stored.epoch ?? 0;
  if (le !== se) return se > le ? stored : local;
  const removedSet = new Set([...(local.removed ?? []), ...(stored.removed ?? [])]);
  const bySeq = new Map<number, Entry>();
  for (const e of local.entries) if (!removedSet.has(e.seq)) bySeq.set(e.seq, e);
  for (const r of stored.entries) {
    if (removedSet.has(r.seq)) continue;
    const l = bySeq.get(r.seq);
    if (!l) bySeq.set(r.seq, r);
    else if ((l.state === "acked") !== (r.state === "acked")) bySeq.set(r.seq, l.state === "acked" ? l : r);
    else if ((r.rev ?? 0) > (l.rev ?? 0)) bySeq.set(r.seq, r);
  }
  const entries = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  const inflight =
    !local.inflight || (stored.inflight && stored.inflight.at > local.inflight.at) ? (stored.inflight ?? null) : local.inflight;
  const removed = [...removedSet];
  const merged: OutboxState = {
    entries,
    nextSeq: Math.max(local.nextSeq, stored.nextSeq),
    nextAck: Math.max(local.nextAck, stored.nextAck),
    nextTemp: Math.min(local.nextTemp, stored.nextTemp),
    tempMap: Object.fromEntries(Object.entries({ ...stored.tempMap, ...local.tempMap }).slice(-200)),
    removed: removed.length > MAX_TOMBSTONES ? removed.slice(-MAX_TOMBSTONES) : removed,
    epoch: le,
    inflight,
  };
  const same =
    entries.length === local.entries.length &&
    entries.every((e, i) => e === local.entries[i]) &&
    merged.nextSeq === local.nextSeq &&
    merged.nextAck === local.nextAck &&
    merged.nextTemp === local.nextTemp &&
    Object.keys(merged.tempMap).length === Object.keys(local.tempMap).length &&
    (merged.removed?.length ?? 0) === (local.removed?.length ?? 0) &&
    (inflight?.seq ?? null) === (local.inflight?.seq ?? null) &&
    (inflight?.at ?? null) === (local.inflight?.at ?? null);
  return same ? local : merged;
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

/**
 * `next`, but reusing `prev` (and, for arrays, `prev`'s elements) wherever the contents are
 * equal — so memoized consumers don't recompute years of history for an unchanged value.
 */
export function shareEqual<T>(prev: T | undefined, next: T): T {
  if (prev === undefined || prev === next) return prev ?? next;
  if (Array.isArray(prev) && Array.isArray(next)) {
    let same = prev.length === next.length;
    let out: unknown[] | null = null;
    for (let i = 0; i < next.length; i++) {
      const x = next[i];
      const p = i < prev.length ? prev[i] : undefined;
      if (p === x) continue;
      if (p !== undefined && deepEqual(p, x)) {
        (out ??= [...next])[i] = p;
        continue;
      }
      same = false;
    }
    return same ? prev : ((out ?? next) as T);
  }
  return deepEqual(prev, next) ? prev : next;
}

function upsertByDate<T extends { date: string }>(xs: T[], x: T): T[] {
  const i = xs.findIndex((y) => y.date === x.date);
  if (i < 0) return [...xs, x].sort(byDate);
  if (deepEqual(xs[i], x)) return xs; // the server confirmed what we have: keep identity
  const out = [...xs];
  out[i] = x;
  return out;
}

function upsertById<T extends { id: number }>(xs: T[], x: T): T[] {
  const i = xs.findIndex((y) => y.id === x.id);
  if (i < 0) return [...xs, x];
  if (deepEqual(xs[i], x)) return xs;
  const out = [...xs];
  out[i] = x;
  return out;
}

/** The server revisions after an acked save (`srev`), or `revs` itself when nothing changes. */
function withRev(revs: Revs | undefined, op: Op, srev: string | null | undefined): Revs | undefined {
  if (srev === undefined || !revs) return revs;
  if (op.kind === "settings") return srev === null || revs.settings === srev ? revs : { ...revs, settings: srev };
  if (op.kind !== "session") return revs;
  if (srev === null) {
    if (!(op.date in revs.sessions)) return revs;
    const { [op.date]: _gone, ...sessions } = revs.sessions;
    return { ...revs, sessions };
  }
  return revs.sessions[op.date] === srev ? revs : { ...revs, sessions: { ...revs.sessions, [op.date]: srev } };
}

/** The achievement key a saved max entry is celebrated under (see gamify `achievements`). */
export const maxSeenKey = (id: number) => `max-${id}`;

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
    case "session": {
      const sessions = op.doc
        ? upsertByDate(b.sessions, op.doc)
        : b.sessions.some((s) => s.date === op.date)
          ? b.sessions.filter((s) => s.date !== op.date)
          : b.sessions;
      return sessions === b.sessions ? b : { ...b, sessions };
    }
    case "settings":
      return { ...b, settings: op.settings };
    case "addMax": {
      if (b.maxEntries.some((e) => e.id === op.tempId)) return b;
      const { tempId, kind: _k, idemKey: _i, markSeenOnAck: _m, ...rest } = op;
      return { ...b, maxEntries: [...b.maxEntries, { id: tempId, ...rest }] };
    }
    case "deleteMax":
      return b.maxEntries.some((e) => e.id === op.id) ? { ...b, maxEntries: b.maxEntries.filter((e) => e.id !== op.id) } : b;
    case "createExercise": {
      if (b.exercises.some((e) => e.id === op.tempId)) return b;
      const { tempId, kind: _k, idemKey: _i, ...rest } = op;
      return { ...b, exercises: [...b.exercises, { id: tempId, archived: false, ...rest, weighted: op.weighted ?? true }] };
    }
    case "updateExercise":
      return { ...b, exercises: b.exercises.map((e) => (e.id === op.id ? { ...e, ...op.patch } : e)) };
    case "seen": {
      const seenAchievements = addKeys(b.seenAchievements, op.keys);
      return seenAchievements === b.seenAchievements ? b : { ...b, seenAchievements };
    }
  }
}

/**
 * The server-confirmed effect of an acked op, given its response body (and, for a whole-document
 * save, the document's new revision).
 */
export function applyResult(b: Bootstrap, op: Op, result: unknown, srev?: string | null): Bootstrap {
  const revs = withRev(b.revs, op, srev);
  const next = applyResultBody(b, op, result);
  return revs === next.revs ? next : { ...next, revs };
}

function applyResultBody(b: Bootstrap, op: Op, result: unknown): Bootstrap {
  switch (op.kind) {
    case "day": {
      if (!result) return applyOp(b, op);
      const days = upsertByDate(b.days, result as DayLog);
      return days === b.days ? b : { ...b, days };
    }
    case "session": {
      if (!op.doc || !result) return applyOp(b, op);
      const sessions = upsertByDate(b.sessions, result as Session);
      return sessions === b.sessions ? b : { ...b, sessions };
    }
    case "settings": {
      const next = (result as Settings | null) ?? op.settings;
      return deepEqual(b.settings, next) ? b : { ...b, settings: next };
    }
    case "addMax": {
      if (!result) return b;
      const without = b.maxEntries.some((e) => e.id === op.tempId) ? b.maxEntries.filter((e) => e.id !== op.tempId) : b.maxEntries;
      const maxEntries = upsertById(without, result as MaxEntry);
      const id = (result as MaxEntry).id;
      // In the same update as the row itself, so nothing ever sees the entry unseen.
      const seenAchievements =
        op.markSeenOnAck && typeof id === "number" ? addKeys(b.seenAchievements, [maxSeenKey(id)]) : b.seenAchievements;
      if (maxEntries === b.maxEntries && seenAchievements === b.seenAchievements) return b;
      return { ...b, maxEntries, seenAchievements };
    }
    case "createExercise": {
      if (!result) return b;
      const without = b.exercises.some((e) => e.id === op.tempId) ? b.exercises.filter((e) => e.id !== op.tempId) : b.exercises;
      const exercises = upsertById(without, result as Exercise);
      return exercises === b.exercises ? b : { ...b, exercises };
    }
    case "updateExercise": {
      if (!result || typeof (result as Exercise).id !== "number") return applyOp(b, op);
      const exercises = upsertById(b.exercises, result as Exercise);
      return exercises === b.exercises ? b : { ...b, exercises };
    }
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
    .reduce((acc, e) => applyResult(acc, e.op, e.result, e.srev), b);
}

// ---------------------------------------------------------------------------
// Overlay
// ---------------------------------------------------------------------------

export type OverlayCache = Partial<Record<Coll, { base: unknown; ops: readonly Op[]; value: unknown }>>;

const sameOps = (a: readonly Op[], b: readonly Op[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * base + every unsynced op, recomputing only collections whose inputs changed so untouched
 * collections keep their identity (memoized consumers don't recompute). The cache is keyed on
 * the ops themselves (not seqs): an op rewritten in place — e.g. a temp id remapped after its
 * create was acked — recomputes. A recomputed collection that equals what `prev` showed keeps
 * `prev`'s identity (an ack that confirms the optimistic value changes nothing on screen).
 */
export function overlay(base: Bootstrap, entries: readonly Entry[], cache: OverlayCache, prev?: Bootstrap): Bootstrap {
  const live = entries.filter((e) => e.state !== "acked");
  const out = { ...base } as Record<Coll, unknown>;
  for (const c of COLLS) {
    const ops = live
      .filter((e) => collOf(e.op) === c)
      .map((e) => (e.state === "failed" ? maskFailed(e, entries) : e.op))
      .filter((op): op is Op => op !== null);
    const hit = cache[c];
    if (hit && hit.base === base[c] && sameOps(hit.ops, ops)) {
      out[c] = hit.value;
      continue;
    }
    let value = ops.length ? ops.reduce((acc, op) => applyOp(acc, op), base)[c] : base[c];
    if (prev) value = shareEqual(prev[c], value);
    cache[c] = { base: base[c], ops, value };
    out[c] = value;
  }
  const next = out as unknown as Bootstrap;
  if (prev && COLLS.every((c) => prev[c] === next[c])) return prev;
  return next;
}

const masked = new WeakMap<Op, { sig: string; op: Op }>();

/**
 * A rejected patch, minus the fields a later edit of the same day/exercise set (acked or not):
 * the rejected value must not be shown over a newer one. Stable identity per (op, later fields).
 */
function maskFailed(e: Entry, entries: readonly Entry[]): Op | null {
  const op = e.op;
  if (op.kind === "session" || op.kind === "settings") {
    // A later copy of the document (sent or not) replaces a rejected one.
    const key = opKey(op);
    const i = entries.indexOf(e);
    return entries.some((x, n) => n > i && opKey(x.op) === key) ? null : op;
  }
  if (op.kind !== "day" && op.kind !== "updateExercise") return op;
  const key = opKey(op);
  const later = new Set<string>();
  let seen = false;
  for (const x of entries) {
    if (x === e) {
      seen = true;
      continue;
    }
    if (!seen || opKey(x.op) !== key) continue;
    const p = (x.op as { patch: object }).patch;
    for (const k of Object.keys(p)) later.add(k);
  }
  if (!later.size) return op;
  const sig = [...later].sort().join(",");
  const hit = masked.get(op);
  if (hit && hit.sig === sig) return hit.op;
  const patch = Object.fromEntries(Object.entries(op.patch).filter(([k]) => !later.has(k)));
  const next = { ...op, patch } as Op;
  masked.set(op, { sig, op: next });
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

/** The precondition of a version-checked save: `If-Match` the revision it was based on, or `If-None-Match: *`. */
function preconditionHeaders(op: DocBase<unknown>): Record<string, string> | undefined {
  if (op.baseRev === undefined) return undefined; // based on a copy without revisions: unchecked
  return op.baseRev === null ? { "If-None-Match": "*" } : { "If-Match": `"${op.baseRev}"` };
}

export function request(op: Op): OpRequest {
  switch (op.kind) {
    case "day":
      return { method: "PUT", path: `/days/${op.date}`, body: op.patch };
    case "session":
      return op.doc
        ? { method: "PUT", path: `/sessions/${op.date}`, body: op.doc, headers: preconditionHeaders(op) }
        : { method: "DELETE", path: `/sessions/${op.date}`, headers: preconditionHeaders(op) };
    case "settings":
      return { method: "PUT", path: "/settings", body: op.settings, headers: preconditionHeaders(op) };
    case "addMax":
      return {
        method: "POST",
        path: `/exercises/${op.exerciseId}/maxes`,
        // createdAt: when it was recorded on the device (the server clamps it to a sane window).
        body: {
          date: op.date,
          valueLb: op.valueLb,
          source: op.source,
          note: op.note,
          ...(op.createdAt ? { createdAt: op.createdAt } : {}),
        },
        headers: idemHeaders(op),
      };
    case "deleteMax":
      return { method: "DELETE", path: `/maxes/${op.id}` };
    case "createExercise":
      return {
        method: "POST",
        path: "/exercises",
        // `weighted` only when it turns the flag off (absent = weighted): a weighted create is sent
        // exactly as builds and servers from before the flag send and accept it — so a server rolled
        // back to one of them still takes it — and a create queued before the flag is sent as it was.
        body: {
          name: op.name,
          category: op.category,
          measure: op.measure,
          tracksMax: op.tracksMax,
          ...(op.weighted === false ? { weighted: false } : {}),
        },
        headers: idemHeaders(op),
      };
    case "updateExercise":
      return { method: "PATCH", path: `/exercises/${op.id}`, body: op.patch };
    case "seen":
      return { method: "POST", path: "/achievements/seen", body: { keys: op.keys } };
  }
}

// ---------------------------------------------------------------------------
// Cheap client-side validation (mirrors the server's limits that edits can actually hit)
// ---------------------------------------------------------------------------

const { blocks: MAX_BLOCKS, superset: MAX_SUPERSET, sets: MAX_SETS } = SESSION_LIMITS;

/**
 * Why a change with ill-formed text isn't saved. The server refuses such text (`safeString`) —
 * the database can't store it; before that rule, a workout or settings document carrying it was
 * answered with a server error on every retry and held up everything queued after it.
 */
export const BROKEN_TEXT = "The text has a broken character (half of an emoji) — delete it and save again.";

/** Why the server would reject this op, for the limits a user can run into; null if it looks fine. */
export function validateOp(op: Op): string | null {
  // Everything that would be sent. Not "seen" bookkeeping: the server's refusal drops it quietly.
  if (op.kind !== "seen" && hasIllFormedText(request(op).body)) return BROKEN_TEXT;
  switch (op.kind) {
    case "session": {
      const doc = op.doc;
      if (!doc) return null;
      if (doc.blocks.length > MAX_BLOCKS) return `A workout can have at most ${MAX_BLOCKS} blocks.`;
      for (const b of doc.blocks) {
        if (b.exercises.length < 1) return "Each block needs at least one exercise.";
        if (b.exercises.length > MAX_SUPERSET) return `A superset can have at most ${MAX_SUPERSET} exercises.`;
        for (const x of b.exercises) if (x.sets.length > MAX_SETS) return `An exercise can have at most ${MAX_SETS} sets.`;
      }
      // Sessions saved by older builds can carry null notes/labels: never throw while validating.
      if ((doc.notes ?? "").length > 20_000) return "Workout notes are too long (20,000 characters max).";
      if ((doc.label ?? "").length > 60) return "The workout name is too long (60 characters max).";
      return null;
    }
    case "day": {
      const p = op.patch;
      if (typeof p.journal === "string" && p.journal.length > 50_000) return "The journal entry is too long (50,000 characters max).";
      if (typeof p.metconNotes === "string" && p.metconNotes.length > 5000)
        return "The conditioning notes are too long (5,000 characters max).";
      return null;
    }
    case "addMax":
      if (!(op.valueLb >= 0 && op.valueLb <= 2000)) return "A max must be between 0 and 2,000 lb.";
      if (op.note && op.note.length > 500) return "The note is too long (500 characters max).";
      return null;
    case "createExercise": {
      const name = op.name.trim();
      if (!name || name.length > 80) return "An exercise name needs 1–80 characters.";
      return null;
    }
    default:
      return null;
  }
}
