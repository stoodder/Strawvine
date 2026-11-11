/**
 * What a done exercise came to, in one line — the text of its folded row on Train:
 *
 *   "3 × 8 · 135 lb"                    every set alike (sets × amount as `repScheme` writes it, then the load)
 *   "3 × 10 reps" · "3 × 30 s" · "3 × 40 m · 70 lb"
 *   "8/8/6 · 135 lb"                    amounts that differ are listed, set by set
 *   "3 × 8 · 125/130/135 lb"            so are loads ("–": a set logged without one)
 *   "6 sets · 6–10 reps · 40–50 lb"     more than four differing sets: their range
 *   "5 × 20 m · up to 10 lb"            … "up to" when some of those sets have no load (or no count):
 *                                       a range would give them one
 *   "8 × 25 lb" · "30 s · 25 lb"        a single set: just what its row shows
 *   "170 × 6 · 160 × 8 · 140 × 14 +2 reps · +2 lb"
 *                                       the main lift, set by set as its rows read (load × reps),
 *                                       the AMRAP with its tag (gold once it beat its target)
 *
 * Formatting only, and only what was logged: each amount and load is the one its set's row shows
 * (the reps done — "–" when a set was logged without a count, never its target; `shownLoad`), in
 * the rows' own words (`accessorySetShown`, `mainSetValues`, "8 reps" but "8 × 25 lb") with the
 * AMRAP's own tag (`mainSetTag`). The line never states an amount or a load that no logged set
 * has, and never gives one to a set that has none. Sets not logged yet are left out.
 */
import type { Block, BlockExercise, Measure, SetEntry } from "../../../shared/schemas";
import { shownLoad } from "../../../shared/session";
import { accessorySetShown, mainSetValues } from "./SetControls";
import { mainSetTag, measureUnit, repScheme, unitWord, type SetTag } from "./sessionEdit";

export interface SummaryPart {
  text: string;
  /** Follows the part it belongs to: a main-lift AMRAP's "AMRAP" / "+2 reps · +2 lb". */
  tag?: SetTag;
}

export interface ExerciseSummary {
  /** The line's parts, in order; shown joined by " · " (a part never breaks across lines). */
  parts: SummaryPart[];
  /** The whole line as text: "3 × 8 · 135 lb". Empty when nothing is logged. */
  text: string;
}

/** Differing amounts or loads are listed up to this many sets; beyond it they are given as a range. */
export const SUMMARY_LIST_MAX = 4;
/** The main lift is listed set by set up to this many sets. */
export const SUMMARY_PAIRS_MAX = 6;

/** Stands in for a count or a load a logged set doesn't have. */
const EMPTY = "–";
const same = <T>(xs: ReadonlyArray<T>) => xs.every((x) => x === xs[0]);
const known = (xs: ReadonlyArray<number | null>) => xs.filter((x): x is number => x !== null);
const list = (xs: ReadonlyArray<number | null>) => xs.map((x) => x ?? EMPTY).join("/");
/**
 * Many differing values, in short: "6–10" — or "up to 10" when some sets have none, since a range
 * would say they do.
 */
const span = (xs: ReadonlyArray<number | null>) => {
  const have = known(xs);
  const hi = Math.max(...have);
  return have.length < xs.length ? `up to ${hi}` : `${Math.min(...have)}–${hi}`;
};

/** The amounts ("3 × 8", "8/8/6", "6 sets · 6–10 reps") and loads ("135 lb", "125/–/135 lb") of two or more sets, as parts. */
function plainParts(amounts: ReadonlyArray<number | null>, loads: ReadonlyArray<number | null>, measure: Measure): SummaryPart[] {
  const n = amounts.length;
  const loaded = loads.some((l) => l !== null);
  const unit = measureUnit(measure);
  /** After the amounts: "s" / "m", or "reps" when no load follows — as a set's row has it. */
  const suffix = (sample: number | null) => (unit ? ` ${unit}` : loaded ? "" : ` ${unitWord(measure, sample)}`);
  const parts: SummaryPart[] = [];
  if (same(amounts)) parts.push({ text: `${amounts[0] === null ? `${n} × ${EMPTY}` : repScheme(amounts)}${suffix(amounts[0] ?? null)}` });
  else if (n <= SUMMARY_LIST_MAX) parts.push({ text: `${list(amounts)}${suffix(null)}` });
  // Many differing counts: the range always names its unit ("6–10" alone could be anything).
  else parts.push({ text: `${n} sets` }, { text: `${span(amounts)} ${unit || unitWord(measure, null)}` });
  if (loaded) {
    if (same(loads)) parts.push({ text: `${loads[0]} lb` });
    else if (n <= SUMMARY_LIST_MAX) parts.push({ text: `${list(loads)} lb` });
    else parts.push({ text: `${span(loads)} lb` });
  }
  return parts;
}

/**
 * The logged sets of one exercise of a block, summed up. `weighted`: whether the exercise tracks a
 * load (the main lift always does) — as for a set's row, a load a set was logged with shows either way.
 */
export function exerciseSummary(ex: Pick<BlockExercise, "sets" | "measure">, kind: Block["kind"], weighted: boolean): ExerciseSummary {
  const sets = ex.sets.filter((s) => s.done);
  if (!sets.length) return { parts: [], text: "" };
  // What each set's row shows: the count it was logged with (none: "–", not its target), and its
  // load — a set logged at 0 lb carries none.
  const amounts = sets.map((s) => s.reps);
  const loads = sets.map((s) => shownLoad(s, weighted) || null);
  // An AMRAP's tag as its row carries it ("back-off" is a note about the plan, not a result).
  const tags = sets.map((s) => (s.amrap ? mainSetTag(s, false) : null));
  const lastTag = tags.filter((t) => t !== null).at(-1);
  /** A main-lift set as its row reads: "170 × 6". */
  const pair = (s: SetEntry) => mainSetValues(s, null);
  let parts: SummaryPart[];
  if (kind === "primary" && (sets.length === 1 || (!same(loads) && sets.length <= SUMMARY_PAIRS_MAX)))
    // The main lift's rows, in a line: the load leads, each set its own pair, an AMRAP's tag on its own pair.
    parts = sets.map((s, i) => ({ text: pair(s), ...(tags[i] ? { tag: tags[i]! } : {}) }));
  else if (sets.length === 1)
    // One set: exactly what its row shows ("8 × 25 lb", "30 s", "10 × – lb (no load)").
    parts = [{ text: accessorySetShown(sets[0]!, ex.measure, weighted) }];
  else {
    parts = plainParts(amounts, loads, ex.measure);
    // No pair to hang it on: the (last) AMRAP's tag ends the line.
    if (lastTag) parts[parts.length - 1] = { ...parts[parts.length - 1]!, tag: lastTag };
  }
  return { parts, text: parts.map((p) => (p.tag ? `${p.text} ${p.tag.text}` : p.text)).join(" · ") };
}
