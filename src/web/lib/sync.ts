/**
 * Sync engine: the durable outbox, the server-confirmed `base`, and the replay loop.
 *
 * - Every edit is appended to the outbox and written to localStorage synchronously, before any
 *   request, so it survives the app being killed (iOS evicts PWAs freely).
 * - localStorage is the outbox's source of truth across windows (installed app + a browser
 *   tab): each change re-reads and merges the stored copy first, seqs and temp ids carry a
 *   per-tab number, a `storage` listener picks up the other window's edits, and only one
 *   window sends at a time (a Web Lock, or a lease in localStorage where locks are missing).
 *   Acks and fresh server copies are announced over a BroadcastChannel so the other window
 *   applies them at once.
 * - The UI shows `overlay(base, outbox)`; server responses are applied to `base` directly, so a
 *   write never triggers a full refetch. The dataset is revalidated (ETag, so usually a bodiless
 *   304) on start, whenever the app becomes visible, and after errors.
 * - Replay is serial and in order. Network failures, timeouts and 5xx retry forever with capped
 *   backoff (paused while offline); a 401 pauses until sign-in; any other 4xx marks the entry
 *   "not saved" (the edit stays on screen) and raises a toast with Retry.
 * - The dataset copy lives in IndexedDB, split per collection (days and sessions per year) so
 *   a write touches only what changed; written right after the first download, then in the
 *   background once things settle.
 * - Nothing cached is shown unless this device is signed in (a local flag set by a successful
 *   sign-in or download, cleared by sign-out and by a 401). Sign-out wipes the copy.
 * - Creates carry an idempotency key (persisted with the op), so a retried POST whose first
 *   response was lost doesn't create the row twice.
 */
import { onlineManager, QueryClient, replaceEqualDeep } from "@tanstack/react-query";
import type { Bootstrap } from "../../shared/schemas";
import { showToast } from "../components/Toast";
import { api, apiConditional, ApiError, flushPendingLogout, isTransient, serverLogout } from "./api";
import { idbClear, idbReadSet, idbWritePlanned } from "./idb";
import {
  ackEntry,
  addOp,
  allocTempId,
  applyAcked,
  dependentsOfFailed,
  describe,
  discardFailed as discardFailedCore,
  emptyOutbox,
  ensureIdempotencyKeys,
  failEntry,
  mergeOutbox,
  nextSendable,
  opLabel,
  overlay,
  pendingDates as pendingDatesOf,
  pruneAcked,
  removeEntries,
  request,
  retryFailed as retryFailedCore,
  TAB_SPACE,
  unsynced,
  validateOp,
  type Entry,
  type Op,
  type OutboxState,
  type OverlayCache,
} from "./outbox-core";

export const BOOT_KEY = ["bootstrap"] as const;

/** Retry only what a retry can fix (network failures, 5xx): a 4xx won't change, and a 401 would re-fire sign-out. */
const retryTransient = (times: number) => (failureCount: number, error: unknown) => failureCount < times && isTransient(error);

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60_000,
      // Revalidation on return to the app is done here (see `revalidate`), for every return.
      refetchOnWindowFocus: false,
      retry: retryTransient(2),
      networkMode: "offlineFirst",
      // The data layer keeps identities stable itself; a deep compare of years of data per write is jank.
      structuralSharing: false,
    },
  },
});

// TanStack assumes it starts online and only learns otherwise from an `offline` event.
onlineManager.setOnline(navigator.onLine);

const OUTBOX_KEY = "strawvine:outbox";
const LEGACY_CACHE_KEY = "strawvine:bootstrap";
/** Set when the IndexedDB copy must not be trusted (a write failed, or a wipe hasn't finished). */
const CACHE_INVALID_KEY = "strawvine:cache-invalid";
const LOGOUT_WARN_KEY = "strawvine:logout-warn";
/** When everything was last known to be on the server (ms since epoch). */
const LAST_SYNCED_KEY = "strawvine:last-synced";
/** "1" while this device is signed in; cached data is never shown without it. */
const SIGNED_IN_KEY = "strawvine:signed-in";
const AUTH_MIGRATED_KEY = "strawvine:signed-in-v";
/** Replay lease (`<tab>:<until ms>`) for browsers without Web Locks. */
const LEASE_KEY = "strawvine:replay-lease";
const LOCK_NAME = "strawvine-outbox";

/** Fired on window when this device signs out (here or in another window) / back in from another window. */
export const SIGNED_OUT_EVENT = "strawvine:signed-out";
export const SIGNED_IN_EVENT = "strawvine:signed-in";

/** This window's number: the low bits of the seqs and temp ids it allocates. */
const TAB = 1 + Math.floor(Math.random() * (TAB_SPACE - 1));

let base: Bootstrap | undefined;
let displayed: Bootstrap | undefined;
/** ETag of the server snapshot `base` came from (sent as If-None-Match). */
let baseEtag: string | null = null;
/** When `base` last took in server information (snapshot or ack); a persisted copy never goes back in time. */
let baseStamp = 0;
let ob: OutboxState = emptyOutbox();
/** Seq this window is sending right now. */
let inflight: number | null = null;
const overlayCache: OverlayCache = {};
/** Bumped on every ack (ours or another window's): a snapshot fetched across an ack may predate it. */
let ackCount = 0;
/** Acked seqs whose results are already in `base`. */
const appliedAcks = new Set<number>();
let reconcileOwed = false;
/** Bumped by every wipe: async work started before it must not write data back. */
let wipeGen = 0;
let lastFetchAt = 0;
/** Reading this device's copy at start-up (for the boot screen). */
let restoring = false;

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
function lsDel(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Signed-in flag
// ---------------------------------------------------------------------------

/** Whether this device is signed in as far as it knows (cached data may be shown). */
export const isSignedIn = () => lsGet(SIGNED_IN_KEY) === "1";

/** Records a successful sign-in / download. */
export function markSignedIn() {
  if (!isSignedIn()) lsSet(SIGNED_IN_KEY, "1");
}

/** Installs from before the flag existed: signed in if they've synced and didn't sign out since. */
function migrateSignedInFlag() {
  if (lsGet(AUTH_MIGRATED_KEY)) return;
  lsSet(AUTH_MIGRATED_KEY, "1");
  if (lsGet(SIGNED_IN_KEY) !== null) return;
  if (lsGet(LAST_SYNCED_KEY) && !lsGet(LOGOUT_WARN_KEY) && !lsGet(CACHE_INVALID_KEY)) lsSet(SIGNED_IN_KEY, "1");
}

// ---------------------------------------------------------------------------
// The outbox (shared by every window through localStorage)
// ---------------------------------------------------------------------------

/** The stored string `ob` was last read from or written as (skips re-parsing an unchanged copy). */
let lastRaw: string | null | undefined;
let outboxWarned = false;

function parseOutbox(raw: string | null): OutboxState {
  try {
    if (!raw) return emptyOutbox();
    const parsed = JSON.parse(raw) as OutboxState;
    if (!Array.isArray(parsed.entries)) return emptyOutbox();
    // Outboxes saved before idempotency keys existed: key their creates before anything is sent.
    return ensureIdempotencyKeys({ ...emptyOutbox(), ...parsed });
  } catch {
    return emptyOutbox();
  }
}

function saveOutbox() {
  const raw = JSON.stringify(ob);
  if (lsSet(OUTBOX_KEY, raw)) {
    lastRaw = raw;
  } else if (!outboxWarned) {
    outboxWarned = true;
    showToast({ message: "This device's storage is full — unsynced changes may be lost if the app closes.", tone: "warn" });
  }
}

/**
 * Merges in the stored copy if another window changed it since we last looked. Results the
 * other window got acked are applied to `base` here. Returns whether anything changed.
 */
function refresh(): boolean {
  const raw = lsGet(OUTBOX_KEY);
  if (raw === lastRaw) return false;
  lastRaw = raw;
  if (raw === null) return false; // nothing stored: ours is written on the next change
  const next = mergeOutbox(ob, parseOutbox(raw));
  if (next === ob) return false;
  adopt(next);
  return true;
}

/** Makes `next` the outbox, applying acks it carries that this window hasn't seen yet. */
function adopt(next: OutboxState) {
  ob = next;
  const fresh = next.entries.filter((e) => e.state === "acked" && !appliedAcks.has(e.seq)).sort((a, b) => (a.ackNo ?? 0) - (b.ackNo ?? 0));
  if (!fresh.length) return;
  ackCount++;
  if (base) {
    base = applyAcked(base, fresh);
    baseStamp = Math.max(baseStamp, Date.now());
  }
  for (const e of fresh) {
    appliedAcks.add(e.seq);
    settleAck(e.seq, e.op, e.result);
  }
}

/** Re-reads the shared copy, applies `fn`, and writes the result back (all in one task). */
function mutate(fn: (s: OutboxState) => OutboxState) {
  refresh();
  const next = fn(ob);
  if (next === ob) return;
  ob = next;
  saveOutbox();
}

/** The entry being sent by any window (a stale marker from a killed window expires). */
function sendingSeq(): number | null {
  if (inflight !== null) return inflight;
  const f = ob.inflight;
  return f && Date.now() - f.at < 30_000 ? f.seq : null;
}

// ---------------------------------------------------------------------------
// Cross-window messages
// ---------------------------------------------------------------------------

type Message =
  { type: "ack"; seq: number; op: Op; result: unknown; stamp: number } | { type: "snapshot"; stamp: number } | { type: "signed-out" };

let channel: BroadcastChannel | null = null;

function post(m: Message) {
  try {
    channel?.postMessage(m);
  } catch {
    /* closed / unclonable: the storage event still carries acks */
  }
}

function onMessage(m: Message) {
  switch (m.type) {
    case "ack": {
      if (appliedAcks.has(m.seq)) return;
      appliedAcks.add(m.seq);
      ackCount++;
      if (base) {
        base = applyAcked(base, [{ seq: m.seq, op: m.op, state: "acked", result: m.result, ackNo: 0 }]);
        baseStamp = Math.max(baseStamp, m.stamp);
      }
      refresh();
      settleAck(m.seq, m.op, m.result);
      publish();
      return;
    }
    case "snapshot":
      // Another window has a newer server copy: catch up now if we're on screen (else on return).
      if (m.stamp > baseStamp && document.visibilityState === "visible") revalidate(0);
      return;
    case "signed-out":
      if (!isSignedIn()) signedOutElsewhere();
      return;
  }
}

// ---------------------------------------------------------------------------
// The dataset copy in IndexedDB
// ---------------------------------------------------------------------------

const LEGACY_BASE_KEY = "base";
const META_KEY = "b:meta";

interface DiskMeta {
  v: 2;
  /** Every piece key of this copy. */
  keys: string[];
  stamp: number;
  etag: string | null;
  /** The window that wrote it, and its write counter: an incremental write needs both unchanged. */
  writer: number;
  wseq: number;
}

/** The dataset split into IndexedDB records: one per collection, days and sessions one per year. */
function piecesOf(b: Bootstrap): Map<string, unknown> {
  const m = new Map<string, unknown>([
    ["b:settings", b.settings],
    ["b:exercises", b.exercises],
    ["b:maxEntries", b.maxEntries],
    ["b:seen", b.seenAchievements],
  ]);
  const byYear = (prefix: string, xs: readonly { date: string }[]) => {
    let start = 0;
    for (let i = 1; i <= xs.length; i++) {
      const y = xs[start]!.date.slice(0, 4);
      if (i < xs.length && xs[i]!.date.slice(0, 4) === y) continue;
      const k = prefix + y;
      const slice = xs.slice(start, i);
      const had = m.get(k) as unknown[] | undefined;
      m.set(k, had ? [...had, ...slice] : slice);
      start = i;
    }
  };
  byYear("b:days:", b.days);
  byYear("b:sessions:", b.sessions);
  return m;
}

const byDate = (a: { date: string }, b: { date: string }) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

function joinPieces(values: Map<string, unknown>, keys: string[], prefix: string): unknown[] | null {
  const out: unknown[] = [];
  for (const k of keys.filter((k) => k.startsWith(prefix)).sort()) {
    const v = values.get(k);
    if (!Array.isArray(v)) return null;
    for (const x of v) out.push(x);
  }
  return (out as { date: string }[]).sort(byDate);
}

/** Pieces as this window last knew them to be on disk (null: unknown, write everything). */
let onDisk: { pieces: Map<string, unknown>; writer: number; wseq: number } | null = null;
/** IndexedDB holds a usable copy (so a reload offline can show data). */
let diskHasBase = false;

const samePiece = (a: unknown, b: unknown) =>
  a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]));

async function readDisk(): Promise<{ data: Bootstrap; meta?: DiskMeta } | undefined> {
  const { meta, values } = await idbReadSet<DiskMeta>(META_KEY, (m) => (m?.v === 2 ? m.keys : [LEGACY_BASE_KEY]));
  if (meta?.v === 2) {
    const settings = values.get("b:settings") as Bootstrap["settings"] | undefined;
    const exercises = values.get("b:exercises");
    const maxEntries = values.get("b:maxEntries");
    const seen = values.get("b:seen");
    const days = joinPieces(values, meta.keys, "b:days:");
    const sessions = joinPieces(values, meta.keys, "b:sessions:");
    if (!settings || !Array.isArray(exercises) || !Array.isArray(maxEntries) || !Array.isArray(seen) || !days || !sessions)
      return undefined;
    const data = { settings, exercises, maxEntries, seenAchievements: seen, days, sessions } as Bootstrap;
    return { data, meta };
  }
  const legacy = values.get(LEGACY_BASE_KEY) as Bootstrap | undefined;
  return legacy?.settings && Array.isArray(legacy.days) ? { data: legacy } : undefined;
}

let persistTimer: number | undefined;
let persisting = false;
let persistAgain = false;
/** A write failed: the next one rewrites every piece. */
let forceFull = false;

/**
 * Writes `base` to IndexedDB — only the pieces whose contents changed since this window last
 * wrote (everything when another window wrote in between) — then drops the acked entries it now
 * includes. Skipped when nothing changed, and when another window already stored a newer copy.
 */
async function persistBase(): Promise<void> {
  window.clearTimeout(persistTimer);
  persistTimer = undefined;
  if (!base || !isSignedIn()) return;
  if (persisting) {
    persistAgain = true;
    return;
  }
  persisting = true;
  const gen = wipeGen;
  const snapshot = base;
  const stamp = baseStamp;
  const etag = baseEtag;
  const covered = new Set(ob.entries.filter((e) => e.state === "acked" && appliedAcks.has(e.seq)).map((e) => e.seq));
  let outcome: "written" | "same" | "stale" | "wiped" | "failed" = "failed";
  let written: { pieces: Map<string, unknown>; wseq: number } | null = null;
  try {
    const pieces = piecesOf(snapshot);
    await idbWritePlanned<DiskMeta>(META_KEY, (meta) => {
      if (gen !== wipeGen || !isSignedIn()) {
        outcome = "wiped";
        return null;
      }
      const mine = meta?.v === 2 && onDisk && meta.writer === onDisk.writer && meta.wseq === onDisk.wseq;
      if (meta?.v === 2 && !mine && meta.stamp > stamp) {
        outcome = "stale"; // another window stored a newer copy
        return null;
      }
      const full = forceFull || !mine || !onDisk;
      const puts: [string, unknown][] = [];
      for (const [k, v] of pieces) if (full || !samePiece(onDisk!.pieces.get(k), v)) puts.push([k, v]);
      const dels = (meta?.v === 2 ? meta.keys : []).filter((k) => !pieces.has(k));
      if (!full && !puts.length && !dels.length && meta?.etag === etag) {
        outcome = "same";
        return null;
      }
      if (!meta || meta.v !== 2) dels.push(LEGACY_BASE_KEY); // one-time move off the single-record format
      const wseq = (meta?.v === 2 ? meta.wseq : 0) + 1;
      const next: DiskMeta = { v: 2, keys: [...pieces.keys()], stamp, etag, writer: TAB, wseq };
      puts.push([META_KEY, next]);
      written = { pieces, wseq };
      outcome = "written";
      return { puts, dels };
    });
  } catch {
    outcome = "failed";
  }
  persisting = false;

  if (gen !== wipeGen) {
    // Signed out while this was writing: make sure nothing it wrote survives.
    void idbClear().catch(() => {});
  } else if (outcome === "failed") {
    // No trustworthy copy on disk: boot mustn't use it, and the next write rewrites all of it.
    lsSet(CACHE_INVALID_KEY, "1");
    forceFull = true;
  } else if (outcome === "written" || outcome === "same") {
    if (written) {
      const w = written as { pieces: Map<string, unknown>; wseq: number };
      onDisk = { pieces: w.pieces, writer: TAB, wseq: w.wseq };
    }
    diskHasBase = true;
    forceFull = false;
    lsDel(CACHE_INVALID_KEY);
    if (covered.size) {
      mutate((s) => pruneAcked(s, covered));
      emit();
    }
  }
  if (persistAgain) {
    persistAgain = false;
    void persistBase();
  }
}

/** Runs `fn` when the main thread is idle (iOS has no requestIdleCallback: a short timeout yields instead). */
function whenIdle(fn: () => void) {
  const ric = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(fn, { timeout: 2000 });
  else window.setTimeout(fn, 50);
}

/**
 * Debounced and off the critical path; flushed when the app is hidden. Immediate while the
 * device has no copy yet (so a reload offline right after signing in still has data).
 */
function schedulePersist() {
  if (!isSignedIn()) return;
  const urgent = !diskHasBase || ob.entries.filter((e) => e.state === "acked").length > 25;
  if (persistTimer !== undefined) {
    if (!urgent) return;
    window.clearTimeout(persistTimer);
  }
  persistTimer = window.setTimeout(
    () => {
      persistTimer = undefined;
      if (urgent) void persistBase();
      else whenIdle(() => void persistBase());
    },
    urgent ? 0 : 4000,
  );
}

/** Writes this device's copy now (also used on page hide). Resolves when done. */
export const persistNow = () => persistBase();

// ---------------------------------------------------------------------------
// Publishing to the UI
// ---------------------------------------------------------------------------

function publish() {
  if (base) {
    const next = overlay(base, ob.entries, overlayCache, displayed);
    if (next !== displayed) {
      displayed = next;
      // Keep dataUpdatedAt = time of the last server snapshot, so local edits don't postpone a reconcile.
      queryClient.setQueryData(BOOT_KEY, next, { updatedAt: queryClient.getQueryState(BOOT_KEY)?.dataUpdatedAt ?? 0 });
    }
  }
  emit();
}

/** The data the UI shows right now (undefined until a cache or the first snapshot arrives). */
export const currentData = () => displayed;

/**
 * Revalidates the dataset: sends the ETag of the copy we have, so an unchanged dataset costs a
 * bodiless 304 (no parse). A 200 becomes the new base (unless it may predate an ack).
 */
export async function fetchBootstrap({ signal }: { signal: AbortSignal }): Promise<Bootstrap> {
  const ackAtStart = ackCount;
  const ackNoAtStart = ob.nextAck;
  const gen = wipeGen;
  const res = await apiConditional<Bootstrap>("/bootstrap", base ? baseEtag : null, { signal, timeoutMs: 10_000 });
  if (gen !== wipeGen) throw new Error("Signed out");
  lastFetchAt = Date.now();
  markSignedIn();
  if (authPaused) {
    // The server took our cookie (e.g. a sign-in in another window): resume sending.
    authPaused = false;
    kick();
  }
  if (res.status === 304) {
    if (!base || !displayed) throw new Error("Server copy unchanged, but this device has none");
    if (ackCount === ackAtStart) reconcileOwed = false;
    markSynced();
    publish();
    if (displayed.settings.onboarded) requestPersistentStorage();
    return displayed;
  }
  const snap = res.data!;
  if (ackCount !== ackAtStart) {
    if (base && displayed) {
      // A write landed while this was in flight; the snapshot may not include it. Keep what we
      // have and re-read once the outbox is idle.
      reconcileOwed = true;
      // Out of this queryFn's way (an invalidate now would cancel the fetch being resolved).
      window.setTimeout(() => {
        if (reconcileOwed && !running && !authPaused && !nextSendable(ob.entries)) reconcile();
      }, 100);
      return displayed;
    }
    base = applyAcked(
      snap,
      ob.entries.filter((e) => (e.ackNo ?? 0) >= ackNoAtStart),
    );
  } else {
    base = base ? replaceEqualDeep(base, snap) : snap;
  }
  baseEtag = res.etag;
  baseStamp = Date.now();
  for (const e of ob.entries) if (e.state === "acked") appliedAcks.add(e.seq);
  reconcileOwed = false;
  markSynced();
  publish();
  schedulePersist();
  post({ type: "snapshot", stamp: baseStamp });
  if (displayed?.settings.onboarded) requestPersistentStorage();
  return displayed!;
}

// "Sync now" and invalidations refetch the dataset even while no screen is subscribed.
queryClient.setQueryDefaults(BOOT_KEY, { queryFn: fetchBootstrap });

function reconcile() {
  reconcileOwed = false;
  void queryClient.invalidateQueries({ queryKey: BOOT_KEY });
}

/** Re-reads the dataset unless that just happened (or is happening). */
function revalidate(minGapMs = 5000) {
  if (!isSignedIn() || authPaused || !onlineManager.isOnline()) return;
  if (Date.now() - lastFetchAt < minGapMs) return;
  if (queryClient.isFetching({ queryKey: BOOT_KEY })) return;
  reconcile();
}

// ---------------------------------------------------------------------------
// Sync status (for the pill)
// ---------------------------------------------------------------------------

export interface SyncState {
  /** Edits not yet confirmed by the server (including failed ones). */
  pending: number;
  /** Edits the server rejected (4xx); still shown locally. */
  failed: number;
  failedMessage: string | null;
  online: boolean;
  /** A request is in flight. */
  sending: boolean;
  /** Last attempt hit a network error / 5xx; waiting to retry. */
  retrying: boolean;
  /** Signed out; the outbox resumes after sign-in. */
  authPaused: boolean;
  /** Still reading this device's copy at start-up. */
  restoring: boolean;
}

let syncState: SyncState = {
  pending: 0,
  failed: 0,
  failedMessage: null,
  online: true,
  sending: false,
  retrying: false,
  authPaused: false,
  restoring: false,
};
const listeners = new Set<() => void>();
let retrying = false;
let authPaused = false;

/** One unsynced change, for Settings → Sync. */
export interface SyncItem {
  /** Stable while the change is queued (an edit merged into a newer one takes that one's id). */
  id: string;
  label: string;
  /** Rejected by the server (kept locally until retried or discarded). */
  failed: boolean;
  error?: string;
}

/** Sync details for Settings (see `useSyncInfo`). */
export interface SyncInfoState {
  online: boolean;
  /** Changes waiting to be sent (not counting failed ones) — the non-failed `items`. */
  pending: number;
  /** Changes the server rejected. */
  failed: number;
  /** Every change not on the server yet: `pending + failed` (what sign-out would leave behind). */
  unsynced: number;
  /** When everything was last known to be on the server, or null if never on this device. */
  lastSyncedAt: number | null;
  items: SyncItem[];
}

function readLastSynced(): number | null {
  const n = Number(lsGet(LAST_SYNCED_KEY));
  return Number.isFinite(n) && n > 0 ? n : null;
}

let lastSyncedAt: number | null = readLastSynced();
let infoState: SyncInfoState = { online: true, pending: 0, failed: 0, unsynced: 0, lastSyncedAt, items: [] };
let datesState: Set<string> = new Set<string>();

/** Everything is on the server as of now (the outbox just drained, or a snapshot arrived). */
function markSynced() {
  lastSyncedAt = Date.now();
  lsSet(LAST_SYNCED_KEY, String(lastSyncedAt));
}

const sameItems = (a: SyncItem[], b: SyncItem[]) =>
  a.length === b.length &&
  a.every((x, i) => x.id === b[i]!.id && x.label === b[i]!.label && x.failed === b[i]!.failed && x.error === b[i]!.error);
const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

function emit() {
  const live = unsynced(ob);
  const failed = live.filter((e) => e.state === "failed");
  const online = onlineManager.isOnline();
  let changed = false;

  const next: SyncState = {
    pending: live.length,
    failed: failed.length,
    failedMessage: failed[0]?.error ?? null,
    online,
    sending: inflight !== null,
    retrying,
    authPaused,
    restoring,
  };
  if (!(Object.keys(next) as (keyof SyncState)[]).every((k) => next[k] === syncState[k])) {
    syncState = next;
    changed = true;
  }

  const items: SyncItem[] = live
    .filter((e) => e.op.kind !== "seen")
    .map((e) => ({
      id: String(e.seq),
      label: opLabel(e.op),
      failed: e.state === "failed",
      ...(e.state === "failed" && e.error ? { error: e.error } : {}),
    }));
  const info: SyncInfoState = {
    online,
    // "Seen achievement" bookkeeping isn't listed or counted (and is never marked failed).
    pending: items.length - failed.length,
    failed: failed.length,
    unsynced: items.length,
    lastSyncedAt,
    items: sameItems(items, infoState.items) ? infoState.items : items,
  };
  if ((Object.keys(info) as (keyof SyncInfoState)[]).some((k) => info[k] !== infoState[k])) {
    infoState = info;
    changed = true;
  }

  const dates = pendingDatesOf(ob.entries);
  if (!sameSet(dates, datesState)) {
    datesState = dates;
    changed = true;
  }

  if (changed) listeners.forEach((l) => l());
}

export const getSyncState = () => syncState;
export const getSyncInfo = () => infoState;
/** Dates with unsynced day-log or workout edits. Same Set instance until it changes — never mutate it. */
export const getPendingDates = () => datesState;
export function subscribeSync(l: () => void) {
  listeners.add(l);
  return () => void listeners.delete(l);
}

// "Saved" pulses: a per-date counter bumped whenever the server confirms a day-log write.
const pulses = new Map<string, number>();
const pulseListeners = new Set<() => void>();
export const getSavedPulse = (date: string) => pulses.get(date) ?? 0;
export function subscribeSavedPulse(l: () => void) {
  pulseListeners.add(l);
  return () => void pulseListeners.delete(l);
}

export const hasUnsynced = () => unsynced(ob).length > 0;

// ---------------------------------------------------------------------------
// Enqueue + replay
// ---------------------------------------------------------------------------

const ackWaiters = new Map<number, (result: unknown) => void>();

/**
 * Records an edit durably, shows it, and starts sending. Returns the entry's seq, or -1 when
 * the edit was refused (it would be rejected by the server; a toast says why) or cancelled out.
 */
export function enqueue(op: Op): number {
  const problem = validateOp(op);
  if (problem) {
    showToast({ message: `Not saved: ${problem}`, tone: "warn" });
    publish();
    return -1;
  }
  let seq = -1;
  mutate((s) => {
    const next = addOp(s, op, sendingSeq(), TAB);
    if (next.nextSeq !== s.nextSeq) seq = next.entries.at(-1)!.seq;
    return next;
  });
  publish();
  kick();
  return seq;
}

/** A fresh temporary (negative) id for a row created before the server assigns one. */
export function takeTempId(): number {
  let id = 0;
  mutate((s) => {
    const [t, next] = allocTempId(s, TAB);
    id = t;
    return next;
  });
  return id;
}

/** Resolves with the server's response once `seq` is acked, or `undefined` after `ms` / when offline. */
export function waitForAck(seq: number, ms: number): Promise<unknown> {
  if (seq < 0 || !onlineManager.isOnline() || authPaused) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const t = window.setTimeout(() => {
      ackWaiters.delete(seq);
      resolve(undefined);
    }, ms);
    ackWaiters.set(seq, (r) => {
      window.clearTimeout(t);
      resolve(r);
    });
  });
}

/** An ack (by any window) is known here: wake waiters and pulse the date. */
function settleAck(seq: number, op: Op, result: unknown) {
  ackWaiters.get(seq)?.(result);
  ackWaiters.delete(seq);
  if (op.kind === "day") {
    pulses.set(op.date, getSavedPulse(op.date) + 1);
    pulseListeners.forEach((l) => l());
  }
}

let timer: number | undefined;
let running = false;
let failures = 0;

function backoff(n: number) {
  const ms = Math.min(20_000, 1000 * 2 ** Math.min(n - 1, 5));
  return ms * (0.75 + Math.random() * 0.5);
}

export function kick() {
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timer = undefined;
  }
  void run();
}

let current: Promise<void> | null = null;
/** A kick arrived while a pass was finishing: run another one after it. */
let rerun = false;

/** Sends what can be sent now; resolves when the loop stops (drained, offline, waiting to retry, another window sending). */
function run(): Promise<void> {
  if (stopped) return Promise.resolve();
  if (current) {
    rerun = true;
    return current;
  }
  current = asLeader(replay).finally(() => {
    current = null;
    if (rerun) {
      rerun = false;
      void run();
    }
  });
  return current;
}

// ---- one sender at a time across windows ----------------------------------

/** When this window first found another one holding the send lock (0 = not waiting). */
let blockedSince = 0;
let usingLease = false;

/** The other sender seems gone (killed/frozen mid-request): its lock can be taken over. */
function holderLooksStuck() {
  const f = ob.inflight;
  return blockedSince > 0 && Date.now() - blockedSince > 45_000 && (!f || Date.now() - f.at > 45_000);
}

function takeLease(): boolean {
  const now = Date.now();
  const cur = lsGet(LEASE_KEY);
  if (cur) {
    const [tab, until] = cur.split(":").map(Number);
    if (tab !== TAB && (until ?? 0) > now) return false;
  }
  lsSet(LEASE_KEY, `${TAB}:${now + 30_000}`);
  return lsGet(LEASE_KEY)?.startsWith(`${TAB}:`) ?? false;
}
function renewLease() {
  if (usingLease) lsSet(LEASE_KEY, `${TAB}:${Date.now() + 30_000}`);
}
function releaseLease() {
  if (lsGet(LEASE_KEY)?.startsWith(`${TAB}:`)) lsDel(LEASE_KEY);
}

/**
 * Runs `fn` only if no other window is sending (Web Locks; a localStorage lease where they're
 * missing). The sender re-reads the shared outbox before every request, so it also sends this
 * window's edits; we look again shortly in case it was just finishing.
 */
async function asLeader(fn: () => Promise<void>): Promise<void> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  let got = false;
  try {
    if (locks && typeof locks.request === "function") {
      await locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
        if (!lock) return;
        got = true;
        await fn();
      });
      if (!got && holderLooksStuck()) {
        got = true;
        await locks.request(LOCK_NAME, { steal: true }, fn);
      }
    } else if (takeLease()) {
      got = true;
      usingLease = true;
      try {
        await fn();
      } finally {
        usingLease = false;
        releaseLease();
      }
    }
  } catch {
    /* our lock was stolen by a window that thought we were stuck: it carries on */
  }
  if (got) {
    blockedSince = 0;
    return;
  }
  blockedSince ||= Date.now();
  if (timer === undefined && !authPaused && onlineManager.isOnline() && nextSendable(ob.entries)) {
    timer = window.setTimeout(() => {
      timer = undefined;
      refresh();
      void run();
    }, 2000);
  }
}

async function replay() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      if (authPaused || !onlineManager.isOnline()) break;
      refresh();
      const e = nextSendable(ob.entries);
      if (!e) break;
      renewLease();
      inflight = e.seq;
      mutate((s) => ({ ...s, inflight: { seq: e.seq, at: Date.now() } }));
      emit();
      const req = request(e.op);
      let result: unknown;
      try {
        result = await api<unknown>(req.path, { method: req.method, body: req.body, headers: req.headers });
      } catch (err) {
        inflight = null;
        if (err instanceof ApiError && err.status === 401) {
          // api() already signalled sign-out; resume after sign-in.
          clearSending(e.seq);
          authPaused = true;
          break;
        }
        if (err instanceof ApiError && err.status === 404 && e.op.kind === "deleteMax") {
          result = null; // already gone: that's what we wanted
        } else if (!isTransient(err)) {
          onRejected(e.seq, e.op, err instanceof Error ? err.message : "Rejected by the server");
          continue;
        } else {
          clearSending(e.seq);
          failures++;
          retrying = true;
          emit();
          timer = window.setTimeout(() => {
            timer = undefined;
            void run();
          }, backoff(failures));
          break;
        }
      }
      inflight = null;
      failures = 0;
      retrying = false;
      onAcked(e, result);
    }
  } finally {
    running = false;
    inflight = null;
    emit();
    if (reconcileOwed && !nextSendable(ob.entries) && !authPaused) reconcile();
  }
}

function clearSending(seq: number) {
  mutate((s) => (s.inflight?.seq === seq ? { ...s, inflight: null } : s));
}

function onAcked(e: Entry, result: unknown) {
  const { seq, op } = e;
  mutate((s) => ({ ...ackEntry(s, seq, result), inflight: null }));
  ackCount++;
  if (!appliedAcks.has(seq)) {
    appliedAcks.add(seq);
    if (base) {
      // Apply just this result; the overlay drops the op now that it's acked.
      base = applyAcked(base, [{ seq, op, state: "acked", result, ackNo: 0 }]);
      baseStamp = Date.now();
    }
  }
  if (!unsynced(ob).length) markSynced();
  post({ type: "ack", seq, op, result, stamp: baseStamp });
  publish();
  schedulePersist();
  settleAck(seq, op, result);
  if (op.kind === "settings" && op.settings.onboarded) requestPersistentStorage();
}

function onRejected(seq: number, op: Op, message: string) {
  if (op.kind === "seen") {
    // Bookkeeping only; not worth bothering anyone about.
    mutate((s) => ({ ...removeEntries(s, [seq]), inflight: null }));
    publish();
    return;
  }
  mutate((s) => ({ ...failEntry(s, seq, message), inflight: null }));
  reconcileOwed = true;
  publish();
  showToast({
    message: `Couldn't save ${describe(op)}: ${message.length > 90 ? `${message.slice(0, 90)}…` : message}`,
    tone: "warn",
    action: { label: "Retry", onAction: retryFailed },
    duration: 10_000,
  });
}

/** Re-sends everything the server rejected (e.g. after a server fix). */
export function retryFailed() {
  mutate(retryFailedCore);
  publish();
  kick();
}

/**
 * Drops the rejected edits — only those (later edits queued after them stay and are sent) —
 * plus edits that can't exist without a rejected create (said in a toast), then re-reads the
 * server's copy.
 */
export function discardFailed() {
  let dependents = 0;
  mutate((s) => {
    dependents = dependentsOfFailed(s).filter((e) => e.op.kind !== "seen").length;
    return discardFailedCore(s);
  });
  publish();
  if (dependents)
    showToast({
      message: `Also removed ${dependents} change${dependents === 1 ? "" : "s"} that depended on what was discarded.`,
      tone: "warn",
    });
  reconcile();
}

/**
 * "Sync now": sends everything queued straight away (skipping any retry backoff), then re-reads
 * the server's copy. Resolves when both are done; never rejects. Failed changes stay failed.
 */
export async function syncNow(): Promise<void> {
  await run(); // let an attempt already in flight finish first
  failures = 0;
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timer = undefined;
  }
  await run();
  if (authPaused || !onlineManager.isOnline()) return;
  reconcileOwed = false;
  await queryClient.refetchQueries({ queryKey: BOOT_KEY }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Persistent storage
// ---------------------------------------------------------------------------

let persistenceAsked = false;

/**
 * Asks the browser not to evict this origin's storage (IndexedDB copy + outbox) under pressure
 * — iOS otherwise clears PWAs' data after a while unused. Once per launch (until granted: an
 * already-persisted origin isn't asked again), after onboarding; refusals are ignored.
 */
function requestPersistentStorage() {
  if (persistenceAsked) return;
  persistenceAsked = true;
  const storage = typeof navigator !== "undefined" ? navigator.storage : undefined;
  if (!storage || typeof storage.persist !== "function") return;
  void (async () => {
    try {
      if (typeof storage.persisted === "function" && (await storage.persisted())) return;
      await storage.persist();
    } catch {
      /* not supported / not allowed: nothing to do */
    }
  })();
}

// ---------------------------------------------------------------------------
// Auth + lifecycle
// ---------------------------------------------------------------------------

/** After sign-in: mark the device signed in, resume sending and re-read the dataset. */
export function resumeAfterLogin() {
  markSignedIn();
  authPaused = false;
  failures = 0;
  emit();
  kick();
  reconcile();
}

/**
 * Drops this device's copy of the dataset: memory, the query cache, IndexedDB. The outbox
 * (unsynced edits) is kept only when `keepOutbox`.
 */
function wipeLocalData({ keepOutbox }: { keepOutbox: boolean }) {
  const gen = ++wipeGen;
  // Mark first (synchronously): the page may unload before the async delete completes.
  lsSet(CACHE_INVALID_KEY, "1");
  lsDel(LEGACY_CACHE_KEY);
  window.clearTimeout(persistTimer);
  persistTimer = undefined;
  persistAgain = false;
  base = undefined;
  displayed = undefined;
  baseEtag = null;
  baseStamp = 0;
  diskHasBase = false;
  onDisk = null;
  for (const k of Object.keys(overlayCache)) delete overlayCache[k as keyof OverlayCache];
  lastSyncedAt = null;
  lsDel(LAST_SYNCED_KEY);
  if (!keepOutbox) {
    refresh();
    ob = { ...emptyOutbox(), nextSeq: ob.nextSeq, nextTemp: ob.nextTemp, epoch: Math.max(Date.now(), (ob.epoch ?? 0) + 1) };
    saveOutbox();
  }
  void queryClient.cancelQueries({ queryKey: BOOT_KEY });
  queryClient.removeQueries({ queryKey: BOOT_KEY });
  void idbClear()
    .then(() => {
      if (gen === wipeGen) lsDel(CACHE_INVALID_KEY); // the disk is empty; later writes of older work are refused
    })
    .catch(() => {});
}

/** Pauses sending and tells the app (which shows sign-in). */
function enterSignedOut() {
  authPaused = true;
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timer = undefined;
  }
  publish();
  window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
}

/** On a 401: this device is signed out. Its copy is dropped; unsynced edits are kept and resume after sign-in. */
export function onSignedOut() {
  lsDel(SIGNED_IN_KEY);
  wipeLocalData({ keepOutbox: true });
  post({ type: "signed-out" });
  authPaused = true;
  emit();
}

/** Another window signed out (it already wiped the shared storage): drop what's in memory. */
function signedOutElsewhere() {
  if (authPaused && !base) return;
  wipeLocalData({ keepOutbox: true });
  refresh(); // adopt the other window's outbox (reset, or kept)
  enterSignedOut();
}

/**
 * Signs this device out. Always wipes the local copy of the dataset (IndexedDB + query cache)
 * and the signed-in flag; unsynced edits survive only with `keepUnsynced` (they're sent after
 * the next sign-in). Then tells the server; if it can't be reached the device is still signed
 * out locally, the server sign-out is retried on next contact, and `{ ok: false, reason:
 * "offline" }` is returned.
 */
export async function signOut(opts: { keepUnsynced?: boolean } = {}): Promise<{ ok: boolean; reason?: "offline" | "error" }> {
  const kept = opts.keepUnsynced ? unsynced(ob).filter((e) => e.op.kind !== "seen").length : 0;
  lsDel(SIGNED_IN_KEY);
  if (kept) lsSet(LOGOUT_WARN_KEY, String(kept));
  else lsDel(LOGOUT_WARN_KEY);
  wipeLocalData({ keepOutbox: !!opts.keepUnsynced });
  post({ type: "signed-out" });
  enterSignedOut();
  return serverLogout();
}

/** @deprecated Use `signOut()`. Signs out keeping unsynced edits on this device. */
export function clearCache() {
  void signOut({ keepUnsynced: true });
}

type RaceResult<T> = { done: true; value: T } | { done: false };
function within<T>(p: Promise<T>, ms: number): Promise<RaceResult<T>> {
  return Promise.race([
    p.then((value) => ({ done: true as const, value })),
    new Promise<RaceResult<T>>((r) => window.setTimeout(() => r({ done: false }), ms)),
  ]);
}

/** Makes a copy read from disk the base (with acked results the disk may predate on top). */
function adoptDisk(read: { data: Bootstrap; meta?: DiskMeta }) {
  const { data, meta } = read;
  base = applyAcked(data, ob.entries);
  for (const e of ob.entries) if (e.state === "acked") appliedAcks.add(e.seq);
  baseEtag = meta?.etag ?? null;
  baseStamp = meta?.stamp ?? 0;
  diskHasBase = true;
  onDisk = meta ? { pieces: piecesOf(data), writer: meta.writer, wseq: meta.wseq } : null;
  publish(); // dated 0, so stale: re-read on mount
  if (!meta) schedulePersist(); // move a single-record copy to the per-piece format
  if (data.settings.onboarded) requestPersistentStorage();
}

let started = false;
let stopped = false;
let stopListening: AbortController | null = null;

/** Detaches listeners and the channel (tests; a page never needs it). */
export function stopSync() {
  stopped = true;
  releaseLease();
  stopListening?.abort();
  stopListening = null;
  channel?.close();
  channel = null;
  unsubscribeOnline?.();
  window.clearTimeout(persistTimer);
  window.clearTimeout(timer);
  void queryClient.cancelQueries();
  queryClient.clear();
}
let unsubscribeOnline: (() => void) | undefined;

/**
 * Loads this device's copy (IndexedDB) and the outbox, and shows base + pending edits before
 * the first render — only when this device is signed in. Never rejects; stops waiting for a
 * slow IndexedDB after 1.5 s but still adopts the copy when it arrives.
 */
export async function initSync(): Promise<void> {
  if (started) return;
  started = true;
  migrateSignedInFlag();
  lastRaw = lsGet(OUTBOX_KEY);
  ob = parseOutbox(lastRaw);
  if (lastRaw !== null && JSON.stringify(ob) !== lastRaw) saveOutbox(); // persists idempotency keys given to an older outbox's creates
  const signedIn = isSignedIn();
  authPaused = !signedIn;
  channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("strawvine") : null;
  if (channel) channel.onmessage = (ev: MessageEvent<Message>) => onMessage(ev.data);

  const gen = wipeGen;
  if (!signedIn) {
    // Signed out: this device keeps (and shows) none of the dataset.
    lsDel(LEGACY_CACHE_KEY);
    void idbClear().catch(() => {});
  } else if (lsGet(CACHE_INVALID_KEY)) {
    await within(
      idbClear().catch(() => {}),
      1500,
    );
  } else {
    restoring = true;
    const read = readDisk().catch(() => undefined);
    const first = await within(read, 1500);
    if (first.done) {
      restoring = false;
      if (first.value) adoptDisk(first.value);
    } else {
      // Slow storage: render without it, but take the copy when it arrives if nothing better has.
      void read.then((late) => {
        restoring = false;
        if (late && !base && gen === wipeGen && isSignedIn()) adoptDisk(late);
        else emit();
      });
    }
    // One-time move off the old localStorage cache (which stopped updating past ~5 MB).
    const legacy = lsGet(LEGACY_CACHE_KEY);
    if (legacy) {
      if (!base && first.done) {
        try {
          const parsed = JSON.parse(legacy) as Bootstrap;
          if (parsed?.settings && Array.isArray(parsed.days)) adoptDisk({ data: parsed });
        } catch {
          /* ignore */
        }
      }
      lsDel(LEGACY_CACHE_KEY);
    }
  }
  if (base && ob.entries.some((e) => e.state === "acked")) schedulePersist();

  const warn = lsGet(LOGOUT_WARN_KEY);
  if (warn && signedIn) lsDel(LOGOUT_WARN_KEY);
  else if (warn) {
    window.setTimeout(
      () => showToast({ message: "You have unsynced changes on this device. Sign in to sync them.", tone: "warn", duration: 10_000 }),
      500,
    );
  }

  stopListening = new AbortController();
  const opts = { signal: stopListening.signal };
  unsubscribeOnline = onlineManager.subscribe((online) => {
    emit();
    if (online) {
      failures = 0;
      void flushPendingLogout();
      kick();
    }
  });
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "hidden") {
        void persistBase();
        return;
      }
      if (refresh()) publish();
      kick();
      // Always catch up on return (a 304 when nothing changed): a stale window must not save
      // whole documents (settings, workouts) over newer ones.
      revalidate();
    },
    opts,
  );
  window.addEventListener(
    "pagehide",
    () => {
      releaseLease();
      void persistBase();
    },
    opts,
  );
  window.addEventListener(
    "storage",
    (ev) => {
      if (ev.key !== null && ev.key !== OUTBOX_KEY && ev.key !== SIGNED_IN_KEY) return;
      if (ev.key === null || ev.key === SIGNED_IN_KEY) {
        if (!isSignedIn()) {
          signedOutElsewhere();
          return;
        }
        if (authPaused) {
          // Signed in from another window.
          resumeAfterLogin();
          window.dispatchEvent(new Event(SIGNED_IN_EVENT));
        }
      }
      if (refresh()) {
        publish();
        if (nextSendable(ob.entries)) kick();
      }
    },
    opts,
  );
  void flushPendingLogout();
  emit();
  kick();
}
