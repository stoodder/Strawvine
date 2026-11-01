import clsx from "clsx";
import { ClipboardPaste } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import { benchmarkBest, benchmarkNames, isBetterScore, normalizeBenchmark, parseScore, type ParsedScore } from "../../../shared/benchmarks";
import { formatShortDate } from "../../../shared/dates";
import type { DayLog, DayLogPatch } from "../../../shared/schemas";
import { fmt } from "../../lib/format";
import { useData } from "../../lib/store";
import { useToast } from "../Toast";
import { BoxNumber, DotScale, NumberInput } from "../ui";
import { useFocusAfter } from "../useFocusAfter";
import { JournalText } from "../TextArea";
import { SleepField, TextField } from "./fields";
import { filledCount, parseNutrition } from "./parseNutrition";
import { PasteTotals, readClipboard, type PasteState } from "./PasteTotals";

/**
 * Inline editors for the day checklist. Every field is controlled by the day's saved values
 * and the whole checklist is re-keyed per date, so an editor never carries one day's entry
 * into another.
 */
export type EditorProps = { day: DayLog; patch: (p: DayLogPatch) => void };

export function MorningEditor({ day, patch }: EditorProps) {
  return (
    <div className="space-y-6">
      <div className="flex items-baseline gap-2">
        <NumberInput
          ariaLabel="Morning weight"
          value={day.weightLb}
          onCommit={(v) => patch({ weightLb: v })}
          decimals={1}
          placeholder="000.0"
          inputClassName="text-5xl font-light tracking-tight"
          autoFocus={day.weightLb === null}
          min={50}
          max={1000}
        />
        <span className="text-sm text-mute">lb</span>
      </div>
      <div className="grid grid-cols-3 gap-4">
        <div>
          <div className="label mb-2">Sleep</div>
          <SleepField value={day.sleepMinutes} onCommit={(v) => patch({ sleepMinutes: v })} />
        </div>
        <div>
          <div className="label mb-2">Score</div>
          <BoxNumber
            ariaLabel="Sleep score"
            value={day.sleepScore}
            onCommit={(v) => patch({ sleepScore: v })}
            min={0}
            max={100}
            className="w-full"
            align="left"
          />
        </div>
        <div>
          <div className="label mb-2">HRV</div>
          <BoxNumber
            ariaLabel="HRV"
            value={day.hrvMs}
            onCommit={(v) => patch({ hrvMs: v })}
            min={0}
            max={500}
            className="w-full"
            align="left"
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-x-8 gap-y-4">
        <DotScale label="Energy" lowLabel="drained" highLabel="fresh" value={day.energy} onChange={(v) => patch({ energy: v })} />
        <DotScale label="Soreness" lowLabel="none" highLabel="very sore" value={day.soreness} onChange={(v) => patch({ soreness: v })} />
      </div>
    </div>
  );
}

export function FuelEditor({ day, patch }: EditorProps) {
  const fromMacros =
    day.proteinG !== null && day.carbsG !== null && day.fatG !== null ? Math.round(day.proteinG * 4 + day.carbsG * 4 + day.fatG * 9) : null;
  const [showMicros, setShowMicros] = useState(!!day.micros && Object.keys(day.micros).length > 0);
  // Totals from a meal app, waiting for one-tap confirm.
  const [paste, setPaste] = useState<PasteState | null>(null);
  const toast = useToast();
  const rootRef = useRef<HTMLDivElement>(null);
  const focusAfter = useFocusAfter();
  // The Paste button unmounts while the panel is open: when the panel closes, focus goes back to
  // it (or to Calories, should it not be there).
  const closePaste = () => {
    setPaste(null);
    focusAfter(
      () =>
        rootRef.current?.querySelector<HTMLElement>("[data-paste-trigger]") ??
        rootRef.current?.querySelector<HTMLElement>('input[aria-label="Calories"]') ??
        null,
    );
  };
  const applyPaste = (p: DayLogPatch) => {
    // What the paste overwrites, so it can be put back.
    const before: DayLogPatch = {};
    for (const k of ["calories", "proteinG", "carbsG", "fatG"] as const) if (k in p) before[k] = day[k];
    const changed = (Object.keys(before) as Array<keyof typeof before>).some((k) => before[k] !== p[k]);
    patch(p);
    closePaste();
    if (changed && Object.values(before).some((v) => v !== null))
      toast.show({ message: "Totals replaced", action: { label: "Undo", onAction: () => patch(before) } });
  };

  const openPaste = async () => {
    const text = await readClipboard();
    // Something readable on the clipboard goes straight to confirm; otherwise paste by hand.
    setPaste(text && parseNutrition(text) ? { text, manual: false } : { text: "", manual: true });
  };

  return (
    <div
      ref={rootRef}
      className="space-y-5"
      // Pasting several numbers into any Fuel field ("2140 212 150 70") offers them all at once.
      onPasteCapture={(e) => {
        if ((e.target as HTMLElement).closest("[data-paste-area]")) return;
        const text = e.clipboardData.getData("text/plain");
        if (filledCount(parseNutrition(text)) < 2) return;
        e.preventDefault();
        setPaste({ text, manual: false });
      }}
    >
      <div className="flex items-baseline gap-2">
        <NumberInput
          ariaLabel="Calories"
          value={day.calories}
          onCommit={(v) => patch({ calories: v })}
          placeholder="0"
          inputClassName="text-5xl font-light tracking-tight"
          min={0}
          max={20000}
        />
        <span className="text-sm text-mute">kcal</span>
        {!paste && (
          <button
            type="button"
            data-paste-trigger
            aria-label="Paste totals from a meal app"
            // 44px target; looks like the label it was.
            className="label -mr-2 ml-auto inline-flex min-h-11 items-center gap-1.5 self-center px-2 text-mute"
            onClick={() => void openPaste()}
          >
            <ClipboardPaste size={13} aria-hidden />
            Paste
          </button>
        )}
      </div>
      {paste && (
        <PasteTotals
          state={paste}
          current={day}
          onText={(text) => setPaste({ text, manual: true })}
          onUse={applyPaste}
          onClose={closePaste}
        />
      )}
      {!paste && fromMacros !== null && fromMacros !== day.calories && (
        <button type="button" className="chip bg-white/[0.05] text-fg-2" onClick={() => patch({ calories: fromMacros })}>
          Use {fmt(fromMacros)} from macros
        </button>
      )}
      <div className="grid grid-cols-3 gap-4">
        {(
          [
            ["proteinG", "Protein"],
            ["carbsG", "Carbs"],
            ["fatG", "Fat"],
          ] as const
        ).map(([k, label]) => (
          <div key={k}>
            <div className="label mb-2">{label}</div>
            <BoxNumber
              ariaLabel={label}
              value={day[k]}
              onCommit={(v) => patch({ [k]: v })}
              unit="g"
              className="w-full"
              align="left"
              min={0}
            />
          </div>
        ))}
      </div>
      {showMicros ? (
        <Micros micros={day.micros} onChange={(m) => patch({ micros: m })} />
      ) : (
        <button type="button" className="label -my-3 flex min-h-11 items-center text-mute" onClick={() => setShowMicros(true)}>
          + Micronutrients
        </button>
      )}
    </div>
  );
}

const COMMON_MICROS = ["Fiber g", "Sugar g", "Sodium mg", "Potassium mg", "Magnesium mg", "Calcium mg", "Iron mg", "Vitamin D IU"];

function Micros({ micros, onChange }: { micros: Record<string, number> | null; onChange: (m: Record<string, number> | null) => void }) {
  const m = micros ?? {};
  const keys = [...new Set([...COMMON_MICROS, ...Object.keys(m)])];
  return (
    <div>
      <div className="label mb-2">Micronutrients</div>
      <div className="grid grid-cols-2 gap-x-5">
        {keys.map((k) => (
          <div key={k} className="flex items-center justify-between gap-2 py-1.5">
            <span className="min-w-0 truncate text-xs text-fg-2">{k}</span>
            <NumberInput
              ariaLabel={k}
              value={m[k] ?? null}
              onCommit={(v) => {
                const next = { ...m };
                if (v === null) delete next[k];
                else next[k] = v;
                onChange(Object.keys(next).length ? next : null);
              }}
              inputClassName="w-16 text-right text-base"
              decimals={1}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export function StepsEditor({ day, patch, target }: EditorProps & { target: number }) {
  return (
    <div className="flex items-baseline gap-2">
      <NumberInput
        ariaLabel="Steps"
        value={day.steps}
        onCommit={(v) => patch({ steps: v })}
        placeholder="0"
        inputClassName="text-5xl font-light tracking-tight"
        min={0}
        max={200000}
      />
      <span className="text-sm whitespace-nowrap text-mute">/ {fmt(target)}</span>
    </div>
  );
}

export function Zone2Editor({ day, patch }: EditorProps) {
  return (
    <div className="flex items-baseline gap-2">
      <NumberInput
        ariaLabel="Zone 2 minutes"
        value={day.zone2Minutes}
        onCommit={(v) => patch({ zone2Minutes: v, zone2Done: v !== null && v > 0 ? true : day.zone2Done })}
        placeholder="30"
        inputClassName="text-5xl font-light tracking-tight"
        min={0}
        max={600}
      />
      <span className="text-sm text-mute">min</span>
    </div>
  );
}

export function MetconEditor({ day, patch }: EditorProps) {
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
      {day.metconBenchmark && (
        <div id={bestId} className="-mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs" aria-live="polite">
          {best ? (
            <span className="text-mute">
              Best <span className="num text-fg-2">{best.score}</span> ·{" "}
              {formatShortDate(best.date, best.date.slice(0, 4) !== day.date.slice(0, 4))}
            </span>
          ) : (
            <span className="text-mute">First time logged — this sets the mark.</span>
          )}
          {verdict && <span className={clsx("num", verdict.tone === "gold" ? "text-gold" : "text-mute")}>{verdict.text}</span>}
        </div>
      )}
      {!day.metconBenchmark && recent.length > 0 && (
        <div className="-mt-1 flex flex-wrap gap-2" role="group" aria-label="Recent benchmarks">
          {recent.map((n) => (
            <button key={n} type="button" className="chip bg-white/[0.05] text-fg-2" onClick={() => log({ metconBenchmark: n }, n)}>
              {n}
            </button>
          ))}
        </div>
      )}
      <JournalText
        ariaLabel="Metcon notes"
        value={day.metconNotes}
        onSave={(v) => log({ metconNotes: v }, v)}
        placeholder="The workout, how it went…"
        className="text-base"
        minRows={2}
      />
    </div>
  );
}

const mss = (sec: number) => {
  const s = Math.round(Math.abs(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

/** Today's score against the previous best: "New best" (gold), "Ties best", or how far off. */
function compareScore(score: ParsedScore, best: ParsedScore): { text: string; tone: "gold" | "mute" } | null {
  if (isBetterScore(score, best)) return { text: "New best", tone: "gold" };
  if (score.kind !== best.kind) return null;
  if (score.value === best.value) return { text: "Ties best", tone: "mute" };
  const d = Math.abs(score.value - best.value);
  switch (score.kind) {
    case "time":
      return { text: `+${mss(d)} off best`, tone: "mute" };
    case "rounds": {
      const rounds = Math.floor(best.value / 1000) - Math.floor(score.value / 1000);
      const text = rounds > 0 ? `−${rounds} ${rounds === 1 ? "round" : "rounds"}` : `−${d} ${d === 1 ? "rep" : "reps"}`;
      return { text: `${text} off best`, tone: "mute" };
    }
    case "load":
      return { text: `−${fmt(d, d % 1 ? 1 : 0)} lb off best`, tone: "mute" };
    case "reps":
      return { text: `−${fmt(d, d % 1 ? 1 : 0)} ${d === 1 ? "rep" : "reps"} off best`, tone: "mute" };
  }
}
