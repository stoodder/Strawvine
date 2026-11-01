/**
 * Client data layer. The whole (single-user) dataset is loaded once via /bootstrap and every
 * derived number is computed locally from it, so the UI responds instantly. Writes are
 * applied optimistically and sent in per-resource serial queues so they can't race.
 */
import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { api } from "./api";

export const BOOT_KEY = ["bootstrap"] as const;
const CACHE_KEY = "strawvine:bootstrap";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: true, retry: 1, networkMode: "offlineFirst" },
    mutations: { retry: 3, networkMode: "offlineFirst" },
  },
});

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

export function useBootstrapQuery(enabled: boolean) {
  return useQuery({
    queryKey: BOOT_KEY,
    queryFn: async () => {
      const data = await api<Bootstrap>("/bootstrap");
      writeCache(data);
      return data;
    },
    enabled,
    placeholderData: readCache,
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
  return useCallback((fn: (b: Bootstrap) => Bootstrap) => qc.setQueryData<Bootstrap>(BOOT_KEY, (b) => (b ? fn(b) : b)), [qc]);
}

function useResync() {
  const qc = useQueryClient();
  return useCallback(() => qc.invalidateQueries({ queryKey: BOOT_KEY }), [qc]);
}

export function useSaveDay() {
  const update = useUpdateBoot();
  const resync = useResync();
  const m = useMutation({
    scope: { id: "days" },
    mutationFn: ({ date, patch }: { date: string; patch: DayLogPatch }) => api<DayLog>(`/days/${date}`, { method: "PUT", body: patch }),
    onError: resync,
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
  const resync = useResync();
  const m = useMutation({
    scope: { id: "sessions" },
    mutationFn: (s: Session) => api<Session>(`/sessions/${s.date}`, { method: "PUT", body: s }),
    onError: resync,
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
  const resync = useResync();
  const m = useMutation({
    scope: { id: "sessions" },
    mutationFn: (date: string) => api(`/sessions/${date}`, { method: "DELETE" }),
    onError: resync,
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
  const resync = useResync();
  const m = useMutation({
    scope: { id: "settings" },
    mutationFn: (s: Settings) => api<Settings>("/settings", { method: "PUT", body: s }),
    onError: resync,
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
  const resync = useResync();
  return useCallback(
    async (input: { exerciseId: number; valueLb: number; date: string; source: MaxSource; note?: string | null }) => {
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
        void resync();
        throw e;
      }
    },
    [update, resync],
  );
}

export function useDeleteMax() {
  const update = useUpdateBoot();
  const resync = useResync();
  return useCallback(
    async (id: number) => {
      update((b) => ({ ...b, maxEntries: b.maxEntries.filter((e) => e.id !== id) }));
      await api(`/maxes/${id}`, { method: "DELETE" }).catch(resync);
    },
    [update, resync],
  );
}

export function useCreateExercise() {
  const update = useUpdateBoot();
  return useCallback(
    async (input: Pick<Exercise, "name" | "category" | "measure"> & { tracksMax?: boolean }) => {
      const ex = await api<Exercise>("/exercises", { method: "POST", body: { tracksMax: false, ...input } });
      update((b) => ({ ...b, exercises: [...b.exercises, ex] }));
      return ex;
    },
    [update],
  );
}

export function useUpdateExercise() {
  const update = useUpdateBoot();
  const resync = useResync();
  return useCallback(
    async (id: number, patch: Partial<Omit<Exercise, "id">>) => {
      update((b) => ({ ...b, exercises: b.exercises.map((e) => (e.id === id ? { ...e, ...patch } : e)) }));
      await api(`/exercises/${id}`, { method: "PATCH", body: patch }).catch(resync);
    },
    [update, resync],
  );
}

export function useMarkSeen() {
  const update = useUpdateBoot();
  return useCallback(
    (keys: string[]) => {
      if (!keys.length) return;
      update((b) => ({ ...b, seenAchievements: [...new Set([...b.seenAchievements, ...keys])] }));
      void api("/achievements/seen", { method: "POST", body: { keys } }).catch(() => {});
    },
    [update],
  );
}
