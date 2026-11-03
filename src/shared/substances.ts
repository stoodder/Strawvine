/**
 * The "Also today" flags (docs/SPEC.md §3.4): alcohol, nicotine, THC and caffeine, each
 * `boolean | null` on a day log — null not recorded, false none, true had. Tracking only:
 * nothing reads them for an insight, checklist item or score.
 */
import type { DayLog } from "./schemas";

export type SubstanceKey = "alcohol" | "nicotine" | "thc" | "caffeine";

/** In display order: key, chip label, and the word used inside a sentence ("Had caffeine"). */
export const SUBSTANCES: ReadonlyArray<readonly [key: SubstanceKey, label: string, noun: string]> = [
  ["alcohol", "Alcohol", "alcohol"],
  ["nicotine", "Nicotine", "nicotine"],
  ["thc", "THC", "THC"],
  ["caffeine", "Caffeine", "caffeine"],
];

/**
 * What one tap records: not recorded → none → had → not recorded. None comes first: it is the
 * goal and the most common entry. `undefined` (a day cached by a build without the flags) counts
 * as not recorded.
 */
export function nextSubstanceState(v: boolean | null | undefined): boolean | null {
  if (v == null) return false;
  return v ? null : true;
}

/** "a", "a and b", "a, b and c" (or with "or"). */
function list(words: string[], last: "and" | "or"): string {
  return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} ${last} ${words.at(-1)}`;
}

/**
 * The Nutrition row's line on Today: what was had first (it survives truncation on a narrow
 * phone), then what was recorded as none — "Had caffeine · No alcohol or THC". Empty when none
 * of them is recorded.
 */
export function substanceSummary(day: Pick<DayLog, SubstanceKey>): string {
  const had = SUBSTANCES.filter(([k]) => day[k] === true).map(([, , noun]) => noun);
  const none = SUBSTANCES.filter(([k]) => day[k] === false).map(([, , noun]) => noun);
  return [had.length ? `Had ${list(had, "and")}` : "", none.length ? `No ${list(none, "or")}` : ""].filter(Boolean).join(" · ");
}
