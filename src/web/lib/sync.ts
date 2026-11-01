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
  failEntry,
  nextSendable,
  overlay,
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
    return { ...emptyOutbox(), ...parsed };
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
  publish();
  schedulePersist();
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

function emit() {
  const live = unsynced(ob);
  const failed = live.filter((e) => e.state === "failed");
  const next: SyncState = {
    pending: live.length,
    failed: failed.length,
    failedMessage: failed[0]?.error ?? null,
    online: onlineManager.isOnline(),
    sending: inflight !== null,
    retrying,
    authPaused,
  };
  if ((Object.keys(next) as (keyof SyncState)[]).every((k) => next[k] === syncState[k])) return;
  syncState = next;
  listeners.forEach((l) => l());
}

export const getSyncState = () => syncState;
export function subscribeSync(l: () => void) {
  listeners.add(l);
  return () => void listeners.delete(l);
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

async function run() {
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
        result = await api<unknown>(req.path, { method: req.method, body: req.body });
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
  saveOutbox();
  publish();
  schedulePersist();
  ackWaiters.get(seq)?.(result);
  ackWaiters.delete(seq);
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
