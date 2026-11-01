/**
 * Sync engine: the durable outbox, the server-confirmed `base`, and the replay loop.
 *
 * - Every edit is appended to the outbox and written to localStorage synchronously, before any
 *   request, so it survives the app being killed (iOS evicts PWAs freely).
 * - The UI shows `overlay(base, outbox)`; server responses are applied to `base` directly, so a
 *   write never triggers a full refetch. The full dataset is re-read only on start, on focus
 *   when stale, and after errors.
 * - Replay is serial and in order. Network failures, timeouts and 5xx retry forever with capped
 *   backoff (paused while offline); a 401 pauses until sign-in; any other 4xx marks the entry
 *   "not saved" (the edit stays on screen) and raises a toast with Retry.
 * - The dataset cache lives in IndexedDB, written in the background once things settle.
 * - Creates carry an idempotency key (persisted with the op), so a retried POST whose first
 *   response was lost doesn't create the row twice.
 */
import { onlineManager, QueryClient, replaceEqualDeep } from "@tanstack/react-query";
import type { Bootstrap } from "../../shared/schemas";
import { showToast } from "../components/Toast";
import { api, ApiError, isTransient } from "./api";
import { idbDel, idbGet, idbSet } from "./idb";
import {
  ackEntry,
  addOp,
  applyAcked,
  describe,
  discardFailed as discardFailedCore,
  emptyOutbox,
  ensureIdempotencyKeys,
  failEntry,
  nextSendable,
  opLabel,
  overlay,
  pendingDates as pendingDatesOf,
  pruneAcked,
  request,
  retryFailed as retryFailedCore,
  unsynced,
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
      refetchOnWindowFocus: true,
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
/** Set when the IndexedDB copy must not be trusted (a write failed, or sign-out started a wipe). */
const CACHE_INVALID_KEY = "strawvine:cache-invalid";
const LOGOUT_WARN_KEY = "strawvine:logout-warn";
/** When everything was last known to be on the server (ms since epoch). */
const LAST_SYNCED_KEY = "strawvine:last-synced";
const BASE_KEY = "base";

let base: Bootstrap | undefined;
let displayed: Bootstrap | undefined;
let ob: OutboxState = emptyOutbox();
let inflight: number | null = null;
const overlayCache: OverlayCache = {};
/** Bumped on every ack: a snapshot fetched across an ack may predate it. */
let ackCount = 0;
let reconcileOwed = false;

// ---------------------------------------------------------------------------
// Persistence
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

let outboxWarned = false;
function saveOutbox() {
  const ok = ob.entries.length || ob.nextTemp !== -1 ? lsSet(OUTBOX_KEY, JSON.stringify(ob)) : (lsDel(OUTBOX_KEY), true);
  if (!ok && !outboxWarned) {
    outboxWarned = true;
    showToast({ message: "This device's storage is full — unsynced changes may be lost if the app closes.", tone: "warn" });
  }
}

function loadOutbox(): OutboxState {
  try {
    const raw = lsGet(OUTBOX_KEY);
    if (!raw) return emptyOutbox();
    const parsed = JSON.parse(raw) as OutboxState;
    if (!Array.isArray(parsed.entries)) return emptyOutbox();
    // Outboxes saved before idempotency keys existed: key their creates before anything is sent.
    return ensureIdempotencyKeys({ ...emptyOutbox(), ...parsed });
  } catch {
    return emptyOutbox();
  }
}

let persistTimer: number | undefined;
let persisting = false;
let persistAgain = false;

/** Writes `base` to IndexedDB, then drops the acked entries it now includes. */
async function persistBase() {
  window.clearTimeout(persistTimer);
  persistTimer = undefined;
  if (!base) return;
  if (persisting) {
    persistAgain = true;
    return;
  }
  persisting = true;
  const snapshot = base;
  const covered = new Set(ob.entries.filter((e) => e.state === "acked").map((e) => e.seq));
  try {
    await idbSet(BASE_KEY, snapshot);
    lsDel(CACHE_INVALID_KEY);
  } catch {
    // No usable cache on disk: make sure boot won't trust a stale one.
    lsSet(CACHE_INVALID_KEY, "1");
  }
  ob = pruneAcked(ob, covered);
  saveOutbox();
  persisting = false;
  if (persistAgain) {
    persistAgain = false;
    void persistBase();
  }
}

/** Debounced, off the critical path; flushed immediately when the app is hidden. */
function schedulePersist() {
  if (persistTimer !== undefined) return;
  const acked = ob.entries.filter((e) => e.state === "acked").length;
  persistTimer = window.setTimeout(
    () => {
      persistTimer = undefined;
      const idle = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
      if (idle) idle(() => void persistBase(), { timeout: 2000 });
      else void persistBase();
    },
    acked > 25 ? 0 : 4000,
  );
}

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

/** Fetches the full dataset and makes it the new base (unless it may predate an ack). */
export async function fetchBootstrap({ signal }: { signal: AbortSignal }): Promise<Bootstrap> {
  const ackAtStart = ackCount;
  const ackNoAtStart = ob.nextAck;
  const snap = await api<Bootstrap>("/bootstrap", { signal, timeoutMs: 10_000 });
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
  reconcileOwed = false;
  markSynced();
  publish();
  schedulePersist();
  if (displayed?.settings.onboarded) requestPersistentStorage();
  return displayed!;
}

function reconcile() {
  reconcileOwed = false;
  void queryClient.invalidateQueries({ queryKey: BOOT_KEY });
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
}

let syncState: SyncState = {
  pending: 0,
  failed: 0,
  failedMessage: null,
  online: true,
  sending: false,
  retrying: false,
  authPaused: false,
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
  /** When everything was last known to be on the server, or null if never on this device. */
  lastSyncedAt: number | null;
  items: SyncItem[];
}

function readLastSynced(): number | null {
  const n = Number(lsGet(LAST_SYNCED_KEY));
  return Number.isFinite(n) && n > 0 ? n : null;
}

let lastSyncedAt: number | null = readLastSynced();
let infoState: SyncInfoState = { online: true, pending: 0, failed: 0, lastSyncedAt, items: [] };
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

/** Records an edit durably, shows it, and starts sending. Returns the entry's seq. */
export function enqueue(op: Op): number {
  ob = addOp(ob, op, inflight);
  saveOutbox();
  publish();
  kick();
  return ob.nextSeq - 1;
}

/** A fresh temporary (negative) id for a row created before the server assigns one. */
export function takeTempId(): number {
  const id = ob.nextTemp;
  ob = { ...ob, nextTemp: id - 1 };
  return id;
}

/** Resolves with the server's response once `seq` is acked, or `undefined` after `ms` / when offline. */
export function waitForAck(seq: number, ms: number): Promise<unknown> {
  if (!onlineManager.isOnline() || authPaused) return Promise.resolve(undefined);
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

/** Sends what can be sent now; resolves when the loop stops (drained, offline, waiting to retry). */
function run(): Promise<void> {
  current ??= replay().finally(() => (current = null));
  return current;
}

async function replay() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      if (authPaused || !onlineManager.isOnline()) break;
      const e = nextSendable(ob.entries);
      if (!e) break;
      inflight = e.seq;
      emit();
      const req = request(e.op);
      let result: unknown;
      try {
        result = await api<unknown>(req.path, { method: req.method, body: req.body, headers: req.headers });
      } catch (err) {
        inflight = null;
        if (err instanceof ApiError && err.status === 401) {
          // api() already signalled sign-out; resume after sign-in.
          authPaused = true;
          break;
        }
        if (err instanceof ApiError && err.status === 404 && e.op.kind === "deleteMax") {
          result = null; // already gone: that's what we wanted
        } else if (!isTransient(err)) {
          onRejected(e.seq, e.op, err instanceof Error ? err.message : "Rejected by the server");
          continue;
        } else {
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
      onAcked(e.seq, result);
    }
  } finally {
    running = false;
    inflight = null;
    emit();
    if (reconcileOwed && !nextSendable(ob.entries) && !authPaused) reconcile();
  }
}

function onAcked(seq: number, result: unknown) {
  const entry = ob.entries.find((x) => x.seq === seq);
  ob = ackEntry(ob, seq, result);
  ackCount++;
  if (entry && base) {
    // Apply just this result; the overlay drops the op now that it's acked.
    base = applyAcked(base, [{ ...entry, state: "acked", result, ackNo: 0 }]);
  }
  if (!unsynced(ob).length) markSynced();
  saveOutbox();
  publish();
  schedulePersist();
  ackWaiters.get(seq)?.(result);
  ackWaiters.delete(seq);
  if (entry?.op.kind === "day") {
    pulses.set(entry.op.date, getSavedPulse(entry.op.date) + 1);
    pulseListeners.forEach((l) => l());
  }
  if (entry?.op.kind === "settings" && entry.op.settings.onboarded) requestPersistentStorage();
}

function onRejected(seq: number, op: Op, message: string) {
  if (op.kind === "seen") {
    // Bookkeeping only; not worth bothering anyone about.
    ob = { ...ob, entries: ob.entries.filter((e) => e.seq !== seq) };
    saveOutbox();
    publish();
    return;
  }
  ob = failEntry(ob, seq, message);
  saveOutbox();
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
  ob = retryFailedCore(ob);
  saveOutbox();
  publish();
  kick();
}

/** Drops rejected edits and re-reads the server's copy. */
export function discardFailed() {
  ob = discardFailedCore(ob);
  saveOutbox();
  publish();
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
 * — iOS otherwise clears PWAs' data after a while unused. Once per app load, after onboarding;
 * failures and refusals are ignored.
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

/** After sign-in: resume sending and re-read the dataset. */
export function resumeAfterLogin() {
  authPaused = false;
  failures = 0;
  emit();
  kick();
  reconcile();
}

/** On a 401. Unsynced edits are always kept; the cache is dropped only when nothing is pending. */
export function onSignedOut() {
  authPaused = true;
  emit();
  if (!hasUnsynced()) wipeLocalData();
}

/**
 * Sign-out: wipes this device's copy, unless edits are still unsynced — then they're kept (and
 * synced after the next sign-in) and the user is warned.
 */
export function clearCache() {
  const n = unsynced(ob).length;
  if (n) {
    lsSet(LOGOUT_WARN_KEY, String(n));
    showToast({ message: `${n} unsynced change${n === 1 ? "" : "s"} kept on this device — sign in again to sync.`, tone: "warn" });
    return;
  }
  wipeLocalData();
}

function wipeLocalData() {
  // Mark first (synchronously): the page may unload before the async delete completes.
  lsSet(CACHE_INVALID_KEY, "1");
  lsDel(LEGACY_CACHE_KEY);
  window.clearTimeout(persistTimer);
  persistTimer = undefined;
  base = undefined;
  displayed = undefined;
  lastSyncedAt = null;
  lsDel(LAST_SYNCED_KEY);
  ob = { ...emptyOutbox(), nextTemp: ob.nextTemp, tempMap: ob.tempMap };
  saveOutbox();
  void idbDel(BASE_KEY).catch(() => {});
  queryClient.removeQueries({ queryKey: BOOT_KEY });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, new Promise<undefined>((r) => window.setTimeout(() => r(undefined), ms))]);
}

let started = false;

/**
 * Loads this device's copy (IndexedDB) and the outbox, and shows base + pending edits before
 * the first render. Never rejects; gives up on a stuck IndexedDB after 1.5 s.
 */
export async function initSync(): Promise<void> {
  if (started) return;
  started = true;
  ob = loadOutbox();
  saveOutbox(); // persists idempotency keys given to an older outbox's creates

  let cached: Bootstrap | undefined;
  if (lsGet(CACHE_INVALID_KEY)) {
    await withTimeout(
      idbDel(BASE_KEY).catch(() => {}),
      1500,
    );
  } else {
    cached = await withTimeout(
      idbGet<Bootstrap>(BASE_KEY).catch(() => undefined),
      1500,
    );
  }
  // One-time move off the old localStorage cache (which stopped updating past ~5 MB).
  const legacy = lsGet(LEGACY_CACHE_KEY);
  if (legacy) {
    if (!cached && !lsGet(CACHE_INVALID_KEY)) {
      try {
        cached = JSON.parse(legacy) as Bootstrap;
      } catch {
        /* ignore */
      }
    }
    lsDel(LEGACY_CACHE_KEY);
  }
  if (cached?.settings && Array.isArray(cached.days)) {
    base = applyAcked(cached, ob.entries);
    publish(); // dated 0, so stale: re-read on mount
  }
  if (ob.entries.some((e) => e.state === "acked")) schedulePersist();

  const warn = lsGet(LOGOUT_WARN_KEY);
  if (warn) {
    lsDel(LOGOUT_WARN_KEY);
    window.setTimeout(
      () => showToast({ message: "You have unsynced changes on this device. Sign in to sync them.", tone: "warn", duration: 10_000 }),
      500,
    );
  }

  onlineManager.subscribe((online) => {
    emit();
    if (online) {
      failures = 0;
      kick();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void persistBase();
    else kick();
  });
  window.addEventListener("pagehide", () => void persistBase());
  kick();
}
