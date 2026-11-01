/**
 * Benchmark metcons ("Fran", "Murph", …): the history, previous best and PRs for each named
 * workout, derived from the day logs' `metconBenchmark` + `metconScore`. Names are matched
 * loosely (case, spacing); scores are free text, parsed where possible. See docs/SPEC.md §5.
 */
import type { ISODate } from "./dates";
import type { DayLog } from "./schemas";

export type ScoreKind = "time" | "rounds" | "load" | "reps";

export interface ParsedScore {
  kind: ScoreKind;
  /** time: seconds (lower is better); rounds: rounds × 1000 + reps; load: lb; reps: count. */
  value: number;
}

export interface BenchmarkEntry {
  date: ISODate;
  /** The name as logged (trimmed, spaces collapsed). */
  name: string;
  /** The score as logged (trimmed). */
  score: string;
  parsed: ParsedScore | null;
}

const KG_TO_LB = 2.20462;

const tidy = (s: string) => s.trim().replace(/\s+/g, " ");

/** Matching key for a benchmark name: trimmed, case-folded, inner whitespace collapsed. */
export function normalizeBenchmark(name: string): string {
  return tidy(name).toLowerCase();
}

/**
 * Parses a free-text score:
 * - `3:45`, `1:02:03` → time in seconds (lower is better)
 * - `12+4`, `12 + 4`, `12 rounds` → rounds (12 × 1000 + 4)
 * - `225 lb`, `100kg` → load in lb
 * - a bare number ≥ 1 (optionally `150 reps`) → reps
 * Anything else is null.
 */
export function parseScore(score: string): ParsedScore | null {
  const s = tidy(score).toLowerCase();
  let m = /^(\d+):([0-5]\d)(?::([0-5]\d))?$/.exec(s);
  if (m) {
    const [a, b, c] = [Number(m[1]), Number(m[2]), m[3] === undefined ? null : Number(m[3])];
    const value = c === null ? a * 60 + b : a * 3600 + b * 60 + c;
    return value > 0 ? { kind: "time", value } : null;
  }
  m = /^(\d+) ?\+ ?(\d+)$/.exec(s);
  if (m) return { kind: "rounds", value: Number(m[1]) * 1000 + Number(m[2]) };
  m = /^(\d+) ?(?:rounds?|rds?)$/.exec(s);
  if (m) return { kind: "rounds", value: Number(m[1]) * 1000 };
  m = /^(\d+(?:\.\d+)?) ?(lbs?|kgs?)$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    if (!(n > 0)) return null;
    return { kind: "load", value: m[2]!.startsWith("kg") ? Math.round(n * KG_TO_LB * 10) / 10 : n };
  }
  m = /^(\d+(?:\.\d+)?)(?: ?reps?)?$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    return n >= 1 ? { kind: "reps", value: n } : null;
  }
  return null;
}

/**
 * Whether score `a` beats `b`. Same kind: lower time / higher anything else. A time beats a
 * rounds or reps score (finishing beats being capped); other mixes aren't comparable.
 */
export function isBetterScore(a: ParsedScore, b: ParsedScore): boolean {
  if (a.kind === b.kind) return a.kind === "time" ? a.value < b.value : a.value > b.value;
  return a.kind === "time" && (b.kind === "rounds" || b.kind === "reps");
}

/** Whether two scores can be compared at all (see `isBetterScore`). */
export function isComparable(a: ParsedScore, b: ParsedScore): boolean {
  if (a.kind === b.kind) return true;
  const capped = (k: ScoreKind) => k === "rounds" || k === "reps";
  return (a.kind === "time" && capped(b.kind)) || (b.kind === "time" && capped(a.kind));
}

/**
 * The best result so far of each score kind. Kinds that can't be compared (a load vs a time,
 * say) keep separate bests, so one oddly-scored day never blocks later PRs of the usual kind.
 */
type Bests = Map<ScoreKind, BenchmarkEntry>;

/** Earlier bests that `score` can be compared with. */
function comparableBests(bests: Bests, score: ParsedScore): BenchmarkEntry[] {
  return [...bests.values()].filter((b) => isComparable(score, b.parsed!));
}

/**
 * The single best of the comparable earlier bests: the same kind when there is one (a time is
 * measured against the best time, not against a capped score), else the most recent.
 */
function previousBest(candidates: BenchmarkEntry[], score: ParsedScore): BenchmarkEntry | null {
  const same = candidates.find((b) => b.parsed!.kind === score.kind);
  if (same) return same;
  return candidates.reduce<BenchmarkEntry | null>((acc, b) => {
    if (!acc) return b;
    if (isBetterScore(b.parsed!, acc.parsed!)) return b;
    if (isBetterScore(acc.parsed!, b.parsed!)) return acc;
    return b.date > acc.date ? b : acc;
  }, null);
}

function addToBests(bests: Bests, e: BenchmarkEntry) {
  const cur = bests.get(e.parsed!.kind);
  if (!cur || isBetterScore(e.parsed!, cur.parsed!)) bests.set(e.parsed!.kind, e);
}

/** Every logged benchmark (name and score both present), grouped by normalized name, oldest first. */
export function benchmarkHistory(days: ReadonlyArray<DayLog>): Map<string, BenchmarkEntry[]> {
  const out = new Map<string, BenchmarkEntry[]>();
  for (const d of days) {
    const name = d.metconBenchmark ? tidy(d.metconBenchmark) : "";
    const score = d.metconScore ? d.metconScore.trim() : "";
    if (!name || !score) continue;
    const key = normalizeBenchmark(name);
    const list = out.get(key) ?? [];
    list.push({ date: d.date, name, score, parsed: parseScore(score) });
    out.set(key, list);
  }
  for (const list of out.values()) list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

/**
 * The best earlier result for a benchmark (strictly before `beforeDate` when given), or null.
 * With `against`, the best result that score can be compared with (what it has to beat).
 * Without it, the best of the kind the benchmark was most recently scored in.
 */
export function benchmarkBest(
  days: ReadonlyArray<DayLog>,
  name: string,
  beforeDate?: ISODate,
  against?: ParsedScore | null,
): BenchmarkEntry | null {
  const list = benchmarkHistory(days).get(normalizeBenchmark(name)) ?? [];
  const bests: Bests = new Map();
  let latest: BenchmarkEntry | null = null;
  for (const e of list) {
    if (beforeDate !== undefined && e.date >= beforeDate) break;
    if (!e.parsed) continue;
    addToBests(bests, e);
    latest = e;
  }
  const score = against ?? latest?.parsed;
  return score ? previousBest(comparableBests(bests, score), score) : null;
}

/** Benchmark names for autocomplete: as last written, most recently logged first, one per normalized name. */
export function benchmarkNames(days: ReadonlyArray<DayLog>): string[] {
  const latest = new Map<string, { name: string; date: ISODate }>();
  for (const d of days) {
    const name = d.metconBenchmark ? tidy(d.metconBenchmark) : "";
    if (!name) continue;
    const key = normalizeBenchmark(name);
    const prev = latest.get(key);
    if (!prev || d.date > prev.date) latest.set(key, { name, date: d.date });
  }
  return [...latest.values()]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.name.localeCompare(b.name)))
    .map((x) => x.name);
}

export interface BenchmarkPr {
  key: string;
  entry: BenchmarkEntry;
  previous: BenchmarkEntry;
}

/** Seen-achievement keys are capped at 120 characters. */
const MAX_KEY_NAME = 96;

/**
 * Results that beat the best earlier result of every comparable kind (a first result of its
 * kind with nothing comparable before it only sets a baseline). `previous` is the best of
 * those (see `previousBest`).
 */
export function benchmarkPrs(days: ReadonlyArray<DayLog>): BenchmarkPr[] {
  const out: BenchmarkPr[] = [];
  for (const [key, list] of benchmarkHistory(days)) {
    const bests: Bests = new Map();
    for (const e of list) {
      if (!e.parsed) continue;
      const earlier = comparableBests(bests, e.parsed);
      if (earlier.length && earlier.every((b) => isBetterScore(e.parsed!, b.parsed!)))
        out.push({ key: `bench-${key.slice(0, MAX_KEY_NAME)}-${e.date}`, entry: e, previous: previousBest(earlier, e.parsed)! });
      addToBests(bests, e);
    }
  }
  return out;
}
