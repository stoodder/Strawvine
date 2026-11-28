/**
 * A list of exercise blocks on the Train page, as Accessories shows them: each block with its
 * exercises (a superset as one block, its members tagged A1, A2…), their set rows, hints and
 * "+ set" rows; a done block can fold to its summary row (`Foldable`, view state from `folds.ts`).
 *
 * The same list renders any filtered set of blocks — Accessories now; Core and Rehab later — from
 * the blocks it is given. It holds no state and saves nothing: what a control does goes through
 * `actions` (the screen's commit, sheets and focus), and what it shows comes from `ctx`, built
 * once by the screen and shared by every list on the page (superset letters run through the page).
 */
import clsx from "clsx";
import { ChevronRight, Link2, MoreHorizontal, Plus, X } from "lucide-react";
import type { Block, BlockExercise, SetEntry } from "../../../shared/schemas";
import { accessoryHint, blockComplete, targetsMetPhrase } from "../../../shared/session";
import { MAX_SETS } from "../../../shared/sessionStructure";
import { fmt } from "../../lib/format";
import { exerciseSummary } from "./exerciseSummary";
import { Foldable, FoldedBlock, FoldToggle, type FoldedItem } from "./FoldedBlock";
import { AccessorySetRow } from "./SetControls";
import { checkAction, type ExRef, type HeldEx, type SetRef } from "./sessionEdit";

/** A load in lb, as rows and hints write it (a half pound kept). */
export const lb = (v: number) => fmt(v, v % 1 ? 1 : 0);

/**
 * A stable React key for an exercise in its block: its first set travels with it through any move
 * or reorder. One with no sets is keyed by its block and place (two such copies never collide).
 */
export const exKey = (e: BlockExercise, i: number, blockId: string) => e.sets[0]?.id ?? `e${blockId}-${e.exerciseId}-${i}`;

/** A progression hint for an exercise (`accessoryHint`). */
export type ExerciseHint = NonNullable<ReturnType<typeof accessoryHint>>;

/** A set still to do that "log as planned" may fill in (an AMRAP needs its real rep count). */
export const loggable = (s: SetEntry) => !s.done && !s.amrap;

/**
 * Whether a progression hint still says something: a "hold" while there are sets to do; an
 * increase while a pending set isn't at the suggestion yet.
 */
export function hintApplies(hint: ExerciseHint, sets: ReadonlyArray<SetEntry>): boolean {
  if (hint.kind === "hold") return sets.some(loggable);
  const up = hint.suggestedWeight >= hint.lastWeight;
  return sets.some(
    (s) => loggable(s) && (s.targetWeight === null || (up ? s.targetWeight < hint.suggestedWeight : s.targetWeight > hint.suggestedWeight)),
  );
}

/** A finished block's exercises as its folded row lists them: each with what its logged sets came to. */
export const foldedItems = (
  b: Block,
  letters: ReadonlyMap<string, string>,
  exName: (id: number) => string,
  exWeighted: (id: number) => boolean,
): FoldedItem[] =>
  b.exercises.map((e, i) => ({
    key: exKey(e, i, b.id),
    name: exName(e.exerciseId),
    tag: b.exercises.length > 1 ? `${letters.get(b.id) ?? ""}${i + 1}` : undefined,
    // The main lift always logs a load.
    summary: exerciseSummary(e, b.kind, b.kind === "primary" || exWeighted(e.exerciseId)),
    skipped: !!e.skipped,
  }));

/** What every block list on the page reads the same way: built once by the screen. */
export interface BlockListContext {
  /** A future day: the plan, no controls. */
  isPreview: boolean;
  /** The page is a record (a finished session, or a day that isn't today). */
  isRecord: boolean;
  /** Superset letters, page-wide (`supersetLetters`). */
  letters: ReadonlyMap<string, string>;
  exName: (exerciseId: number) => string;
  /** Whether an exercise tracks a load (an unknown one does). */
  exWeighted: (exerciseId: number) => boolean;
  /** Whether a block shows as its summary row (view state: `useFolds`). */
  folded: (blockId: string) => boolean;
}

/** What a block list's controls do: each goes through the screen (its commit, sheets and focus). */
export interface BlockActions {
  /** A done block folded, or opened, by hand. */
  onFold: (blockId: string, fold: boolean) => void;
  /** A set's check: log or unlog it (or open what logging it needs first). */
  onCheck: (ref: SetRef) => void;
  /** A set's values: the set editor. */
  onEditSet: (ref: SetRef) => void;
  /** An exercise's ⋯: its options sheet. */
  onOptions: (ref: HeldEx) => void;
  /** A skipped exercise's Unskip (focus goes to its options button). */
  onUnskip: (ref: ExRef) => void;
  /** "+ set" under an exercise. */
  onAddSet: (ref: ExRef) => void;
  /** A superset's header: its own sheet. */
  onManage: (blockId: string) => void;
  /** A progression hint's Apply: the open sets move to the suggested load (focus goes to the options button). */
  onApplyHint: (ref: ExRef, weightLb: number, name: string) => void;
  /** A progression hint dismissed for the day (focus goes to the options button). */
  onDismissHint: (ref: ExRef, exerciseId: number) => void;
}

export interface BlockListProps {
  /** The blocks to show, in page order: a filtered set (accessories; later core, rehab). */
  blocks: ReadonlyArray<Block>;
  ctx: BlockListContext;
  actions: BlockActions;
  /** The progression hint to show under an exercise, if any (none: no hints, as for rehab). */
  hintFor?: (e: BlockExercise) => ExerciseHint | null;
}

export function ExerciseBlockList({ blocks, ctx, actions, hintFor }: BlockListProps) {
  const { isPreview, isRecord, letters, exName, exWeighted, folded } = ctx;
  return (
    <>
      {blocks.map((b) => {
        const superset = b.exercises.length > 1;
        const letter = letters.get(b.id) ?? "";
        /** Every set of the block is logged (a superset as a whole): it folds, and an open one can be folded again. */
        const done = !isPreview && blockComplete(b);
        return (
          // Each exercise ends in its "+ set" row (or, in a preview, nothing): that 44 px row is
          // the whole gap to the next exercise — a control where the separation would be anyway.
          // A done block can show as one row (`Foldable`): the next block follows it directly.
          <div key={b.id} data-block={b.id} className={clsx(isPreview && "mb-8")}>
            <Foldable
              id={b.id}
              done={done}
              folded={folded(b.id)}
              summary={
                <FoldedBlock
                  blockId={b.id}
                  items={foldedItems(b, letters, exName, exWeighted)}
                  superset={superset ? letter : undefined}
                  record={isRecord}
                  onOpen={() => actions.onFold(b.id, false)}
                />
              }
            >
              {superset &&
                (isPreview ? (
                  <div className="mb-2 flex items-center gap-2 text-glow">
                    <Link2 size={12} />
                    <span className="label text-glow">Superset {letter}</span>
                  </div>
                ) : (
                  <div className="-mt-1.5 mb-0.5 flex items-center justify-between">
                    {/* The superset's own sheet: its order, taking one out, adding one. */}
                    <button
                      type="button"
                      aria-haspopup="dialog"
                      aria-label={`Manage Superset ${letter}`}
                      data-manage={b.id}
                      className="tap -ml-2 inline-flex min-h-11 items-center gap-2 px-2 text-glow"
                      onClick={() => actions.onManage(b.id)}
                    >
                      <Link2 size={12} aria-hidden />
                      <span className="label text-glow">Superset {letter}</span>
                      <ChevronRight size={12} aria-hidden className="opacity-60" />
                    </button>
                    {/* Done, a superset folds as one — from here, where each exercise has its options. */}
                    {done && <FoldToggle blockId={b.id} label={`Superset ${letter}`} onFold={() => actions.onFold(b.id, true)} />}
                  </div>
                ))}
              <div className={clsx(superset && "border-l border-glow/25 pl-4")}>
                {b.exercises.map((e, exIdx) => {
                  const name = exName(e.exerciseId);
                  const ref = { blockId: b.id, exIdx };
                  const tagLabel = superset && <span className="label mr-2 text-glow">{`${letter}${exIdx + 1}`}</span>;
                  if (e.skipped)
                    return (
                      <div
                        key={exKey(e, exIdx, b.id)}
                        // No "+ set" row ends a skipped exercise: its own margin is the gap to the next one.
                        className="mb-3 flex min-h-11 flex-wrap items-center justify-between gap-x-3"
                      >
                        <div className="min-w-0 truncate text-[0.9375rem] text-mute">
                          {tagLabel}
                          {name}
                        </div>
                        <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end">
                          <span className="label">
                            Skipped<span className="max-[16rem]:hidden"> today</span>
                          </span>
                          {!isPreview && (
                            <>
                              <span className="label px-1.5" aria-hidden>
                                ·
                              </span>
                              <button
                                type="button"
                                aria-label={`Unskip ${name}`}
                                data-ex={`${b.id}:${exIdx}`}
                                data-control="unskip"
                                className="tap label -mr-2 min-h-11 px-2 text-accent"
                                onClick={() => actions.onUnskip(ref)}
                              >
                                Unskip
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  const weighted = exWeighted(e.exerciseId);
                  const hint = hintFor?.(e) ?? null;
                  return (
                    <div key={exKey(e, exIdx, b.id)} className={clsx(exIdx > 0 && isPreview && "mt-5")}>
                      <div className={clsx("flex items-center justify-between", isPreview && "min-h-11")}>
                        {done && !superset ? (
                          // Done and open: the name folds it again (a superset folds from its own header).
                          <FoldToggle blockId={b.id} className="flex-1" onFold={() => actions.onFold(b.id, true)}>
                            <span className="min-w-0 text-[0.9375rem] wrap-anywhere">{name}</span>
                          </FoldToggle>
                        ) : (
                          <div className="min-w-0 text-[0.9375rem] wrap-anywhere">
                            {tagLabel}
                            {name}
                          </div>
                        )}
                        {!isPreview && (
                          <button
                            type="button"
                            aria-label={`${name} options`}
                            aria-haspopup="dialog"
                            data-ex={`${b.id}:${exIdx}`}
                            data-control="options"
                            className="tap -mr-3 grid h-11 w-11 shrink-0 place-items-center text-mute"
                            onClick={() => actions.onOptions({ ...ref, exerciseId: e.exerciseId })}
                          >
                            <MoreHorizontal size={16} />
                          </button>
                        )}
                      </div>
                      {hint && (
                        <div className="-mt-1 mb-1 flex flex-wrap items-center gap-x-2 text-xs text-mute">
                          {hint.kind === "hold" ? (
                            // Calmer than an increase: nothing to apply, just "stay here" — with
                            // when it was missed ("Missed reps at 60 lb on Nov 2 · hold").
                            <span>{hint.reason.replace(" — ", " · ")}</span>
                          ) : (
                            <>
                              <span title={hint.reason}>
                                Last time <span className="num text-fg-2">{lb(hint.lastWeight)}</span> lb
                                <span className="max-[359px]:hidden"> · {targetsMetPhrase(hint.measure)}</span> → try{" "}
                                <span className="num text-accent">{lb(hint.suggestedWeight)}</span>
                              </span>
                              <button
                                type="button"
                                aria-label={`Apply ${lb(hint.suggestedWeight)} lb to the open ${name} sets`}
                                className="tap label -my-2 min-h-11 px-1.5 text-accent"
                                // The hint row goes once the sets are at the suggestion: focus goes to the options.
                                onClick={() => actions.onApplyHint(ref, hint.suggestedWeight, name)}
                              >
                                Apply
                              </button>
                            </>
                          )}
                          <button
                            type="button"
                            aria-label={`Dismiss the ${name} hint for today`}
                            className="tap -my-2 -ml-2 grid min-h-11 w-11 place-items-center text-mute"
                            onClick={() => actions.onDismissHint(ref, e.exerciseId)}
                          >
                            <X size={12} />
                          </button>
                        </div>
                      )}
                      {/* The same rows as the main lift, compact: values open the editor, the check logs. */}
                      <ul aria-label={`${name} sets`}>
                        {e.sets.map((s, si) => {
                          const setRef = { ...ref, setId: s.id };
                          return (
                            <AccessorySetRow
                              key={s.id}
                              dataSet={s.id}
                              exerciseName={name}
                              index={si}
                              set={s}
                              measure={e.measure}
                              weighted={weighted}
                              needsLoad={checkAction(s, "accessory", weighted) === "load"}
                              preview={isPreview}
                              record={isRecord}
                              onCheck={() => actions.onCheck(setRef)}
                              onEdit={() => actions.onEditSet(setRef)}
                            />
                          );
                        })}
                      </ul>
                      {!isPreview && (
                        // The row stays (empty) for an exercise that is full: it's the gap to the next one.
                        <div className="flex min-h-11 justify-end">
                          {e.sets.length < MAX_SETS && (
                            <button
                              type="button"
                              aria-label={`Add ${name} set`}
                              className="tap label -mr-2 inline-flex min-h-11 items-center gap-1.5 px-2 whitespace-nowrap text-mute"
                              onClick={() => actions.onAddSet(ref)}
                            >
                              <Plus size={12} aria-hidden /> set
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </Foldable>
          </div>
        );
      })}
    </>
  );
}
