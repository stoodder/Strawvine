/**
 * A blank day log. Kept free of runtime imports (types only) so the web client can use it
 * without pulling zod into its bundle; `schemas.ts` re-exports it.
 */
import type { DayLog } from "./schemas";

export function emptyDayLog(date: string): DayLog {
  return {
    date,
    weightLb: null,
    calories: null,
    proteinG: null,
    carbsG: null,
    fatG: null,
    micros: null,
    steps: null,
    sleepScore: null,
    hrvMs: null,
    sleepMinutes: null,
    energy: null,
    soreness: null,
    zone2Done: false,
    zone2Minutes: null,
    metconDone: false,
    metconNotes: null,
    metconBenchmark: null,
    metconScore: null,
    journal: null,
  };
}
