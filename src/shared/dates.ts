/**
 * Calendar-date helpers. All days are plain `YYYY-MM-DD` strings in the athlete's local
 * calendar ("the day ends at midnight local time"). Arithmetic is done in UTC on the date
 * portion only, so it is immune to DST and server timezone.
 */
export type ISODate = string;

const DAY_MS = 86_400_000;

export function isISODate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function toUTC(date: ISODate): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function fromUTC(ms: number): ISODate {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: ISODate, days: number): ISODate {
  return fromUTC(toUTC(date) + days * DAY_MS);
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((toUTC(b) - toUTC(a)) / DAY_MS);
}

/** 0 = Sunday … 6 = Saturday */
export function weekdayOf(date: ISODate): number {
  return new Date(toUTC(date)).getUTCDay();
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
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
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
