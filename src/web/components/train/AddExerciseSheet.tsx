import clsx from "clsx";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Plus, Search } from "lucide-react";
import type { Exercise, ExerciseCategory, Measure } from "../../../shared/schemas";
import { isMainLift } from "../../../shared/session";
import { Sheet } from "../ui";
import { defaultWeighted, ExerciseFields, exerciseTag } from "./ExerciseFields";

/**
 * How the list shows an exercise that this add treats differently (adding to a superset): one
 * that can't be added (`disabled`: already in it, the main lift), or one that moves here from
 * elsewhere in the workout. The note takes the tag's place.
 */
export interface ExerciseMark {
  note: string;
  disabled: boolean;
}

export function AddExerciseSheet({
  open,
  onClose,
  title,
  exercises,
  recentIds,
  marks,
  onPick,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  exercises: ReadonlyArray<Exercise>;
  recentIds: number[];
  /** By exercise id. Marked ones that can be picked are listed first, those that can't last. */
  marks?: ReadonlyMap<number, ExerciseMark>;
  onPick: (ex: Exercise) => void;
  onCreate: (input: { name: string; category: ExerciseCategory; measure: Measure; weighted: boolean }) => Promise<void>;
}) {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<ExerciseCategory>("accessory");
  const [measure, setMeasure] = useState<Measure>("reps");
  // Follows the measure and category (defaultWeighted) until the person picks; null = not picked.
  // A barbell lift is always weighted, like a main lift in the exercise library: no choice shown.
  const [weightedPick, setWeightedPick] = useState<boolean | null>(null);
  const loadChoice = !isMainLift({ tracksMax: false, category });
  const weighted = !loadChoice || (weightedPick ?? defaultWeighted(measure, category));
  const [busy, setBusy] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const id = useId();

  const list = useMemo(() => {
    const active = exercises.filter((e) => !e.archived);
    const needle = q.trim().toLowerCase();
    const matched = needle ? active.filter((e) => e.name.toLowerCase().includes(needle)) : active;
    const tier = (e: Exercise) => {
      const m = marks?.get(e.id);
      return m ? (m.disabled ? 2 : 0) : 1;
    };
    const rank = (e: Exercise) => {
      const r = recentIds.indexOf(e.id);
      return tier(e) * 1e9 + (r === -1 ? 1e6 + e.id : r);
    };
    return [...matched].sort((a, b) => rank(a) - rank(b));
  }, [exercises, q, recentIds, marks]);

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
    // Search first: the field has focus (and a phone's keyboard is up) as the sheet opens. Tall
    // so the list doesn't jump as it filters, but never taller than the room above a keyboard.
    <Sheet open={open} onClose={close} title={title} initialFocus={searchRef} className="min-h-[min(80dvh,var(--sheet-room,80dvh))]">
      <div className="box-field flex items-center gap-3 rounded-2xl bg-white/[0.05] px-4 py-3">
        <Search size={16} className="text-mute" aria-hidden />
        <input
          aria-label="Search or create exercise"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search or create…"
          className="field field-plain flex-1 text-base"
          ref={searchRef}
        />
      </div>

      {q.trim() && !exact && (
        <div className="mt-5 rounded-2xl bg-accent/[0.06] p-4 ring-1 ring-accent/20">
          <div className="text-sm wrap-anywhere">
            Create <span className="text-accent">“{q.trim()}”</span>
          </div>
          <ExerciseFields
            idPrefix="new-ex"
            category={category}
            measure={measure}
            weighted={weighted}
            onCategory={setCategory}
            onMeasure={setMeasure}
            onWeighted={setWeightedPick}
          />
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
        {list.map((e) => {
          const mark = marks?.get(e.id);
          return (
            <li key={e.id}>
              <button
                type="button"
                // Can't be added here: aria-disabled (still read, with why) and does nothing.
                aria-disabled={mark?.disabled || undefined}
                aria-describedby={mark ? `${id}-mark-${e.id}` : undefined}
                data-mark={mark ? (mark.disabled ? "disabled" : "moves") : undefined}
                // The tag drops under the name (right-aligned) when both don't fit on one line.
                className="tap flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 py-3.5 text-left aria-disabled:cursor-default"
                onClick={
                  mark?.disabled
                    ? undefined
                    : () => {
                        onPick(e);
                        setQ("");
                      }
                }
              >
                <span className={clsx("min-w-0 text-[0.9375rem] wrap-anywhere", mark?.disabled && "text-mute")}>{e.name}</span>
                {mark ? (
                  <span id={`${id}-mark-${e.id}`} className={clsx("label ml-auto text-right", !mark.disabled && "text-glow")}>
                    {mark.note}
                  </span>
                ) : (
                  <span className="label ml-auto text-right">{exerciseTag(e)}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}
