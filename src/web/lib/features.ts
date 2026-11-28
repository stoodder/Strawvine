/**
 * Feature flags for UI that is built but not launched yet (the training day on Train, rehab
 * blocks). Every flag is off unless this device opted in, so a build with a flag off looks and
 * behaves exactly as before. The flags go away at launch.
 *
 * Opting in, per device: `localStorage["strawvine:flags"]` holds the names that are on, as a list
 * ("trainDay,rehab") or as JSON (`{"trainDay":true}`). Two ways to set them without devtools:
 * - **Settings › Previews** (in-app toggles): the only way for the app installed on the Home
 *   Screen, which has storage of its own, apart from Safari's, and no address bar.
 * - **`?flags=…`** in a URL, merged into what this device has: `?flags=rehab` turns rehab on,
 *   `?flags=-trainDay` turns trainDay off, `?flags=rehab,-trainDay` both; an empty value changes
 *   nothing — see `applyFlagParam`.
 *
 * Storage can be missing or throw (private mode, blocked site data): every read and write is
 * wrapped, and a failure reads as "off".
 */

export const FEATURES = ["trainDay", "rehab"] as const;
export type Feature = (typeof FEATURES)[number];
export type Features = Record<Feature, boolean>;

export const FLAGS_KEY = "strawvine:flags";

const isFeature = (s: string): s is Feature => (FEATURES as readonly string[]).includes(s);

/** Reads a stored value: a list ("a,b", spaces allowed) or a JSON object / array. Unknown names are ignored. */
export function parseFlags(raw: string | null | undefined): Features {
  const on = Object.fromEntries(FEATURES.map((f) => [f, false])) as Features;
  const text = raw?.trim();
  if (!text) return on;
  let names: string[] = [];
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const v: unknown = JSON.parse(text);
      if (Array.isArray(v)) names = v.filter((x): x is string => typeof x === "string");
      else if (v && typeof v === "object")
        names = Object.entries(v)
          .filter(([, x]) => x === true)
          .map(([k]) => k);
    } catch {
      return on;
    }
  } else names = text.split(/[\s,]+/);
  for (const n of names) if (isFeature(n)) on[n] = true;
  return on;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Every flag, as this device has them. */
export function features(): Features {
  try {
    return parseFlags(storage()?.getItem(FLAGS_KEY));
  } catch {
    return parseFlags(null);
  }
}

/** Is `name` on for this device? Off by default and whenever storage can't be read. */
export function feature(name: Feature): boolean {
  return features()[name];
}

/** Turns flags on or off on this device (the others keep their value). Returns false if storage refused. */
export function setFeatures(patch: Partial<Features>): boolean {
  const next = { ...features(), ...patch };
  const on = FEATURES.filter((f) => next[f]);
  try {
    const s = storage();
    if (!s) return false;
    if (on.length) s.setItem(FLAGS_KEY, on.join(","));
    else s.removeItem(FLAGS_KEY);
    return true;
  } catch {
    return false;
  }
}

/** What each preview is called where the owner sees it (Settings › Previews, the toast `?flags=` raises). */
export const FEATURE_LABELS: Record<Feature, string> = { trainDay: "New Train", rehab: "Rehab" };

/** `?flags=`'s changes: a name turns it on, `-name` off ("rehab,-trainDay"). Unknown names are ignored. */
export function parseFlagChanges(raw: string | null | undefined): Partial<Features> {
  const out: Partial<Features> = {};
  for (const word of (raw ?? "").split(/[\s,]+/)) {
    const off = word.startsWith("-");
    const name = off || word.startsWith("+") ? word.slice(1) : word;
    if (isFeature(name)) out[name] = !off;
  }
  return out;
}

/** What `applyFlagParam` did. */
export interface FlagParamResult {
  /** The query without `flags` (to put back in the address bar). */
  rest: string;
  /** The flags it set (empty: nothing to change). */
  changed: Partial<Features>;
  /** False when storage refused them (nothing changed on this device). */
  saved: boolean;
}

/**
 * `?flags=` in a URL's query, merged into this device's flags (`parseFlagChanges`): the others keep
 * their value, and an empty value changes nothing. Null when the query holds no `flags`.
 */
export function applyFlagParam(search: string): FlagParamResult | null {
  const params = new URLSearchParams(search);
  if (!params.has("flags")) return null;
  const changed = parseFlagChanges(params.get("flags"));
  const saved = Object.keys(changed).length ? setFeatures(changed) : true;
  params.delete("flags");
  const rest = params.toString();
  return { rest: rest ? `?${rest}` : "", changed, saved };
}

const previews = (fs: ReadonlyArray<Feature>) => `${fs.map((f) => FEATURE_LABELS[f]).join(" and ")} preview${fs.length > 1 ? "s" : ""}`;

/**
 * What a change of flags says (a toast): "Rehab preview on for this device", "New Train and Rehab
 * previews on for this device", "Rehab preview on, New Train preview off for this device" — or,
 * storage having refused it, that nothing changed. Null for no change.
 */
export function flagNotice(changed: Partial<Features>, saved: boolean): string | null {
  const names = FEATURES.filter((f) => changed[f] !== undefined);
  if (!names.length) return null;
  if (!saved) return `Couldn't change the ${previews(names)}: this device didn't let Strawvine save it`;
  const on = names.filter((f) => changed[f]);
  const off = names.filter((f) => !changed[f]);
  const parts = [on.length && `${previews(on)} on`, off.length && `${previews(off)} off`].filter(Boolean);
  return `${parts.join(", ")} for this device`;
}
