import { useCallback, useState } from "react";
import { addDays } from "../../../shared/dates";

/**
 * Progression hints dismissed "for today": a per-device convenience (not training data), kept
 * in localStorage as { [date]: exerciseId[] } and pruned to the last week on each write.
 */
const KEY = "strawvine:hint-dismissed";
const KEEP_DAYS = 7;

type Dismissed = Record<string, number[]>;

function read(): Dismissed {
  try {
    const v: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Dismissed = {};
    for (const [date, ids] of Object.entries(v as Record<string, unknown>))
      if (Array.isArray(ids)) out[date] = ids.filter((x): x is number => typeof x === "number");
    return out;
  } catch {
    return {};
  }
}

function write(v: Dismissed) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* storage unavailable: the dismissal lasts until the screen reloads */
  }
}

/** Which exercises' hints are dismissed on `date`, and a way to dismiss one more. */
export function useDismissedHints(date: string) {
  const [all, setAll] = useState<Dismissed>(read);
  const dismissed = all[date] ?? [];
  const dismiss = useCallback(
    (exerciseId: number) => {
      setAll((prev) => {
        const cutoff = addDays(date, -KEEP_DAYS);
        const next: Dismissed = {};
        for (const [d, ids] of Object.entries({ ...read(), ...prev })) if (d >= cutoff) next[d] = ids;
        next[date] = [...new Set([...(next[date] ?? []), exerciseId])];
        write(next);
        return next;
      });
    },
    [date],
  );
  return { isDismissed: (exerciseId: number) => dismissed.includes(exerciseId), dismiss };
}
