/**
 * Feature flags for UI that is built but not launched yet (the training day on Train, rehab
 * blocks). Every flag is off unless this device opted in, so a build with a flag off looks and
 * behaves exactly as before. The flags go away at launch.
 *
 * Opting in, per device: `localStorage["strawvine:flags"]` holds the names that are on, as a list
 * ("trainDay,rehab") or as JSON (`{"trainDay":true}`). On a phone without devtools, open the app
 * once with `?flags=trainDay,rehab` (`?flags=` turns them all off) — see `applyFlagParam`.
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

/**
 * `?flags=trainDay,rehab` in a URL's query sets this device's flags to exactly those (`?flags=`
 * clears them). Returns the query without the parameter (to put back in the address bar), or
 * null when it held no `flags`.
 */
export function applyFlagParam(search: string): string | null {
  const params = new URLSearchParams(search);
  if (!params.has("flags")) return null;
  const on = parseFlags(params.get("flags"));
  setFeatures(on);
  params.delete("flags");
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}
