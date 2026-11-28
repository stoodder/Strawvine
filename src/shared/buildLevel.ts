/**
 * Build levels (SPEC §8, "Outdated builds"): which app code a request comes from, for the writes an outdated build
 * must not make. Pure; shared by the client (it sends its level) and the server (it gates on it).
 *
 * The build id can't order builds: it is a label (`BUILD_ID`, by default the Unix time of the build, or any string
 * such as a commit sha), and rebuilding old code — a rollback by redeploying an earlier commit — stamps it anew. A
 * build level is a whole number in the source instead: it orders *code*, never goes down, and a rebuild of a commit
 * carries that commit's level. Raise it by one in the change that makes an older client unsafe for some write, and
 * raise the matching minimum below (or `MIN_REHAB_BUILD_LEVEL` at deploy time) with it.
 */
import type { Session, Settings } from "./schemas";

/** This code's level. 1: the first build that sends it (the rehab gate). Never lowered. */
export const BUILD_LEVEL = 1;

/** The request header the client sends its level in (every API call). */
export const BUILD_LEVEL_HEADER = "x-strawvine-build-level";

/**
 * The lowest level that may write a document involving rehab (a rehab block, `settings.rehab`): 1, the build that
 * brought this gate. Builds before it send no level (0) and their merge can pair a rehab block with an accessory
 * block and save them as one (SPEC §8). The server's default; `MIN_REHAB_BUILD_LEVEL` overrides it.
 */
export const MIN_REHAB_BUILD_LEVEL = 1;

/** `code` of the server's refusal (409) of a write an outdated build may not make. */
export const UPGRADE_REQUIRED = "upgrade-required";

/**
 * Its `error`: what an outdated build shows in "Couldn't save …: <error>" (cut at 90 characters) and in Settings ›
 * Sync, so it says what to do. It keeps the change as not saved; the build that opens after the update re-sends it
 * on its own (`retryOutdated`, outbox-core). Never reword it: a build before levels stores it as the refused
 * change's only mark, and later builds recognise the change by it (`outdatedLevelOf`).
 */
export const UPGRADE_REQUIRED_MESSAGE = "This version of the app is out of date. Reopen the app to update; the change is kept.";

/** The refusal's body. Not `error: "conflict"`: no build merges it, every build keeps the change as not saved. */
export interface UpgradeRequiredBody {
  error: typeof UPGRADE_REQUIRED_MESSAGE;
  code: typeof UPGRADE_REQUIRED;
  minBuildLevel: number;
}

export const upgradeRequiredBody = (minBuildLevel: number): UpgradeRequiredBody => ({
  error: UPGRADE_REQUIRED_MESSAGE,
  code: UPGRADE_REQUIRED,
  minBuildLevel,
});

export function isUpgradeRequired(body: unknown): body is UpgradeRequiredBody {
  return !!body && typeof body === "object" && (body as { code?: unknown }).code === UPGRADE_REQUIRED;
}

/** A request's level: its header's whole number; missing or anything else (a build before levels) is 0. */
export function buildLevelOf(header: string | null | undefined): number {
  const v = header?.trim() ?? "";
  return /^\d{1,9}$/.test(v) ? Number(v) : 0;
}

/** Whether a stored or sent workout holds a rehab block. Defensive: stored JSON is read without parsing it. */
export function sessionHoldsRehab(doc: Pick<Session, "blocks"> | null | undefined): boolean {
  const blocks = (doc as { blocks?: unknown } | null | undefined)?.blocks;
  return Array.isArray(blocks) && blocks.some((b) => (b as { kind?: unknown } | null)?.kind === "rehab");
}

/** JSON with object keys sorted (jsonb stores them in its own order). */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v ?? null);
}

/**
 * What a settings save from an outdated build does to the rehab blocks (`settings.rehab`, SPEC §6.8), against the
 * stored document:
 * - `keep`: it leaves them as stored — it doesn't carry the key (a build that doesn't know it, or a document from
 *   before it), so the stored value is written back in its place (`stored` undefined: there is none);
 * - `same`: it carries exactly the stored ones (absent and an empty list are the same);
 * - `changed`: it would drop, bring back or alter one — refused (an outdated build never edits them; a difference is a
 *   stale copy).
 */
export function rehabSettingsChange(
  stored: Pick<Settings, "rehab"> | null | undefined,
  incoming: Pick<Settings, "rehab">,
): { kind: "keep"; stored: Settings["rehab"] } | { kind: "same" } | { kind: "changed" } {
  if (incoming.rehab === undefined) return { kind: "keep", stored: stored?.rehab };
  const programs = (s: Pick<Settings, "rehab"> | null | undefined) => canonical(s?.rehab?.programs ?? []);
  return programs(stored) === programs(incoming) ? { kind: "same" } : { kind: "changed" };
}
