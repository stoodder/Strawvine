import clsx from "clsx";
import { useMemo, useState } from "react";
import { Check, Plus, Search } from "lucide-react";
import type { Exercise, ExerciseCategory, Measure } from "../../../shared/schemas";
import { isWeighted } from "../../../shared/session";
import { Field, Sheet, Toggle } from "../ui";

/** One name per category, used for both the create chips and the list tags. */
const CATEGORIES: Array<[ExerciseCategory, string]> = [
  ["accessory", "Accessory"],
  ["core", "Core"],
  ["carry", "Carry"],
  ["primary", "Barbell"],
  ["conditioning", "Conditioning"],
];
const CATEGORY_LABEL = Object.fromEntries(CATEGORIES) as Record<ExerciseCategory, string>;
const MEASURES: Array<[Measure, string]> = [
  ["reps", "Reps"],
  ["seconds", "Time"],
  ["meters", "Distance"],
];
/** List tag: category, plus what is logged besides reps — time, distance, load ("Carry · m · lb", "Core · s"). */
const exerciseTag = (e: Exercise) =>
  [
    CATEGORY_LABEL[e.category] ?? e.category,
    e.measure === "seconds" ? "s" : e.measure === "meters" ? "m" : null,
    isWeighted(e) ? "lb" : null,
  ]
    .filter(Boolean)
    .join(" · ");

function ChoiceChip({ on, onClick, children }: { on: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={clsx("chip min-h-9 gap-1", on ? "bg-accent text-accent-ink" : "bg-white/[0.05] text-fg-2")}
    >
      {on && <Check size={12} strokeWidth={3} aria-hidden />}
      {children}
    </button>
  );
}

export function AddExerciseSheet({
  open,
  onClose,
  title,
  exercises,
  recentIds,
  onPick,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  exercises: ReadonlyArray<Exercise>;
  recentIds: number[];
  onPick: (ex: Exercise) => void;
  onCreate: (input: { name: string; category: ExerciseCategory; measure: Measure; weighted: boolean }) => Promise<void>;
}) {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<ExerciseCategory>("accessory");
  const [measure, setMeasure] = useState<Measure>("reps");
  // On by default, whatever the measure: most accessory work is loaded, and the switch sits right
  // under the measure for a plank or a run.
  const [weighted, setWeighted] = useState(true);
  const [busy, setBusy] = useState(false);

  const list = useMemo(() => {
    const active = exercises.filter((e) => !e.archived);
    const needle = q.trim().toLowerCase();
    const matched = needle ? active.filter((e) => e.name.toLowerCase().includes(needle)) : active;
    const rank = (e: Exercise) => {
      const r = recentIds.indexOf(e.id);
      return r === -1 ? 1000 + e.id : r;
    };
    return [...matched].sort((a, b) => rank(a) - rank(b));
  }, [exercises, q, recentIds]);

  const exact = list.some((e) => e.name.toLowerCase() === q.trim().toLowerCase());

  const close = () => {
    setQ("");
    onClose();
  };

  return (
    <Sheet open={open} onClose={close} title={title} className="min-h-[80dvh]">
      <div className="box-field flex items-center gap-3 rounded-2xl bg-white/[0.05] px-4 py-3">
        <Search size={16} className="text-mute" aria-hidden />
        <input
          aria-label="Search or create exercise"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search or create…"
          className="field field-plain flex-1 text-base"
          autoFocus
        />
      </div>

      {q.trim() && !exact && (
        <div className="mt-5 rounded-2xl bg-accent/[0.06] p-4 ring-1 ring-accent/20">
          <div className="text-sm">
            Create <span className="text-accent">“{q.trim()}”</span>
          </div>
          <div className="label mt-3 mb-1.5" id="new-ex-category">
            Category
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-labelledby="new-ex-category">
            {CATEGORIES.map(([k, l]) => (
              <ChoiceChip key={k} on={category === k} onClick={() => setCategory(k)}>
                {l}
              </ChoiceChip>
            ))}
          </div>
          <div className="label mt-3 mb-1.5" id="new-ex-measure">
            Measured in
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-labelledby="new-ex-measure">
            {MEASURES.map(([k, l]) => (
              <ChoiceChip key={k} on={measure === k} onClick={() => setMeasure(k)}>
                {l}
              </ChoiceChip>
            ))}
          </div>
          <Field label="Weighted" hint="Log a load (lb) with each set">
            <Toggle label="Weighted" on={weighted} onChange={setWeighted} />
          </Field>
          <button
            type="button"
            disabled={busy}
            className="btn-primary mt-1 w-full"
            onClick={async () => {
              setBusy(true);
              try {
                await onCreate({ name: q.trim(), category, measure, weighted });
                setQ("");
              } finally {
                setBusy(false);
              }
            }}
          >
            <Plus size={16} /> Create & add
          </button>
        </div>
      )}

      <ul className="mt-4 divide-y divide-white/[0.04]">
        {list.map((e) => (
          <li key={e.id}>
            <button
              type="button"
              className="tap flex w-full items-center justify-between py-3.5 text-left"
              onClick={() => {
                onPick(e);
                setQ("");
              }}
            >
              <span className="text-[0.9375rem]">{e.name}</span>
              <span className="label shrink-0 pl-3">{exerciseTag(e)}</span>
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
