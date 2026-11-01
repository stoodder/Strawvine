/**
 * Client data layer. The whole (single-user) dataset is loaded via /bootstrap and every derived
 * number is computed locally from it, so the UI responds instantly.
 *
 * Writes go through the durable outbox in ./sync: applied locally at once, persisted before any
 * request, replayed in order until the server confirms them (surviving offline periods, server
 * errors and the app being killed). The server's responses are applied to the cache directly;
 * the full dataset is only re-read on start, on focus when stale, and after errors. What the UI
 * shows is always the server's copy with unconfirmed edits on top, so a snapshot can never wipe
 * an edit the server hasn't applied yet.
 */
import { useQuery } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { localToday } from "../../shared/dates";
import { buildModel, type Model } from "../../shared/insights";
import {
  achievements as computeAchievements,
  streaks as computeStreaks,
  type Achievement,
  type AppData,
  type StreakInfo,
} from "../../shared/gamify";
import type { Bootstrap, DayLogPatch, Exercise, MaxEntry, MaxSource, Session, Settings } from "../../shared/schemas";
import {
  currentData,
  discardFailed,
  enqueue,
  fetchBootstrap,
  getPendingDates,
  getSavedPulse,
  getSyncInfo,
  retryFailed,
  subscribeSavedPulse,
  subscribeSync,
  syncNow,
  takeTempId,
  waitForAck,
  type SyncInfoState,
} from "./sync";

export { BOOT_KEY, clearCache, queryClient } from "./sync";
import { BOOT_KEY } from "./sync";

/** Latest cached session for a date (for handlers that run after an await). */
export function cachedSession(date: string): Session | null {
  return currentData()?.sessions.find((s) => s.date === date) ?? null;
}

export function useBootstrapQuery(enabled: boolean) {
  return useQuery({
    queryKey: BOOT_KEY,
    queryFn: fetchBootstrap,
    enabled,
    // This device's copy (with unsynced edits on top) as real cache data, dated 0 so it's
    // stale and re-read straight away.
    initialData: currentData,
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
  /** `achievements(data, today)`, computed once per change of the underlying data. */
  achievements: Achievement[];
  /** `streaks(data, today)`, computed once per change of the underlying data. */
  streak: StreakInfo;
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
  // Not keyed on `data` itself: marking an achievement seen must not recompute all history.
  const { settings, days, exercises, maxEntries, sessions } = data;
  const appData = useMemo<AppData>(
    () => ({ settings, days, exercises, maxEntries, sessions }),
    [settings, days, exercises, maxEntries, sessions],
  );
  const achievements = useMemo(() => computeAchievements(appData, today), [appData, today]);
  const streak = useMemo(() => computeStreaks(appData, today), [appData, today]);
  const value = useMemo(() => ({ data, today, model, achievements, streak }), [data, today, model, achievements, streak]);
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
// Writes (all durable; see ./sync)
// ---------------------------------------------------------------------------

/** How long a create waits for the server's id before resolving with the local (temporary) row. */
const CREATE_WAIT_MS = 3000;

export function useSaveDay() {
  return useCallback((date: string, patch: DayLogPatch) => {
    enqueue({ kind: "day", date, patch });
  }, []);
}

export function useSaveSession() {
  return useCallback((s: Session) => {
    enqueue({ kind: "session", date: s.date, doc: s });
  }, []);
}

export function useDeleteSession() {
  return useCallback((date: string) => {
    enqueue({ kind: "session", date, doc: null });
  }, []);
}

/** Resolves once the edit is stored on this device; delivery to the server is the outbox's job. */
export function useSaveSettings() {
  return useCallback((s: Settings): Promise<Settings> => {
    enqueue({ kind: "settings", settings: s });
    return Promise.resolve(s);
  }, []);
}

/**
 * Records a max. Resolves with the server's entry when it arrives promptly; offline (or slow),
 * with the local entry, whose temporary id is swapped for the real one everywhere once it syncs.
 * Never rejects.
 */
export function useAddMax() {
  return useCallback(
    async (input: { exerciseId: number; valueLb: number; date: string; source: MaxSource; note?: string | null }): Promise<MaxEntry> => {
      const local: MaxEntry = {
        id: takeTempId(),
        exerciseId: input.exerciseId,
        date: input.date,
        valueLb: input.valueLb,
        source: input.source,
        note: input.note ?? null,
        createdAt: new Date().toISOString(),
      };
      const { id, ...rest } = local;
      const seq = enqueue({ kind: "addMax", tempId: id, ...rest });
      const saved = (await waitForAck(seq, CREATE_WAIT_MS)) as MaxEntry | undefined;
      return saved && typeof saved.id === "number" ? saved : local;
    },
    [],
  );
}

export function useDeleteMax() {
  return useCallback(async (id: number): Promise<void> => {
    enqueue({ kind: "deleteMax", id });
  }, []);
}

/** Like useAddMax: the server's exercise if it arrives promptly, else the local one. Never rejects. */
export function useCreateExercise() {
  return useCallback(async (input: Pick<Exercise, "name" | "category" | "measure"> & { tracksMax?: boolean }): Promise<Exercise> => {
    const local: Exercise = {
      id: takeTempId(),
      name: input.name,
      category: input.category,
      measure: input.measure,
      tracksMax: input.tracksMax ?? false,
      archived: false,
    };
    const seq = enqueue({
      kind: "createExercise",
      tempId: local.id,
      name: local.name,
      category: local.category,
      measure: local.measure,
      tracksMax: local.tracksMax,
    });
    const saved = (await waitForAck(seq, CREATE_WAIT_MS)) as Exercise | undefined;
    return saved && typeof saved.id === "number" ? saved : local;
  }, []);
}

export function useUpdateExercise() {
  return useCallback(async (id: number, patch: Partial<Omit<Exercise, "id">>): Promise<void> => {
    enqueue({ kind: "updateExercise", id, patch });
  }, []);
}

export function useMarkSeen() {
  return useCallback((keys: string[]) => {
    const seen = new Set(currentData()?.seenAchievements ?? []);
    const fresh = keys.filter((k) => !seen.has(k));
    if (fresh.length) enqueue({ kind: "seen", keys: fresh });
  }, []);
}

// ---------------------------------------------------------------------------
// Sync status
// ---------------------------------------------------------------------------

export type { SyncItem } from "./sync";

export interface SyncInfo extends SyncInfoState {
  /** Send everything queued now and re-read the server's copy; resolves when done (never rejects). */
  syncNow(): Promise<void>;
  /** Re-send the changes the server rejected. */
  retryFailed(): void;
  /** Drop the rejected changes and re-read the server's copy. */
  discardFailed(): void;
}

/** Online state, unsynced changes (and which failed), and when everything was last on the server. */
export function useSyncInfo(): SyncInfo {
  const info = useSyncExternalStore(subscribeSync, getSyncInfo, getSyncInfo);
  return useMemo(() => ({ ...info, syncNow, retryFailed, discardFailed }), [info]);
}

/** Dates whose day log or workout has edits not yet confirmed by the server. */
export function usePendingDates(): Set<string> {
  return useSyncExternalStore(subscribeSync, getPendingDates, getPendingDates);
}

/** Increments each time the server confirms a day-log write for `date` (0 until the first one). */
export function useSavedPulse(date: string): number {
  const get = useCallback(() => getSavedPulse(date), [date]);
  return useSyncExternalStore(subscribeSavedPulse, get, get);
}
