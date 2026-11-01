/**
 * Calendar-date helpers. All days are plain `YYYY-MM-DD` strings in the athlete's local
 * calendar ("the day ends at midnight local time"). Arithmetic is done in UTC on the date
 * portion only, so it is immune to DST and server timezone.
 */
export type ISODate = string;

const DAY_MS = 86_400_000;

/** Years the app accepts as real calendar dates (rejects typos like 0202 or 20266). */
export const MIN_YEAR = 1900;
export const MAX_YEAR = 2999;

export function isISODate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  if (year < MIN_YEAR || year > MAX_YEAR) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// ---------------------------------------------------------------------------
// Day numbers: whole days since 1970-01-01. Date arithmetic runs on every write over the
// whole history, so it avoids `Date` parsing/formatting: plain integer civil-calendar maths
// (H. Hinnant's days_from_civil / civil_from_days), giving exactly what `Date.parse` +
// `toISOString` would, including `Date.parse`'s roll-over of e.g. Feb 30 → Mar 2.
// ---------------------------------------------------------------------------

/** Non-negative integer from `len` ASCII digits at `at`, or -1. */
function digits(s: string, at: number, len: number): number {
  let v = 0;
  for (let i = at; i < at + len; i++) {
    const c = s.charCodeAt(i) - 48;
    if (c < 0 || c > 9) return -1;
    v = v * 10 + c;
  }
  return v;
}

/** Day number for `YYYY-MM-DD`, or NaN for anything `Date.parse` would also reject. */
export function toDayNumber(date: ISODate): number {
  if (date.length === 10 && date[4] === "-" && date[7] === "-") {
    const y = digits(date, 0, 4);
    const m = digits(date, 5, 2);
    const d = digits(date, 8, 2);
    if (y >= 0 && m >= 1 && m <= 12 && d >= 1 && d <= 31) return daysFromCivil(y, m, d);
  }
  // Anything unusual takes the original path so behaviour stays identical.
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(ms) ? NaN : Math.round(ms / DAY_MS);
}

function daysFromCivil(year: number, m: number, d: number): number {
  const y = m <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n));

/** `YYYY-MM-DD` for a day number (years 0–9999; outside that, falls back to `Date`). */
export function fromDayNumber(n: number): ISODate {
  if (!Number.isInteger(n)) return new Date(n * DAY_MS).toISOString().slice(0, 10); // throws like before for NaN
  const z = n + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  if (y < 0 || y > 9999) return new Date(n * DAY_MS).toISOString().slice(0, 10);
  return `${y < 1000 ? String(y).padStart(4, "0") : y}-${pad2(m)}-${pad2(d)}`;
}

export function addDays(date: ISODate, days: number): ISODate {
  return fromDayNumber(toDayNumber(date) + days);
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: ISODate, b: ISODate): number {
  return toDayNumber(b) - toDayNumber(a);
}

/** 0 = Sunday … 6 = Saturday */
export function weekdayOf(date: ISODate): number {
  // 1970-01-01 was a Thursday (4).
  return (((toDayNumber(date) + 4) % 7) + 7) % 7;
}

/** Monday on or before `date`. */
export function startOfWeek(date: ISODate): ISODate {
  const wd = weekdayOf(date);
  return addDays(date, -((wd + 6) % 7));
}

/** Monday on or after `date`. */
export function nextMonday(date: ISODate): ISODate {
  const wd = weekdayOf(date);
  return wd === 1 ? date : addDays(date, (8 - wd) % 7);
}

/** Today in the device's local timezone. */
export function localToday(now: Date = new Date()): ISODate {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function dateRange(from: ISODate, to: ISODate): ISODate[] {
  const out: ISODate[] = [];
  if (from > to) return out;
  out.push(from);
  const end = toDayNumber(to);
  for (let n = toDayNumber(from) + 1; n <= end; n++) out.push(fromDayNumber(n));
  return out;
}

export function compareDates(a: ISODate, b: ISODate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function weekdayName(date: ISODate, short = false): string {
  const name = WEEKDAYS[weekdayOf(date)]!;
  return short ? name.slice(0, 3) : name;
}

export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** e.g. "Nov 2" or "Nov 2, 2027" when `withYear`. */
export function formatShortDate(date: ISODate, withYear = false): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return `${MONTHS[m - 1]} ${d}${withYear ? `, ${y}` : ""}`;
}
