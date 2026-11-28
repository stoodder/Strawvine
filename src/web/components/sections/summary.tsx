/**
 * What the head of a Metcon or Zone 2 section says under its title (DESIGN A.2): the plan before
 * anything is logged, then the one-line summary a folded section is ("Fran · 4:12 · New best",
 * "Rowing · 35 min · 320 kcal"). One line, truncated by the head; numbers in `fg-2`.
 */
import { Fragment, type ReactNode } from "react";
import { benchmarkBest, parseScore } from "../../../shared/benchmarks";
import type { DayLog } from "../../../shared/schemas";
import { zone2Activity } from "../../../shared/zone2";
import { fmt } from "../../lib/format";
import { compareScore } from "./metconScore";

/** A number in a meta line. */
const Num = ({ children }: { children: ReactNode }) => <span className="num text-fg-2">{children}</span>;

/** Parts joined by " · ". */
export function dotted(parts: ReadonlyArray<ReactNode>): ReactNode {
  return parts.map((p, i) => (
    <Fragment key={i}>
      {i > 0 && " · "}
      {p}
    </Fragment>
  ));
}

const text = (v: string | null | undefined): string | null => (v && v.trim() ? v.trim() : null);
/** The first line of the notes, for a metcon logged without a benchmark ("EMOM 12: 10 burpees + 12 KB swings"). */
const firstLine = (v: string | null | undefined): string | null => text(v?.split("\n").find((l) => l.trim()));

/** What a metcon is called when nothing names it. */
export const METCON_PLAN = "CrossFit";

/**
 * A metcon's summary: what it was (the benchmark, else the first line of the notes, else
 * "CrossFit"), the score, and — with `best`, and only for a metcon done — "New best" (gold: a
 * benchmark PR is a PR) when it beat the best before the day. `days`: the day logs (the best is of
 * earlier days). The section asks for it only when folded: open, the body's line under the notes
 * says it, and it is said once.
 */
export function metconSummary(log: DayLog, days: ReadonlyArray<DayLog>, opts: { best?: boolean } = {}): ReactNode {
  const name = text(log.metconBenchmark);
  const score = text(log.metconScore);
  const parts: ReactNode[] = [name ?? firstLine(log.metconNotes) ?? METCON_PLAN];
  if (score) parts.push(<Num>{score}</Num>);
  if (opts.best && log.metconDone && name && score) {
    const best = benchmarkBest(days, name, log.date);
    const parsed = parseScore(score);
    const verdict = best?.parsed && parsed ? compareScore(parsed, best.parsed) : null;
    if (verdict?.tone === "gold") parts.push(<span className="text-gold">{verdict.text}</span>);
  }
  return dotted(parts);
}

/**
 * A Zone 2's summary: the activity of its machine, then the minutes and the machine's reading logged ("Rowing · 35 min ·
 * 320 kcal"). Only the name gives way to a narrow line (a long name of the owner's own), never the numbers.
 */
export function zone2Summary(log: DayLog, machine: string): ReactNode {
  const parts: ReactNode[] = [];
  if (log.zone2Minutes != null)
    parts.push(
      <>
        <Num>{fmt(log.zone2Minutes)}</Num> min
      </>,
    );
  // `!= null`: absent on a day cached by an older build.
  if (log.zone2Kcal != null)
    parts.push(
      <>
        <Num>{fmt(log.zone2Kcal)}</Num> kcal
      </>,
    );
  if (!parts.length) return zone2Activity(machine);
  return (
    <span className="flex min-w-0">
      <span className="min-w-0 truncate">{zone2Activity(machine)}</span>
      <span className="shrink-0 whitespace-pre"> · {dotted(parts)}</span>
    </span>
  );
}

/** A Zone 2's plan: "30 min planned". */
export function zone2Plan(minutes: number): ReactNode {
  return (
    <>
      <Num>{fmt(minutes)}</Num> min planned
    </>
  );
}
