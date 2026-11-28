/**
 * The machine Zone 2 is done on (SPEC §3.5): a key for the common ones or a name of the owner's
 * own, stored on the day log as `zone2Machine`. Everything else about it is derived from the day
 * logs: the machine a new day starts on (the last one used), the machines offered (the common ones
 * and the names the owner used lately), and the word a summary says ("Rowing").
 *
 * A machine chosen is written to the day at once. A day's first Zone 2 value written without one
 * (the row's dot, an older build, any other writer) gets the one it would have shown
 * (`fillZone2Machine`, on the device and again on the server), so a day with Zone 2 logged and no
 * machine recorded is one logged before machines existed: it was on the bike.
 *
 * A machine alone is not Zone 2: it doesn't log, start or hold anything (`zone2Logged`).
 */
import { daysBetween, type ISODate } from "./dates";
import type { DayLog, DayLogPatch } from "./schemas";
import { isWellFormed } from "./text";

/** The common machines, in the order they're offered: an option's label and the activity a summary names. */
export const ZONE2_PRESETS = [
  { key: "bike", label: "Bike", activity: "Cycling", aliases: ["bike", "cycling", "cycle", "bicycle", "spin bike"] },
  { key: "row", label: "Row", activity: "Rowing", aliases: ["row", "rowing", "rower", "rowing machine"] },
  { key: "elliptical", label: "Elliptical", activity: "Elliptical", aliases: ["elliptical"] },
  { key: "ski", label: "Ski", activity: "Ski erg", aliases: ["ski", "ski erg", "skierg"] },
] as const;
export type Zone2PresetKey = (typeof ZONE2_PRESETS)[number]["key"];

/** What a day with Zone 2 logged and no machine recorded was on (every day logged before machines were). */
export const DEFAULT_ZONE2_MACHINE: Zone2PresetKey = "bike";
/** The longest name of the owner's own (the column holds 40). */
export const ZONE2_MACHINE_MAX = 40;
/** The owner's own names are offered when used on a day with Zone 2 within this many days of the day shown. */
export const ZONE2_OWN_NAMES_DAYS = 180;

const tidy = (s: string) => s.trim().replace(/\s+/g, " ");
/**
 * What two spellings of one machine share: case, spacing and punctuation folded away ("Assault-bike",
 * "assault  Bike", "AssaultBike" are one). A name of punctuation alone keeps its own.
 */
const foldKey = (s: string) => {
  const folded = tidy(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]/gu, "");
  return folded || tidy(s).toLowerCase();
};
const PRESET_KEYS = ZONE2_PRESETS.map((p) => ({ preset: p, keys: [p.key, ...p.aliases].map(foldKey) }));
/** The common machine a stored machine is, by its key or any name of it ("Row", "rowing", "Ski-Erg"). */
const presetOf = (machine: string) => {
  const k = foldKey(machine);
  return PRESET_KEYS.find((p) => p.keys.includes(k))?.preset;
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

/** Whether two machines are the same one (by case, spacing and punctuation folded: "Assault bike" is "assault-BIKE"). */
export function sameZone2Machine(a: string, b: string): boolean {
  const [x, y] = [normalizeZone2Machine(a), normalizeZone2Machine(b)];
  return x !== null && y !== null && foldKey(x) === foldKey(y);
}

/** Whether a machine is one of the common ones (else a name of the owner's own). */
export const isZone2Preset = (machine: string): machine is Zone2PresetKey => !!presetOf(machine);

/** The machine a day's Zone 2 was on: as recorded, or the bike (not recorded; absent on a day cached by an older build). */
export const dayZone2Machine = (day: Pick<DayLog, "zone2Machine">): string => day.zone2Machine ?? DEFAULT_ZONE2_MACHINE;

/** A machine's option label: "Row", or the owner's own name. */
export const zone2MachineLabel = (machine: string): string => presetOf(machine)?.label ?? machine;

/**
 * The activity a summary names: "Cycling", "Rowing", "Elliptical", "Ski erg", or the owner's own
 * name ("Assault bike"). Not recorded (null / absent) reads "Cycling", as every such day was.
 */
export const zone2Activity = (machine: string | null | undefined): string =>
  presetOf(machine ?? DEFAULT_ZONE2_MACHINE)?.activity ?? (machine as string);

/**
 * Whether a day has Zone 2 logged: done, or a duration or machine reading entered (`!= null`: a day cached by an older
 * build lacks the reading). A machine alone is not: it logs, starts and holds nothing.
 */
export function zone2Logged(day: Pick<DayLog, "zone2Done" | "zone2Minutes" | "zone2Kcal">): boolean {
  return day.zone2Done || day.zone2Minutes != null || day.zone2Kcal != null;
}

export interface LastZone2Machine {
  /** The machine of the most recent earlier day with Zone 2 logged; the bike when there is none. */
  machine: string;
  /** That day; null when no earlier day has Zone 2 logged. */
  from: ISODate | null;
}

/**
 * The machine a day starts on: the one of the most recent earlier day with Zone 2 logged (SPEC §3.5). Nothing is
 * stored for it. A day with a machine chosen and no Zone 2 logged is skipped: Zone 2 wasn't done on it, so it says
 * nothing of what the owner trains on — and a choice left on a day never trained can't steer the days after it.
 */
export function zone2MachineFor(date: ISODate, days: ReadonlyArray<DayLog>): LastZone2Machine {
  let last: DayLog | null = null;
  for (const d of days) if (d.date < date && zone2Logged(d) && (!last || d.date > last.date)) last = d;
  return last ? { machine: dayZone2Machine(last), from: last.date } : { machine: DEFAULT_ZONE2_MACHINE, from: null };
}

/**
 * The machines offered on `date`: the common ones, then the names of the owner's own used on days with Zone 2 logged
 * within `ZONE2_OWN_NAMES_DAYS` of it — each once (spellings folded by case, spacing and punctuation, the most recent
 * spelling kept), the most days used first, then the most recently used. A name used once is offered too: the list
 * is a menu, closed until it is opened.
 */
export function zone2Machines(days: ReadonlyArray<DayLog>, date: ISODate): string[] {
  const own = new Map<string, { name: string; n: number; last: ISODate }>();
  for (const d of days) {
    const m = d.zone2Machine ?? null;
    if (m === null || isZone2Preset(m) || !zone2Logged(d) || daysBetween(d.date, date) >= ZONE2_OWN_NAMES_DAYS) continue;
    const k = foldKey(m);
    const seen = own.get(k);
    if (!seen) own.set(k, { name: m, n: 1, last: d.date });
    else {
      seen.n++;
      if (d.date > seen.last) Object.assign(seen, { name: m, last: d.date });
    }
  }
  const ranked = [...own.values()].sort((a, b) => b.n - a.n || (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
  return [...ZONE2_PRESETS.map((p) => p.key), ...ranked.map((o) => o.name)];
}

/**
 * The machine a day shows: the one it recorded; else, with Zone 2 logged (before machines were), the bike; else the
 * last one used — the one its first Zone 2 value will be written with (`fillZone2Machine`).
 */
export function shownZone2Machine(
  day: Pick<DayLog, "zone2Machine" | "zone2Done" | "zone2Minutes" | "zone2Kcal">,
  last: LastZone2Machine,
): string {
  if (day.zone2Machine != null) return day.zone2Machine;
  return zone2Logged(day) ? DEFAULT_ZONE2_MACHINE : last.machine;
}

/**
 * A day patch with the machine added when it writes the day's first Zone 2 value (the check, a duration or a reading)
 * and neither the day nor the patch has a machine: `machine` is the day's default, `zone2MachineFor(date, days)`.
 * Any other patch is returned as it is — so a day logged before machines (no machine, Zone 2 logged) stays the bike.
 * Every writer of a day goes through it: the device as it saves, and the server for a writer that didn't (an older
 * build, another screen).
 */
export function fillZone2Machine(
  day: Pick<DayLog, "zone2Machine" | "zone2Done" | "zone2Minutes" | "zone2Kcal"> | null | undefined,
  patch: DayLogPatch,
  machine: string,
): DayLogPatch {
  if (patch.zone2Machine !== undefined || day?.zone2Machine != null) return patch;
  if (patch.zone2Done === undefined && patch.zone2Minutes === undefined && patch.zone2Kcal === undefined) return patch;
  const before = { zone2Done: day?.zone2Done ?? false, zone2Minutes: day?.zone2Minutes ?? null, zone2Kcal: day?.zone2Kcal ?? null };
  if (zone2Logged(before) || !zone2Logged({ ...before, ...patch })) return patch;
  return { ...patch, zone2Machine: machine };
}

/**
 * The activities of the given days' Zone 2, for the weekly check-in: each named once, the most days first (ties: the
 * most recent first). A day with no machine recorded (logged before machines were) names none; so a week of such days
 * names nothing.
 */
export function zone2Activities(days: ReadonlyArray<DayLog>): string[] {
  const counts = new Map<string, { name: string; n: number; last: ISODate }>();
  for (const d of days) {
    if (d.zone2Machine == null) continue;
    const name = zone2Activity(d.zone2Machine);
    const k = foldKey(name);
    const c = counts.get(k);
    if (!c) counts.set(k, { name, n: 1, last: d.date });
    else {
      c.n++;
      if (d.date > c.last) Object.assign(c, { name, last: d.date });
    }
  }
  return [...counts.values()].sort((a, b) => b.n - a.n || (a.last < b.last ? 1 : a.last > b.last ? -1 : 0)).map((c) => c.name);
}
