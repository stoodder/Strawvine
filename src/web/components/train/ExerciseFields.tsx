/**
 * The exercise controls shared by the create card (AddExerciseSheet) and the Edit exercise sheet:
 * category, "Measured in" and, off the main lifts, the load.
 */
import clsx from "clsx";
import type { ReactNode } from "react";
import type { Exercise, ExerciseCategory, Measure } from "../../../shared/schemas";
import { isMainLift, isWeighted } from "../../../shared/session";
import { ChoiceChip } from "../ui";

/** One name per category, used for both the chips and the list tags. */
export const CATEGORIES: Array<[ExerciseCategory, string]> = [
  ["accessory", "Accessory"],
  ["core", "Core"],
  ["carry", "Carry"],
  ["primary", "Barbell"],
  ["conditioning", "Conditioning"],
];
export const CATEGORY_LABEL = Object.fromEntries(CATEGORIES) as Record<ExerciseCategory, string>;
export const MEASURES: Array<[Measure, string]> = [
  ["reps", "Reps"],
  ["seconds", "Time"],
  ["meters", "Distance"],
];
export const MEASURE_WORD: Record<Measure, string> = { reps: "reps", seconds: "time", meters: "distance" };

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

export function ChipGroup<K extends string>({
  id,
  label,
  options,
  value,
  onChange,
  locked,
  describedBy,
}: {
  id: string;
  label: string;
  options: Array<[K, string]>;
  value: K;
  onChange: (k: K) => void;
  locked?: boolean;
  describedBy?: string;
}) {
  return (
    <>
      <div className="label mt-3 mb-1.5" id={id}>
        {label}
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-labelledby={id} aria-describedby={describedBy}>
        {options.map(([k, l]) => (
          <ChoiceChip key={k} on={value === k} disabled={locked} onClick={() => onChange(k)}>
            {l}
          </ChoiceChip>
        ))}
      </div>
    </>
  );
}

/**
 * Category, "Measured in" and Load chip groups (labelled `${idPrefix}-category` …). The Load
 * choice is offered only off the main lifts (`isMainLift`): a main lift is always weighted.
 * `locked` locks the category and measure (a lift the program calculates: aria-disabled chips); `lockNoteId` names
 * the note that says why. `measureNote` / `loadNote` add a line under those groups.
 */
export function ExerciseFields({
  idPrefix,
  category,
  measure,
  weighted,
  tracksMax = false,
  onCategory,
  onMeasure,
  onWeighted,
  locked,
  lockNoteId,
  measureNote,
  loadNote,
  beforeLoad,
}: {
  idPrefix: string;
  category: ExerciseCategory;
  measure: Measure;
  weighted: boolean;
  tracksMax?: boolean;
  onCategory: (c: ExerciseCategory) => void;
  onMeasure: (m: Measure) => void;
  onWeighted: (w: boolean) => void;
  locked?: boolean;
  lockNoteId?: string;
  measureNote?: ReactNode;
  loadNote?: string;
  /** Rendered between the measure and the load (the edit sheet's max tracking, which decides whether the load is a choice). */
  beforeLoad?: ReactNode;
}) {
  const loadChoice = !isMainLift({ tracksMax, category });
  return (
    <>
      <ChipGroup
        id={`${idPrefix}-category`}
        label="Category"
        options={CATEGORIES}
        value={category}
        onChange={onCategory}
        locked={locked}
        describedBy={locked ? lockNoteId : undefined}
      />
      <ChipGroup
        id={`${idPrefix}-measure`}
        label="Measured in"
        options={MEASURES}
        value={measure}
        onChange={onMeasure}
        locked={locked}
        describedBy={locked ? lockNoteId : measureNote ? `${idPrefix}-measure-note` : undefined}
      />
      {measureNote && (
        <p id={`${idPrefix}-measure-note`} className="mt-1.5 text-xs text-fg-2">
          {measureNote}
        </p>
      )}
      {beforeLoad}
      {loadChoice && (
        <>
          <div className="label mt-3 mb-1.5" id={`${idPrefix}-load`}>
            Load
          </div>
          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-labelledby={`${idPrefix}-load`}
            aria-describedby={`${idPrefix}-load-hint`}
          >
            <ChoiceChip on={weighted} onClick={() => onWeighted(true)}>
              Weighted
            </ChoiceChip>
            <ChoiceChip on={!weighted} onClick={() => onWeighted(false)}>
              Unweighted
            </ChoiceChip>
          </div>
          <p id={`${idPrefix}-load-hint`} className="mt-1.5 text-xs text-fg-2">
            {weighted ? "Log a load (lb) with each set" : `No load — just the ${MEASURE_WORD[measure]}`}
            {loadNote ? ` · ${loadNote}` : ""}
          </p>
        </>
      )}
    </>
  );
}
