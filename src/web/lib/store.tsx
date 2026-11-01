/**
 * Client data layer. The whole (single-user) dataset is loaded once via /bootstrap and every
 * derived number is computed locally from it, so the UI responds instantly. Writes are
 * applied optimistically and sent in per-resource serial queues so they can't race.
 *
 * A bootstrap snapshot must never land on top of writes the server hasn't applied yet: it
 * would wipe the optimistic copy, and the next whole-document save (a session) would then
 * persist the stale copy. So every optimistic write cancels an in-flight fetch, fetches keep
 * the cached copy while any write is pending, and once all writes settle the cache is
 * reconciled with the server once.
 */
import { onlineManager, QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { localToday } from "../../shared/dates";
import { buildModel, type Model } from "../../shared/insights";
import type { AppData } from "../../shared/gamify";
import {
  emptyDayLog,
  type Bootstrap,
  type DayLog,
  type DayLogPatch,
  type Exercise,
  type MaxEntry,
  type MaxSource,
  type Session,
  type Settings,
} from "../../shared/schemas";
import { api, ApiError } from "./api";

export const BOOT_KEY = ["bootstrap"] as const;
const CACHE_KEY = "strawvine:bootstrap";

/** Retry only what a retry can fix (network failures, 5xx): a 4xx won't change, and a 401 would re-fire sign-out. */
const retryTransient = (times: number) => (failureCount: number, error: unknown) =>
  failureCount < times && !(error instanceof ApiError && error.status < 500);

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: true, retry: retryTransient(1), networkMode: "offlineFirst" },
    mutations: { retry: retryTransient(3), networkMode: "offlineFirst" },
  },
});

// TanStack assumes it starts online and only learns otherwise from an `offline` event. Opened
// offline, writes must pause until reconnect rather than use up their retries and be dropped.
onlineManager.setOnline(navigator.onLine);

function readCache(): Bootstrap | undefined {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as Bootstrap) : undefined;
  } catch {
    return undefined;
  }
}

function writeCache(data: Bootstrap) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
  } catch {
    /* storage full or unavailable — the cache is only a convenience */
  }
}

export function clearCache() {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* ignore */
  }
}

/** Latest cached session for a date (for handlers that run after an await). */
export function cachedSession(date: string): Session | null {
  return queryClient.getQueryData<Bootstrap>(BOOT_KEY)?.sessions.find((s) => s.date === date) ?? null;
}

// ---------------------------------------------------------------------------
// Pending writes vs. refetches
// ---------------------------------------------------------------------------

/** Writes in flight outside useMutation (plain api() calls). */
let directWrites = 0;
/** A fetch was cancelled or held back, or a write settled: refetch once writes are idle. */
let reconcileOwed = false;
let reconcileTimer: number | undefined;

/** Any write queued, paused (offline) or in flight, through useMutation or not. */
function writesPending(): boolean {
  return directWrites > 0 || queryClient.isMutating() > 0;
}

/** Refetch the bootstrap once no write is pending; deferred a tick so chained writes coalesce. */
function reconcileWhenIdle() {
  if (reconcileTimer !== undefined) return;
  reconcileTimer = window.setTimeout(() => {
    reconcileTimer = undefined;
    if (!reconcileOwed || writesPending()) return;
    reconcileOwed = false;
    void queryClient.invalidateQueries({ queryKey: BOOT_KEY });
  });
}

queryClient.getMutationCache().subscribe((event) => {
  if (event.type === "updated" && (event.action.type === "success" || event.action.type === "error")) {
    reconcileOwed = true;
    reconcileWhenIdle();
  }
});

/** Cancels an in-flight bootstrap fetch: its snapshot may predate the write being applied. */
function cancelBootFetch() {
  const state = queryClient.getQueryState(BOOT_KEY);
  if (state && state.fetchStatus !== "idle") reconcileOwed = true;
  void queryClient.cancelQueries({ queryKey: BOOT_KEY });
}

/**
 * Runs a write that bypasses useMutation, counting it as pending until it settles. Pass
 * `reconcile = false` for fire-and-forget writes: a refetch after one fails could re-trigger
 * the same write, and so on in a loop.
 */
async function trackWrite<T>(write: () => Promise<T>, reconcile = true): Promise<T> {
  directWrites++;
  cancelBootFetch();
  try {
    return await write();
  } finally {
    directWrites--;
    if (reconcile) reconcileOwed = true;
    reconcileWhenIdle();
  }
}

/** The cached copy while a write is pending (a server snapshot may predate the write). */
function heldCopy(): Bootstrap | undefined {
  const cached = queryClient.getQueryData<Bootstrap>(BOOT_KEY);
  if (!cached || !writesPending()) return undefined;
  reconcileOwed = true;
  return cached;
}

async function fetchBootstrap({ signal }: { signal: AbortSignal }): Promise<Bootstrap> {
  const held = heldCopy();
  if (held) return held;
  const data = await api<Bootstrap>("/bootstrap", { signal });
  const heldAfter = heldCopy();
  if (heldAfter) return heldAfter;
  writeCache(data);
  return data;
}

export function useBootstrapQuery(enabled: boolean) {
  return useQuery({
    queryKey: BOOT_KEY,
    queryFn: fetchBootstrap,
    enabled,
    // This device's last copy as real cache data (so edits made while it shows apply to it),
    // dated 0 so it's stale and refetched straight away.
    initialData: readCache,
    initialDataUpdatedAt: 0,
  });
}

// ---------------------------------------------------------------------------
// Context: raw data + derived model
// ---------------------------------------------------------------------------

interface DataContextValue {
  data: Bootstrap;
  today: string;
  model: Model;
}

const DataContext = createContext<DataContextValue | null>(null);

export function useToday(): string {
  const [today, setToday] = useState(localToday);
  useEffect(() => {
    const tick = () => setToday(localToday());
    const id = window.setInterval(tick, 30_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);
  return today;
}

export function DataProvider({ data, children }: { data: Bootstrap; children: ReactNode }) {
  const today = useToday();
  const model = useMemo(() => buildModel(data, today), [data, today]);
  const value = useMemo(() => ({ data, today, model }), [data, today, model]);
  useEffect(() => writeCache(data), [data]);
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): DataContextValue {
  const v = useContext(DataContext);
  if (!v) throw new Error("useData outside DataProvider");
  return v;
}

export function useAppData(): AppData {
  return useData().data;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function useUpdateBoot() {
  const qc = useQueryClient();
  return useCallback(
    (fn: (b: Bootstrap) => Bootstrap) => {
      cancelBootFetch();
      qc.setQueryData<Bootstrap>(BOOT_KEY, (b) => (b ? fn(b) : b));
    },
    [qc],
  );
}

export function useSaveDay() {
  const update = useUpdateBoot();
  const m = useMutation({
    scope: { id: "days" },
    mutationFn: ({ date, patch }: { date: string; patch: DayLogPatch }) => api<DayLog>(`/days/${date}`, { method: "PUT", body: patch }),
  });
  return useCallback(
    (date: string, patch: DayLogPatch) => {
      update((b) => {
        const existing = b.days.find((d) => d.date === date);
        const merged = { ...(existing ?? emptyDayLog(date)), ...patch };
        const days = existing
          ? b.days.map((d) => (d.date === date ? merged : d))
          : [...b.days, merged].sort((a, c) => (a.date < c.date ? -1 : 1));
        return { ...b, days };
      });
      m.mutate({ date, patch });
    },
    [m, update],
  );
}

export function useSaveSession() {
  const update = useUpdateBoot();
  const m = useMutation({
    scope: { id: "sessions" },
    mutationFn: (s: Session) => api<Session>(`/sessions/${s.date}`, { method: "PUT", body: s }),
  });
  return useCallback(
    (s: Session) => {
      update((b) => ({
        ...b,
        sessions: b.sessions.some((x) => x.date === s.date)
          ? b.sessions.map((x) => (x.date === s.date ? s : x))
          : [...b.sessions, s].sort((a, c) => (a.date < c.date ? -1 : 1)),
      }));
      m.mutate(s);
    },
    [m, update],
  );
}

export function useDeleteSession() {
  const update = useUpdateBoot();
  const m = useMutation({
    scope: { id: "sessions" },
    mutationFn: (date: string) => api(`/sessions/${date}`, { method: "DELETE" }),
  });
  return useCallback(
    (date: string) => {
      update((b) => ({ ...b, sessions: b.sessions.filter((s) => s.date !== date) }));
      m.mutate(date);
    },
    [m, update],
  );
}

export function useSaveSettings() {
  const update = useUpdateBoot();
  const m = useMutation({
    scope: { id: "settings" },
    mutationFn: (s: Settings) => api<Settings>("/settings", { method: "PUT", body: s }),
  });
  return useCallback(
    (s: Settings) => {
      update((b) => ({ ...b, settings: s }));
      return m.mutateAsync(s);
    },
    [m, update],
  );
}

let tempId = -1;

export function useAddMax() {
  const update = useUpdateBoot();
  return useCallback(
    (input: { exerciseId: number; valueLb: number; date: string; source: MaxSource; note?: string | null }) =>
      trackWrite(async () => {
        const temp: MaxEntry = {
          id: tempId--,
          exerciseId: input.exerciseId,
          date: input.date,
          valueLb: input.valueLb,
          source: input.source,
          note: input.note ?? null,
          createdAt: new Date().toISOString(),
        };
        update((b) => ({ ...b, maxEntries: [...b.maxEntries, temp] }));
        try {
          const saved = await api<MaxEntry>(`/exercises/${input.exerciseId}/maxes`, {
            method: "POST",
            body: { date: input.date, valueLb: input.valueLb, source: input.source, note: input.note ?? null },
          });
          update((b) => ({ ...b, maxEntries: b.maxEntries.map((e) => (e.id === temp.id ? saved : e)) }));
          return saved;
        } catch (e) {
          update((b) => ({ ...b, maxEntries: b.maxEntries.filter((x) => x.id !== temp.id) }));
          throw e;
        }
      }),
    [update],
  );
}

export function useDeleteMax() {
  const update = useUpdateBoot();
  return useCallback(
    (id: number) =>
      trackWrite(async () => {
        update((b) => ({ ...b, maxEntries: b.maxEntries.filter((e) => e.id !== id) }));
        // If it fails, the reconcile once writes settle brings the entry back.
        await api(`/maxes/${id}`, { method: "DELETE" }).catch(() => {});
      }),
    [update],
  );
}

export function useCreateExercise() {
  const update = useUpdateBoot();
  return useCallback(
    (input: Pick<Exercise, "name" | "category" | "measure"> & { tracksMax?: boolean }) =>
      trackWrite(async () => {
        const ex = await api<Exercise>("/exercises", { method: "POST", body: { tracksMax: false, ...input } });
        update((b) => ({ ...b, exercises: b.exercises.some((e) => e.id === ex.id) ? b.exercises : [...b.exercises, ex] }));
        return ex;
      }),
    [update],
  );
}

export function useUpdateExercise() {
  const update = useUpdateBoot();
  return useCallback(
    (id: number, patch: Partial<Omit<Exercise, "id">>) =>
      trackWrite(async () => {
        update((b) => ({ ...b, exercises: b.exercises.map((e) => (e.id === id ? { ...e, ...patch } : e)) }));
        // If it fails, the reconcile once writes settle restores the server's copy.
        await api(`/exercises/${id}`, { method: "PATCH", body: patch }).catch(() => {});
      }),
    [update],
  );
}

export function useMarkSeen() {
  const update = useUpdateBoot();
  return useCallback(
    (keys: string[]) => {
      if (!keys.length) return;
      // No reconcile of its own: after a failed attempt the refetch would bring the keys back
      // unseen, Celebrations would mark them again, fail, refetch… in a loop.
      void trackWrite(async () => {
        update((b) => ({ ...b, seenAchievements: [...new Set([...b.seenAchievements, ...keys])] }));
        await api("/achievements/seen", { method: "POST", body: { keys } }).catch(() => {});
      }, false);
    },
    [update],
  );
}
