import clsx from "clsx";
import { useEffect, useMemo, useState } from "react";
import { Check, Plus, Search } from "lucide-react";
import type { Exercise, ExerciseCategory, Measure } from "../../../shared/schemas";
import { isWeighted } from "../../../shared/session";
import { Sheet } from "../ui";

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
const MEASURE_WORD: Record<Measure, string> = { reps: "reps", seconds: "time", meters: "distance" };

/** A main lift (tracks a max, or a barbell lift): its sets always carry a load, so weighted isn't a choice. */
export const isMainLift = (e: Pick<Exercise, "tracksMax" | "category">) => e.tracksMax || e.category === "primary";

/**
 * List tag: the category, then the measure when it isn't reps, then "weighted" when the exercise
 * tracks a load — never on a main lift, whose sets always carry one ("Barbell", "Accessory ·
 * weighted", "Core · time", "Carry · distance · weighted").
 */
export const exerciseTag = (e: Exercise) =>
  [
    CATEGORY_LABEL[e.category] ?? e.category,
    e.measure === "reps" ? null : MEASURE_WORD[e.measure],
    isWeighted(e) && !isMainLift(e) ? "weighted" : null,
  ]
    .filter(Boolean)
    .join(" · ");

/**
 * What "weighted" starts as in the create card, until the person picks: loaded for rep work
 * (curls, rows) and carries; unloaded for holds, runs and core or conditioning reps (a plank, a
 * shuttle run, a sit-up) — a weighted dead hang is one tap away. (A barbell lift is always
 * weighted: the card offers no choice for it.)
 */
export function defaultWeighted(measure: Measure, category: ExerciseCategory): boolean {
  if (category === "carry") return true;
  return measure === "reps" && category !== "core" && category !== "conditioning";
}

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
  // Follows the measure and category (defaultWeighted) until the person picks; null = not picked.
  // A barbell lift is always weighted, like a main lift in Settings: no choice shown.
  const [weightedPick, setWeightedPick] = useState<boolean | null>(null);
  const loadChoice = !isMainLift({ tracksMax: false, category });
  const weighted = !loadChoice || (weightedPick ?? defaultWeighted(measure, category));
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

  // A fresh create card each time the sheet opens: Train keeps the sheet mounted, so the last
  // pick would otherwise carry over to the next exercise.
  const reset = () => {
    setQ("");
    setCategory("accessory");
    setMeasure("reps");
    setWeightedPick(null);
  };
  useEffect(() => {
    if (!open) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = () => {
    reset();
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
          <div className="text-sm wrap-anywhere">
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
          {loadChoice && (
            <>
              <div className="label mt-3 mb-1.5" id="new-ex-load">
                Load
              </div>
              <div
                className="flex flex-wrap gap-2"
                role="group"
                aria-labelledby="new-ex-load"
                aria-describedby="new-ex-load-hint"
              >
                <ChoiceChip on={weighted} onClick={() => setWeightedPick(true)}>
                  Weighted
                </ChoiceChip>
                <ChoiceChip on={!weighted} onClick={() => setWeightedPick(false)}>
                  Unweighted
                </ChoiceChip>
              </div>
              <p id="new-ex-load-hint" className="mt-1.5 text-xs text-fg-2">
                {weighted ? "Log a load (lb) with each set" : `No load — just the ${MEASURE_WORD[measure]}`}
              </p>
            </>
          )}
          <button
            type="button"
            disabled={busy}
            className="btn-primary mt-4 w-full"
            onClick={async () => {
              setBusy(true);
              try {
                await onCreate({ name: q.trim(), category, measure, weighted });
                reset();
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
              // The tag drops under the name (right-aligned) when both don't fit on one line.
              className="tap flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 py-3.5 text-left"
              onClick={() => {
                onPick(e);
                setQ("");
              }}
            >
              <span className="min-w-0 text-[0.9375rem] wrap-anywhere">{e.name}</span>
              <span className="label ml-auto text-right">{exerciseTag(e)}</span>
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
