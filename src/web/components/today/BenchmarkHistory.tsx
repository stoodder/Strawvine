import clsx from "clsx";
import { Trophy } from "lucide-react";
import { useMemo } from "react";
import { benchmarkBest, benchmarkHistory, benchmarkPrs, normalizeBenchmark, type BenchmarkEntry } from "../../../shared/benchmarks";
import { formatShortDate } from "../../../shared/dates";
import type { DayLog } from "../../../shared/schemas";
import { Sheet } from "../ui";

interface Row {
  entry: BenchmarkEntry;
  /** The score it beat, when this result was a PR. */
  beat: string | null;
  best: boolean;
}

/** Every result for one benchmark, newest first, with its PRs and the current best marked. */
export function benchmarkRows(days: ReadonlyArray<DayLog>, name: string): Row[] {
  const key = normalizeBenchmark(name);
  const list = benchmarkHistory(days).get(key) ?? [];
  const prs = new Map(
    benchmarkPrs(days)
      .filter((p) => normalizeBenchmark(p.entry.name) === key)
      .map((p) => [p.entry.date, p.previous.score] as const),
  );
  const best = benchmarkBest(days, name);
  return [...list].reverse().map((entry) => ({ entry, beat: prs.get(entry.date) ?? null, best: !!best && best.date === entry.date }));
}

/**
 * A benchmark's history (opened from the metcon editor's "Best …" line): date, score, PRs in
 * gold with the score they beat, the current best marked. `date` is the day being edited.
 */
export function BenchmarkHistorySheet({
  open,
  onClose,
  name,
  days,
  date,
}: {
  open: boolean;
  onClose: () => void;
  name: string;
  days: ReadonlyArray<DayLog>;
  date: string;
}) {
  const rows = useMemo(() => (open ? benchmarkRows(days, name) : []), [open, days, name]);
  const year = date.slice(0, 4);
  const prCount = rows.filter((r) => r.beat).length;
  return (
    <Sheet open={open} onClose={onClose} title={rows[0]?.entry.name ?? name}>
      <p className="-mt-3 mb-4 text-xs text-mute">
        <span className="num text-fg-2">{rows.length}</span> {rows.length === 1 ? "result" : "results"}
        {prCount > 0 && (
          <>
            {" "}
            · <span className="num text-fg-2">{prCount}</span> {prCount === 1 ? "PR" : "PRs"}
          </>
        )}{" "}
        · newest first
      </p>
      <ul className="divide-y divide-white/[0.04]" aria-label={`${name} results, newest first`}>
        {rows.map((r) => {
          const otherYear = r.entry.date.slice(0, 4) !== year;
          return (
            <li key={r.entry.date} className="flex items-center gap-x-4 py-3">
              <span className="w-[4.5rem] shrink-0">
                <span className={clsx("label block", r.entry.date === date && "text-fg-2")}>
                  {formatShortDate(r.entry.date, otherYear)}
                </span>
                {r.entry.date === date && <span className="mt-0.5 block text-2xs text-mute">this day</span>}
              </span>
              {/* Score and marker share the rest; the marker drops under the score when there's no room. */}
              <span className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
                <span className={clsx("num max-w-full truncate text-lg font-light", r.beat || r.best ? "text-gold" : "text-fg")}>
                  {r.entry.score}
                </span>
                <span className="ml-auto flex shrink-0 flex-col items-end text-right">
                  {r.beat && (
                    <span className="flex items-center gap-1 text-xs text-gold">
                      <Trophy aria-hidden size={12} />
                      PR
                    </span>
                  )}
                  {r.beat && <span className="num text-2xs text-mute">beat {r.beat}</span>}
                  {r.best && !r.beat && <span className="label text-gold">best</span>}
                  {r.best && r.beat && <span className="sr-only">, current best</span>}
                  {!r.entry.parsed && <span className="text-2xs text-mute">not compared</span>}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}
