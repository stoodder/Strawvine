/**
 * Sleep duration entry, tuned for phone keypads (the iOS decimal pad has no ":" key).
 *
 *   "7:30" "7h30" "7.30" "7,30"  → 7h 30m   (two digits after the separator are minutes)
 *   "730"  "1015"                → 7h 30m, 10h 15m
 *   "7"  "7.5"  "7,5"  "7h"      → hours (7.5 → 7h 30m)
 *   "450m" "450min"              → minutes
 *
 * Returns minutes, `null` for an empty entry, or `undefined` when the text can't be read
 * as a night's sleep (so the caller can keep the previous value instead of erasing it).
 */
export function parseSleep(input: string): number | null | undefined {
  const s = input.trim().toLowerCase().replace(/\s+/g, "");
  if (!s) return null;
  let m: RegExpMatchArray | null;
  const n = (i: number) => Number(m?.[i] ?? 0);
  if ((m = s.match(/^(\d{1,2})[:h](\d{1,2})m?$/))) return hm(n(1), n(2));
  if ((m = s.match(/^(\d{1,2})[.,](\d{2})$/))) {
    // Clock-style first ("7.30" means half past); a value that can't be minutes is decimal hours.
    return n(2) < 60 ? hm(n(1), n(2)) : within(Math.round((n(1) + n(2) / 100) * 60));
  }
  if ((m = s.match(/^(\d{1,2})h$/))) return hm(n(1), 0);
  if ((m = s.match(/^(\d{1,4})m(?:in)?$/))) return within(n(1));
  if ((m = s.match(/^(\d{1,2})(\d{2})$/))) return hm(n(1), n(2));
  if ((m = s.match(/^(\d{1,2})(?:[.,](\d))?$/))) return within(Math.round((n(1) + n(2) / 10) * 60));
  return undefined;
}

/** Minutes → "7:30" (the canonical way the field shows a saved value). */
export function formatSleep(min: number | null): string {
  if (min === null) return "";
  const h = Math.floor(min / 60);
  return `${h}:${String(Math.round(min - h * 60)).padStart(2, "0")}`;
}

function hm(h: number, m: number): number | undefined {
  return m < 60 ? within(h * 60 + m) : undefined;
}

function within(min: number): number | undefined {
  return min >= 0 && min <= 24 * 60 ? min : undefined;
}
