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

/** The best parseable result for a benchmark (strictly before `beforeDate` when given), or null. */
export function benchmarkBest(days: ReadonlyArray<DayLog>, name: string, beforeDate?: ISODate): BenchmarkEntry | null {
  const list = benchmarkHistory(days).get(normalizeBenchmark(name)) ?? [];
  let best: BenchmarkEntry | null = null;
  for (const e of list) {
    if (beforeDate !== undefined && e.date >= beforeDate) break;
    if (e.parsed && (!best || isBetterScore(e.parsed, best.parsed!))) best = e;
  }
  return best;
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

/** Results that beat every earlier parseable result of the same benchmark (a first-ever result sets the baseline). */
export function benchmarkPrs(days: ReadonlyArray<DayLog>): BenchmarkPr[] {
  const out: BenchmarkPr[] = [];
  for (const [key, list] of benchmarkHistory(days)) {
    let best: BenchmarkEntry | null = null;
    for (const e of list) {
      if (!e.parsed) continue;
      if (best && isBetterScore(e.parsed, best.parsed!))
        out.push({ key: `bench-${key.slice(0, MAX_KEY_NAME)}-${e.date}`, entry: e, previous: best });
      if (!best || isBetterScore(e.parsed, best.parsed!)) best = e;
    }
  }
  return out;
}
