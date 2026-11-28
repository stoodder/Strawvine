/**
 * The Metcon editor's body — benchmark, score, notes, the best so far and recent names — shared by
 * Today's checklist row and Train's Metcon section (`train/MetconSection.tsx`).
 */
import clsx from "clsx";
import { useId, useMemo, useState } from "react";
import { benchmarkBest, benchmarkNames, normalizeBenchmark, parseScore } from "../../../shared/benchmarks";
import { formatShortDate } from "../../../shared/dates";
import type { DayLogPatch } from "../../../shared/schemas";
import { useData } from "../../lib/store";
import { JournalText } from "../TextArea";
import { BenchmarkHistorySheet } from "../today/BenchmarkHistory";
import { TextField } from "../today/fields";
import { compareScore } from "./metconScore";
import type { EditorProps } from "./types";

export function MetconBody({ day, patch }: EditorProps) {
  const { data } = useData();
  // Writing anything about the workout means it happened: tick it off (never un-tick).
  const log = (p: DayLogPatch, v: string | null) => patch(v ? { ...p, metconDone: true } : p);
  const listId = useId();
  const bestId = useId();
  const names = useMemo(() => benchmarkNames(data.days), [data.days]);
  const current = day.metconBenchmark ? normalizeBenchmark(day.metconBenchmark) : null;
  // Recent names to pick from: the ones not already entered, a handful at most.
  const recent = names.filter((n) => normalizeBenchmark(n) !== current).slice(0, 6);
  const best = useMemo(
    () => (day.metconBenchmark ? benchmarkBest(data.days, day.metconBenchmark, day.date) : null),
    [data.days, day.metconBenchmark, day.date],
  );
  const [historyOpen, setHistoryOpen] = useState(false);
  const score = day.metconScore ? parseScore(day.metconScore) : null;
  const verdict = best?.parsed && score ? compareScore(score, best.parsed) : null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="label mb-2">Benchmark</div>
          <TextField
            ariaLabel="Benchmark name"
            value={day.metconBenchmark}
            onCommit={(v) => log({ metconBenchmark: v }, v)}
            placeholder="e.g. Fran"
            list={names.length ? listId : undefined}
            describedBy={best ? bestId : undefined}
          />
          {names.length > 0 && (
            <datalist id={listId}>
              {names.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          )}
        </div>
        <div>
          <div className="label mb-2">Score</div>
          <TextField
            ariaLabel="Benchmark score"
            value={day.metconScore}
            onCommit={(v) => log({ metconScore: v }, v)}
            placeholder="3:45 · 12+4"
            className="num"
            describedBy={best ? bestId : undefined}
          />
        </div>
      </div>
      <JournalText
        ariaLabel="Metcon notes"
        value={day.metconNotes}
        onSave={(v) => log({ metconNotes: v }, v)}
        placeholder="The workout, how it went…"
        className="text-base"
        minRows={2}
      />
      {/* Under the notes, not between the fields and them: the best so far (once there is a name) and the recent
          names (while there is none) come and go as the name is saved — as its field is left, perhaps for the notes. */}
      {day.metconBenchmark && (
        <div id={bestId} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs" aria-live="polite">
          {best ? (
            // Opens every result for this benchmark.
            <button
              type="button"
              aria-haspopup="dialog"
              onClick={() => setHistoryOpen(true)}
              // hit-lg: the tap target reaches 48px tall around the one-line text.
              className="hit-lg -my-1 rounded-sm py-1 text-left text-mute underline decoration-white/20 decoration-dotted underline-offset-4"
            >
              {/* Once this day beats it, it's the previous best. */}
              {verdict?.tone === "gold" ? "Prev. best" : "Best"} <span className="num text-fg-2">{best.score}</span> ·{" "}
              {formatShortDate(best.date, best.date.slice(0, 4) !== day.date.slice(0, 4))}
              <span className="sr-only">. Show all results</span>
            </button>
          ) : (
            <span className="text-mute">First time logged — this sets the mark.</span>
          )}
          {verdict && <span className={clsx("num", verdict.tone === "gold" ? "text-gold" : "text-mute")}>{verdict.text}</span>}
        </div>
      )}
      {!day.metconBenchmark && recent.length > 0 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Recent benchmarks">
          {recent.map((n) => (
            <button key={n} type="button" className="chip bg-white/[0.05] text-fg-2" onClick={() => log({ metconBenchmark: n }, n)}>
              {n}
            </button>
          ))}
        </div>
      )}
      {day.metconBenchmark && (
        <BenchmarkHistorySheet
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          name={day.metconBenchmark}
          days={data.days}
          date={day.date}
        />
      )}
    </div>
  );
}
