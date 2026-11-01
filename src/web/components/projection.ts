import { formatShortDate, type ISODate } from "../../shared/dates";

/**
 * One way to write a projected goal date (or range) everywhere: "Dec 19 – Mar 8, 2027".
 * The year appears only when a date falls outside the current year.
 */
export function formatProjectedRange(range: readonly [ISODate, ISODate], today: ISODate): string {
  const year = today.slice(0, 4);
  const [a, b] = range;
  const y = (d: ISODate) => d.slice(0, 4) !== year;
  if (a === b) return formatShortDate(a, y(a));
  const crossYear = a.slice(0, 4) !== b.slice(0, 4);
  return `${formatShortDate(a, crossYear && y(a))} – ${formatShortDate(b, y(b) || crossYear)}`;
}
