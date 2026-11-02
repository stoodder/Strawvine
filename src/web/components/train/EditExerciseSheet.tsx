import { useId, useState } from "react";
import { Archive, ArchiveRestore } from "lucide-react";
import { WEEKDAY_SHORT } from "../../../shared/dates";
import { exerciseDraft, exerciseEditPatch, exerciseLocks, type ExerciseDraft } from "../../../shared/exerciseEdit";
import type { Exercise, Measure } from "../../../shared/schemas";
import { defaultTarget, isWeighted } from "../../../shared/session";
import { useData, useEditExercise } from "../../lib/store";
import { useToast } from "../Toast";
import { Sheet } from "../ui";
import { ChipGroup, ExerciseFields } from "./ExerciseFields";

const UNIT: Record<Measure, string> = { reps: "reps", seconds: "seconds", meters: "meters" };
const MAX_OPTIONS: Array<["on" | "off", string]> = [
  ["on", "Tracked"],
  ["off", "Not tracked"],
];

/** "Mon", "Mon & Thu", "Mon, Wed & Fri". */
const dayList = (days: number[]) => {
  const names = days.map((d) => WEEKDAY_SHORT[d]!);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} & ${names.at(-1)}` : (names[0] ?? "");
};

/**
 * Edit an exercise from the library (Settings) or a session (Train): its name, category, measure,
 * load and max tracking, or archive it — the create card's controls and rules (`ExerciseFields`).
 * Saving sends only what changed, as one patch (`exerciseEditPatch`); a lift the program calculates
 * keeps its category, measure and max, and stays in the library (`exerciseLocks`).
 */
export function EditExerciseSheet({ exercise, open, onClose }: { exercise: Exercise | null; open: boolean; onClose: () => void }) {
  const { data } = useData();
  const editExercise = useEditExercise();
  const toast = useToast();
  const id = useId();
  const [draft, setDraft] = useState<ExerciseDraft | null>(exercise ? exerciseDraft(exercise) : null);
  // A different exercise (or the sheet reopening) starts from what is saved now.
  const formKey = open ? (exercise?.id ?? null) : null;
  const [shownKey, setShownKey] = useState(formKey);
  if (shownKey !== formKey) {
    setShownKey(formKey);
    setDraft(exercise ? exerciseDraft(exercise) : null);
  }
  if (!exercise || !draft) return null;

  const locks = exerciseLocks(exercise, data.settings);
  const set = (patch: Partial<ExerciseDraft>) => setDraft({ ...draft, ...patch });
  const blank = !draft.name.trim();
  const patch = exerciseEditPatch(exercise, draft, locks);
  const changed = Object.keys(patch).length > 0;
  const name = draft.name.trim() || exercise.name;

  const save = (p = patch) => {
    editExercise(exercise.id, p);
    onClose();
    if (p.archived)
      toast.show({
        message: `${name} archived`,
        action: { label: "Undo", onAction: () => editExercise(exercise.id, { archived: false }) },
      });
    else if (p.weighted === false)
      toast.show({
        message: `${name} no longer tracks load — logged loads are kept`,
        action: { label: "Undo", onAction: () => editExercise(exercise.id, { weighted: true }) },
      });
  };

  const lockNoteId = `${id}-lock`;
  const measureNote =
    draft.measure !== exercise.measure
      ? `Past sessions stay in ${UNIT[exercise.measure]} · new sets start at ${defaultTarget(draft.measure)} ${UNIT[draft.measure]}`
      : undefined;

  return (
    <Sheet open={open} onClose={onClose} title="Edit exercise">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (changed && !blank) save();
        }}
      >
        <label className="label mb-1.5 block" htmlFor={`${id}-name`}>
          Name
        </label>
        <input
          id={`${id}-name`}
          value={draft.name}
          maxLength={80}
          enterKeyHint="done"
          aria-invalid={blank || undefined}
          aria-describedby={blank ? `${id}-name-error` : undefined}
          onChange={(e) => set({ name: e.target.value })}
          className="field h-11 w-full rounded-xl bg-white/[0.05] px-3 text-base"
        />
        {blank && (
          <p id={`${id}-name-error`} className="mt-1.5 text-xs text-warn">
            An exercise needs a name.
          </p>
        )}

        {locks.structure && (
          <p id={lockNoteId} className="mt-4 text-xs text-fg-2">
            {dayList(locks.programDays)}&rsquo;s main lift: the program calculates it from its max, so its category, measure and max stay as
            they are. Change the weekly layout to free them.
          </p>
        )}

        <div className="mt-2">
          <ExerciseFields
            idPrefix={id}
            category={draft.category}
            measure={draft.measure}
            weighted={draft.weighted}
            tracksMax={draft.tracksMax}
            onCategory={(category) => set({ category })}
            onMeasure={(measure) => set({ measure })}
            onWeighted={(weighted) => set({ weighted })}
            locked={locks.structure}
            lockNoteId={lockNoteId}
            measureNote={measureNote}
            loadNote={isWeighted(exercise) && !draft.weighted ? "logged loads are kept" : undefined}
            beforeLoad={
              <>
                <ChipGroup
                  id={`${id}-max`}
                  label="Max"
                  options={MAX_OPTIONS}
                  value={draft.tracksMax ? "on" : "off"}
                  onChange={(v) => set({ tracksMax: v === "on" })}
                  locked={locks.structure || locks.keepsMax}
                  describedBy={locks.structure ? lockNoteId : `${id}-max-hint`}
                />
                {!locks.structure && (
                  <p id={`${id}-max-hint`} className="mt-1.5 text-xs text-fg-2">
                    {locks.keepsMax
                      ? "A strength target follows its max"
                      : draft.tracksMax
                        ? "Record maxes and set strength targets · always weighted"
                        : "Track it to record maxes and set strength targets"}
                  </p>
                )}
              </>
            }
          />
        </div>

        <div className="mt-6 flex flex-wrap gap-3">
          <button
            type="button"
            className="btn-ghost shrink-0"
            disabled={(locks.structure && !exercise.archived) || blank}
            aria-describedby={locks.structure && !exercise.archived ? lockNoteId : undefined}
            onClick={() => save(exerciseEditPatch(exercise, { ...draft, archived: !exercise.archived }, locks))}
          >
            {exercise.archived ? <ArchiveRestore size={16} aria-hidden /> : <Archive size={16} aria-hidden />}
            {exercise.archived ? "Restore" : "Archive"}
          </button>
          <button type="submit" className="btn-primary min-w-0 flex-1" disabled={!changed || blank}>
            Save
          </button>
        </div>
      </form>
    </Sheet>
  );
}
