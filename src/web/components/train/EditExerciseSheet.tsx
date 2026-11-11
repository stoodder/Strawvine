import { useEffect, useId, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { Archive, ArchiveRestore } from "lucide-react";
import {
  exerciseDraft,
  exerciseEditPatch,
  exerciseLocks,
  programDayList,
  type ExerciseDraft,
  type ExerciseEditPatch,
} from "../../../shared/exerciseEdit";
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

/**
 * Edit an exercise from the library (Program) or a session (Train): its name, category, measure,
 * load and max tracking, or archive it — the create card's controls and rules (`ExerciseFields`).
 * Saving sends only what changed, as one patch (`exerciseEditPatch`); archiving sends only
 * `archived`. A lift the program calculates keeps its category, measure and max, and stays in the
 * library (`exerciseLocks`; the server refuses those edits too). Closing with unsaved changes
 * (Escape, the backdrop, a swipe, Close) asks first. `onClose` gets the patch that was saved, if any.
 */
export function EditExerciseSheet({
  exercise,
  open,
  onClose,
}: {
  exercise: Exercise | null;
  open: boolean;
  onClose: (saved?: ExerciseEditPatch) => void;
}) {
  const { data } = useData();
  const location = useLocation();
  const editExercise = useEditExercise();
  const toast = useToast();
  const id = useId();
  const [draft, setDraft] = useState<ExerciseDraft | null>(exercise ? exerciseDraft(exercise) : null);
  /** "Discard changes?" is showing; what had focus when it opened (it gets it back on "Keep editing"). */
  const [confirming, setConfirming] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  // A different exercise (or the sheet reopening) starts from what is saved now.
  const formKey = open ? (exercise?.id ?? null) : null;
  const [shownKey, setShownKey] = useState(formKey);
  if (shownKey !== formKey) {
    setShownKey(formKey);
    setDraft(exercise ? exerciseDraft(exercise) : null);
    setConfirming(false);
  }
  useEffect(() => {
    if (confirming) keepRef.current?.focus();
  }, [confirming]);
  if (!exercise || !draft) return null;

  const locks = exerciseLocks(exercise, data.settings);
  const set = (patch: Partial<ExerciseDraft>) => setDraft({ ...draft, ...patch });
  const blank = !draft.name.trim();
  const patch = exerciseEditPatch(exercise, draft, locks);
  const changed = Object.keys(patch).length > 0;
  /** Something would be lost by closing now (a cleared name counts). */
  const dirty = changed || blank;
  const name = draft.name.trim() || exercise.name;
  const archiveLocked = locks.structure && !exercise.archived;

  const keepEditing = () => {
    setConfirming(false);
    const back = returnFocus.current;
    returnFocus.current = null;
    // After the confirm row unmounts (it may have held focus).
    requestAnimationFrame(() => (back?.isConnected ? back : document.getElementById(`${id}-name`))?.focus());
  };
  /** Escape, the backdrop, a swipe down and Close: with unsaved changes, ask first. */
  const requestClose = () => {
    if (confirming) return keepEditing();
    if (!dirty) return onClose();
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setConfirming(true);
  };

  const save = (p: ExerciseEditPatch) => {
    editExercise(exercise.id, p);
    onClose(p);
    if (p.archived)
      toast.show({
        message: `${exercise.name} archived`,
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
    <Sheet open={open} onClose={requestClose} title={`Edit ${exercise.name}`}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          // Enter in an unchanged (or blank) name does nothing: there's nothing to save.
          if (changed && !blank) save(patch);
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
            {programDayList(locks.programDays)}&rsquo;s main lift: the program calculates it from its max, so its category, measure and max
            stay as they are and it can&rsquo;t be archived. Change the{" "}
            {/* Program's back control returns to where the sheet was opened (a Train day). Following the link closes the sheet. */}
            <Link
              to="/program#layout"
              state={{ from: location.pathname }}
              className="text-accent underline underline-offset-2"
              onClick={() => onClose()}
            >
              weekly layout
            </Link>{" "}
            to free them.
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

        {confirming ? (
          // In place of the buttons, kept in view at the bottom of the sheet however far it's
          // scrolled: it reaches down over the panel's bottom padding (and the safe area).
          <div
            role="group"
            aria-labelledby={`${id}-discard`}
            className="sticky -bottom-[calc(env(safe-area-inset-bottom)+1.5rem)] -mx-5 mt-6 -mb-[calc(env(safe-area-inset-bottom)+1.5rem)] bg-ink-850 px-5 pt-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] shadow-[0_-16px_24px_-12px_rgb(0_0_0/0.7)]"
          >
            <p id={`${id}-discard`} className="mb-3 text-sm">
              Discard changes?
            </p>
            <div className="flex gap-3">
              <button ref={keepRef} type="button" className="btn-primary min-w-0 flex-1" onClick={keepEditing}>
                Keep editing
              </button>
              <button type="button" className="btn min-w-0 flex-1 bg-warn/[0.08] text-warn" onClick={() => onClose()}>
                Discard
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="button"
              className="btn-ghost shrink-0 aria-disabled:cursor-default aria-disabled:text-mute aria-disabled:hover:bg-white/[0.04]"
              // Focusable while locked (the note says why); activating it does nothing.
              aria-disabled={archiveLocked || undefined}
              aria-describedby={archiveLocked ? lockNoteId : undefined}
              onClick={() => {
                if (!archiveLocked) save({ archived: !exercise.archived });
              }}
            >
              {exercise.archived ? <ArchiveRestore size={16} aria-hidden /> : <Archive size={16} aria-hidden />}
              {exercise.archived ? "Restore" : "Archive"}
            </button>
            <button type="submit" className="btn-primary min-w-0 flex-1" disabled={!changed || blank}>
              Save
            </button>
          </div>
        )}
      </form>
    </Sheet>
  );
}
