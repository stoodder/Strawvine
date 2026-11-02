/**
 * Rest times in Settings are shown as m:ss ("3:00") and typed either way: "3:00", "1:30",
 * "180" (seconds), "90s", "3m", "2m30s". Whitespace is ignored.
 */

/** 180 → "3:00"; 75 → "1:15". */
export function formatRest(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Seconds for a typed rest time, or null when it isn't one. Empty → null. */
export function parseRest(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, "");
  if (!s) return null;
  let m = /^(\d{1,3}):([0-5]\d)$/.exec(s);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /^(\d{1,5})(?:s|sec|secs)?$/.exec(s);
  if (m) return Number(m[1]);
  m = /^(\d{1,3})(?:m|min)(?:(\d{1,2})(?:s|sec)?)?$/.exec(s);
  if (m) {
    const sec = m[2] === undefined ? 0 : Number(m[2]);
    return sec < 60 ? Number(m[1]) * 60 + sec : null;
  }
  return null;
}
