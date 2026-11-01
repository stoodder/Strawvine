export function fmt(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function signed(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const s = fmt(Math.abs(n), digits);
  return n > 0 ? `+${s}` : n < 0 ? `−${s}` : s;
}

export function minutesToHM(min: number | null | undefined): string {
  if (min === null || min === undefined) return "—";
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

/** Parses "7:30", "7h30", "7.5" (hours) or "450m" into minutes. */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  let m = s.match(/^(\d{1,2})\s*[:h]\s*(\d{1,2})\s*m?$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = s.match(/^(\d+)\s*m(in)?$/);
  if (m) return Number(m[1]);
  const n = Number(s.replace(/h$/, ""));
  return Number.isFinite(n) ? Math.round(n * 60) : null;
}

export function parseNum(input: string): number | null {
  const s = input.replace(/,/g, "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function compactSteps(n: number): string {
  return n >= 1000 ? `${+(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : String(n);
}
