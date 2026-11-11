/**
 * Rest times (Program › Rules) are shown as m:ss ("3:00") and typed in whatever way the keyboard allows
 * (the iOS numeric pad has no ":" key — the same idea as the sleep field):
 *
 *   "3:00" "3.00" "3,30"   → m:ss (two digits after the separator are seconds)
 *   "330" "1030"           → m:ss when the last two digits can be seconds ("180" can't: 180 s)
 *   "1" … "15"             → minutes ("3" is 3:00)
 *   "45" "90" "180"        → seconds (16 and up, or when the last two digits are 60+)
 *   "90s" "3m" "2m30s"     → units. Whitespace is ignored.
 */

/** 180 → "3:00"; 75 → "1:15". */
export function formatRest(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Bare whole numbers up to this many are minutes ("3" → 3:00); above it, seconds. */
const BARE_MINUTES_MAX = 15;

/** Seconds for a typed rest time, or null when it isn't one. Empty → null. */
export function parseRest(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, "");
  if (!s) return null;
  let m = /^(\d{1,3})[:.,]([0-5]\d)$/.exec(s);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /^(\d{1,2})([0-5]\d)$/.exec(s);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /^(\d{1,5})$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    return n >= 1 && n <= BARE_MINUTES_MAX ? n * 60 : n;
  }
  m = /^(\d{1,5})(?:s|sec|secs)$/.exec(s);
  if (m) return Number(m[1]);
  m = /^(\d{1,3})(?:m|min)(?:(\d{1,2})(?:s|sec)?)?$/.exec(s);
  if (m) {
    const sec = m[2] === undefined ? 0 : Number(m[2]);
    return sec < 60 ? Number(m[1]) * 60 + sec : null;
  }
  return null;
}
