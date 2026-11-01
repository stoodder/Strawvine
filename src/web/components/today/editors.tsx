import { useState } from "react";
import type { DayLog, DayLogPatch } from "../../../shared/schemas";
import { fmt } from "../../lib/format";
import { BoxNumber, DotScale, NumberInput } from "../ui";
import { JournalText } from "../TextArea";
import { SleepField, TextField } from "./fields";

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
  return (
    <div className="space-y-5">
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
      </div>
      {fromMacros !== null && fromMacros !== day.calories && (
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
        <button type="button" className="label -my-2 py-2 text-mute" onClick={() => setShowMicros(true)}>
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
  // Writing anything about the workout means it happened: tick it off (never un-tick).
  const log = (p: DayLogPatch, v: string | null) => patch(v ? { ...p, metconDone: true } : p);
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
          />
        </div>
        <div>
          <div className="label mb-2">Score</div>
          <TextField
            ariaLabel="Benchmark score"
            value={day.metconScore}
            onCommit={(v) => log({ metconScore: v }, v)}
            placeholder="3:45 · 12+4"
            className="num"
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
    </div>
  );
}
