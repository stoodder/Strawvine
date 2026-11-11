/**
 * Well-formed text: a string with no lone surrogate — half of an emoji or of any other character
 * beyond U+FFFF, as left behind when text is cut between the two code units of such a character.
 *
 * Postgres can't store one: `jsonb` refuses the document (so a whole workout or settings save
 * would fail with a server error, on every retry), and a `text` column gets U+FFFD in its place.
 * So it is refused as input (`safeString`), on the device before an edit is queued (`validateOp`).
 */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u; // with `u`, a pair is one code point above U+FFFF: only a lone one matches

/** For engines without `String.prototype.isWellFormed` (before Chrome 111, Safari 16.4, Firefox 119). */
export const isWellFormedByRegex = (s: string): boolean => !LONE_SURROGATE.test(s);

const native = (String.prototype as { isWellFormed?: (this: string) => boolean }).isWellFormed;

export const isWellFormed: (s: string) => boolean = typeof native === "function" ? (s) => native.call(s) : isWellFormedByRegex;

/** Whether any string in a JSON-like value — object keys included — is ill-formed. */
export function hasIllFormedText(v: unknown): boolean {
  if (typeof v === "string") return !isWellFormed(v);
  if (Array.isArray(v)) return v.some(hasIllFormedText);
  if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) if (!isWellFormed(k) || hasIllFormedText(x)) return true;
  }
  return false;
}

/** What `safeString` answers (the API's 400 carries it with the field's path). */
export const ILL_FORMED_MESSAGE = "Must not contain a broken character (half of an emoji)";
