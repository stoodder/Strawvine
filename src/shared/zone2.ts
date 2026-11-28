/**
 * The machine Zone 2 is done on (SPEC §3.5): a key for the common ones or a name of the owner's
 * own, stored on the day log as `zone2Machine`. Everything about it is derived from the day logs:
 * the machine a new day starts on (the last one used), the chips to pick from (the common ones and
 * the names used on other days), and the word a summary says ("Rowing"). A day with no machine
 * recorded — every day logged before it existed — was on the bike.
 *
 * The machine is written with the day's first Zone 2 value (`withZone2Machine`): picking one alone
 * changes only the screen, so a day's machine is always the one shown when it was logged.
 */
import { daysBetween, formatShortDate, weekdayName, type ISODate } from "./dates";
import type { DayLog, DayLogPatch } from "./schemas";
import { isWellFormed } from "./text";

/** The common machines, in the order they're offered: a chip's label and the activity a summary names. */
export const ZONE2_PRESETS = [
  { key: "bike", label: "Bike", activity: "Cycling", aliases: ["bike", "cycling", "cycle", "bicycle", "spin bike"] },
  { key: "row", label: "Row", activity: "Rowing", aliases: ["row", "rowing", "rower", "rowing machine"] },
  { key: "elliptical", label: "Elliptical", activity: "Elliptical", aliases: ["elliptical"] },
  { key: "ski", label: "Ski", activity: "Ski erg", aliases: ["ski", "ski erg", "skierg", "ski-erg"] },
] as const;
export type Zone2PresetKey = (typeof ZONE2_PRESETS)[number]["key"];

/** What a day with no machine recorded was on (every day logged before machines were). */
export const DEFAULT_ZONE2_MACHINE: Zone2PresetKey = "bike";
/** The longest name of the owner's own (the column holds 40). */
export const ZONE2_MACHINE_MAX = 40;
/** At most this many names of the owner's own are offered as chips (the most recently used). */
export const ZONE2_CUSTOM_CHIPS = 3;

const tidy = (s: string) => s.trim().replace(/\s+/g, " ");
/** The common machine a stored machine is, by its key or any name of it ("Row", "rowing"). */
const presetOf = (machine: string) => {
  const folded = tidy(machine).toLowerCase();
  return ZONE2_PRESETS.find((p) => p.key === folded || (p.aliases as readonly string[]).includes(folded));
};

/**
 * A machine as it is stored, from what was typed or picked: a common one by its key (whatever
 * name it was given — "rowing", "Row"), anything else as typed (trimmed, inner spaces collapsed,
 * cut to 40 characters without splitting one). Nothing usable → null.
 */
export function normalizeZone2Machine(name: string): string | null {
  let t = tidy(name);
  if (!t || !isWellFormed(t)) return null;
  const preset = presetOf(t);
  if (preset) return preset.key;
  if (t.length > ZONE2_MACHINE_MAX) {
    const chars = Array.from(t);
    while (chars.join("").length > ZONE2_MACHINE_MAX) chars.pop();
    t = chars.join("").trim();
  }
  return t || null;
}

/** Whether two machines are the same one (names of the owner's own compared loosely, as typed). */
export function sameZone2Machine(a: string, b: string): boolean {
  const [x, y] = [normalizeZone2Machine(a), normalizeZone2Machine(b)];
  return x !== null && y !== null && x.toLowerCase() === y.toLowerCase();
}

/** Whether a machine is one of the common ones (else a name of the owner's own). */
export const isZone2Preset = (machine: string): machine is Zone2PresetKey => !!presetOf(machine);

/** The machine a day's Zone 2 was on: as recorded, or the bike (not recorded; absent on a day cached by an older build). */
export const dayZone2Machine = (day: Pick<DayLog, "zone2Machine">): string => day.zone2Machine ?? DEFAULT_ZONE2_MACHINE;

/** A machine's chip label: "Row", or the owner's own name. */
export const zone2MachineLabel = (machine: string): string => presetOf(machine)?.label ?? machine;

/**
 * The activity a summary names: "Cycling", "Rowing", "Elliptical", "Ski erg", or the owner's own
 * name ("Assault bike"). Not recorded (null / absent) reads "Cycling", as every such day was.
 */
export const zone2Activity = (machine: string | null | undefined): string =>
  presetOf(machine ?? DEFAULT_ZONE2_MACHINE)?.activity ?? (machine as string);

/** Whether a day has Zone 2 logged: done, or a duration or machine reading entered (`!= null`: a day cached by an older build lacks the reading). */
export function zone2Logged(day: Pick<DayLog, "zone2Done" | "zone2Minutes" | "zone2Kcal">): boolean {
  return day.zone2Done || day.zone2Minutes != null || day.zone2Kcal != null;
}

export interface LastZone2Machine {
  /** The machine of the most recent earlier day with Zone 2 logged; the bike when there is none. */
  machine: string;
  /** That day; null when no earlier day has Zone 2 logged. */
  from: ISODate | null;
}

/** The machine a day starts on: the one of the most recent earlier day with Zone 2 logged (SPEC §3.5). Nothing is stored for it. */
export function zone2MachineFor(date: ISODate, days: ReadonlyArray<DayLog>): LastZone2Machine {
  let last: DayLog | null = null;
  for (const d of days) if (d.date < date && zone2Logged(d) && (!last || d.date > last.date)) last = d;
  return last ? { machine: dayZone2Machine(last), from: last.date } : { machine: DEFAULT_ZONE2_MACHINE, from: null };
}

/**
 * The machines offered as chips on `date`: the common ones, then the names of the owner's own used
 * on other days with Zone 2 logged (the most recently used first, at most `ZONE2_CUSTOM_CHIPS`).
 * The day itself is left out, so that what it logs never adds a chip under the hand logging it.
 */
export function zone2Machines(days: ReadonlyArray<DayLog>, date: ISODate): string[] {
  const own: Array<{ name: string; date: ISODate }> = [];
  for (const d of days) {
    const m = d.zone2Machine ?? null;
    if (d.date === date || m === null || isZone2Preset(m) || !zone2Logged(d)) continue;
    const seen = own.find((o) => sameZone2Machine(o.name, m));
    if (!seen) own.push({ name: m, date: d.date });
    else if (d.date > seen.date) Object.assign(seen, { name: m, date: d.date });
  }
  own.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return [...ZONE2_PRESETS.map((p) => p.key), ...own.slice(0, ZONE2_CUSTOM_CHIPS).map((o) => o.name)];
}

/**
 * The machine a day shows. With Zone 2 logged, its own (none recorded: the bike). Before that, the
 * one picked on screen and not written yet, else one it recorded before its Zone 2 was cleared,
 * else the last one used.
 */
export function shownZone2Machine(
  day: Pick<DayLog, "zone2Machine" | "zone2Done" | "zone2Minutes" | "zone2Kcal">,
  pick: string | null,
  last: LastZone2Machine,
): string {
  if (zone2Logged(day)) return dayZone2Machine(day);
  return pick ?? day.zone2Machine ?? last.machine;
}

/**
 * A patch of the day's Zone 2 with the machine added when it logs the day's first Zone 2 value (the
 * check, a duration or a reading): the machine is written with it, never by picking one alone.
 */
export function withZone2Machine(day: DayLog, patch: DayLogPatch, machine: string): DayLogPatch {
  if (patch.zone2Machine !== undefined || zone2Logged(day) || !zone2Logged({ ...day, ...patch })) return patch;
  return { ...patch, zone2Machine: machine };
}

/**
 * The line under the chips, always one line: why this machine is the one shown.
 *   "Same as last time · Thu"     the machine of the last day with Zone 2 (its weekday within the week before, else its date)
 *   "Your choice today"           another one ("that day" on another day than today)
 *   "Bike unless you pick another"  nothing logged before: the default
 *   "Name it below"               Other chosen, no name given yet
 */
export function zone2Caption(opts: {
  machine: string;
  last: LastZone2Machine;
  date: ISODate;
  today: ISODate;
  /** Other is chosen and has no name yet. */
  naming?: boolean;
}): string {
  const { machine, last, date, today } = opts;
  if (opts.naming) return "Name it below";
  if (sameZone2Machine(machine, last.machine)) {
    if (last.from === null) return `${zone2MachineLabel(machine)} unless you pick another`;
    const when =
      daysBetween(last.from, date) <= 6
        ? weekdayName(last.from, true)
        : formatShortDate(last.from, last.from.slice(0, 4) !== date.slice(0, 4));
    return `Same as last time · ${when}`;
  }
  return date === today ? "Your choice today" : "Your choice that day";
}

/**
 * The activities of the given days' Zone 2, for the weekly check-in: each named once, the most
 * days first (ties: the most recent first). "Cycling" for a day with no machine recorded.
 */
export function zone2Activities(days: ReadonlyArray<DayLog>): string[] {
  const counts = new Map<string, { n: number; last: ISODate }>();
  for (const d of days) {
    const a = zone2Activity(d.zone2Machine);
    const key = a.toLowerCase();
    const c = counts.get(key);
    if (!c) counts.set(key, { n: 1, last: d.date });
    else counts.set(key, { n: c.n + 1, last: d.date > c.last ? d.date : c.last });
  }
  const firstName = new Map<string, string>();
  for (const d of [...days].sort((a, b) => (a.date < b.date ? 1 : -1))) {
    const a = zone2Activity(d.zone2Machine);
    if (!firstName.has(a.toLowerCase())) firstName.set(a.toLowerCase(), a);
  }
  return [...counts.entries()]
    .sort(([, a], [, b]) => b.n - a.n || (a.last < b.last ? 1 : a.last > b.last ? -1 : 0))
    .map(([k]) => firstName.get(k)!);
}
