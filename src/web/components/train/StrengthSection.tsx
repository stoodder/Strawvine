/**
 * The strength part of a Train day: the main lift (swap / skip / skip rest, plates, AMRAP, its
 * folded row), "add a main lift" on a day whose plan has none, what stands in for a main lift that
 * can't be calculated, and the accessories (`ExerciseBlockList`) with "+ Exercise" and Reorder.
 *
 * It holds no state and saves nothing: the screen derives the main lift (`MainLiftView`) and owns
 * the sheets, the commit and focus; the controls here call `mainActions` / `blockActions`.
 */
import clsx from "clsx";
import type { ReactNode } from "react";
import { useId } from "react";
import { Link } from "react-router";
import { ArrowLeftRight, ArrowUpDown, Plus, SkipForward, X } from "lucide-react";
import type { Block, BlockExercise, Exercise, MaxEntry, Session, SetEntry } from "../../../shared/schemas";
import type { mainLiftSwap } from "../../../shared/session";
import { MAX_BLOCKS, MAX_SETS } from "../../../shared/sessionStructure";
import { fmt } from "../../lib/format";
import { Empty, Section } from "../ui";
import { ExerciseBlockList, foldedItems, type BlockActions, type BlockListContext, type ExerciseHint } from "./ExerciseBlockList";
import { Foldable, FoldedBlock, FoldToggle } from "./FoldedBlock";
import { programStartSentence, type MainLiftNotice } from "./programLink";
import type { SectionProps } from "./sectionProps";
import { repScheme, type SetRef } from "./sessionEdit";
import { MainSetRow } from "./SetControls";
import { Plates } from "./SetSheets";

/** "1 set", "3 sets". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The main lift as the screen derives it for the day (nothing here is stored apart from the session). */
export interface MainLiftView {
  /** The session's main block, if it has one. */
  block: Block | undefined;
  /** Its exercise, with its sets. */
  ex: BlockExercise | undefined;
  exId: number | undefined;
  name: string;
  /** The lift's max now (none: the max the session was built on is shown). */
  max: MaxEntry | null;
  /** A set of it is logged. */
  started: boolean;
  /** Skipped today: one dimmed row, counting toward nothing. */
  skipped: boolean;
  /** Every set it holds is logged (never in a preview): it can fold. */
  done: boolean;
  /** Sets the program prescribed for this session's week; any beyond are added back-off sets. */
  plannedCount: number;
  /** Prescribed sets it no longer holds ("Skip rest"): its folded row says so. */
  skippedMain: number;
  /** Its sets still open. */
  openMain: number;
  /** Its next open set: the one the plates under the rows are for. */
  nextMain: SetEntry | null;
  /** Prescribed sets the session no longer holds, which "Restore" brings back. */
  missingMain: ReadonlyArray<SetEntry>;
  /** Swapped for this session (`mainLiftSwap`). */
  swap: ReturnType<typeof mainLiftSwap>;
  /** Added for this session to a day whose plan has none (`mainLiftAdded`): the lift, else null. */
  added: number | null;
  /** A main lift can be added for this session (the day's plan has none). */
  canAdd: boolean;
  /** In place of a main lift the day has no sets for (`mainLiftNotice`). */
  notice: MainLiftNotice | null;
}

/** What the main lift's controls do (each through the screen). */
export interface MainLiftActions {
  /** A lift's max sheet. */
  onSetMax: (exerciseId: number) => void;
  /** The swap sheet (or, with no main lift, the add sheet). */
  onSwap: () => void;
  /** Take out the main lift added for this session. */
  onRemoveAdded: () => void;
  /** Skip the main lift for today, or unskip it. */
  onSkip: (skip: boolean) => void;
  /** Stop it part-way: its open sets leave the session. */
  onSkipRest: () => void;
  /** Bring back the prescribed sets skipped. */
  onRestore: () => void;
  /** A back-off set. */
  onAddSet: () => void;
  /** An AMRAP set's values: the rep counter. */
  onAmrap: (ref: SetRef) => void;
}

/** The accessories subsection: its blocks and its foot. */
export interface AccessoriesView {
  blocks: ReadonlyArray<Block>;
  /** A main-lift day of a later plan that nothing carries into: said once, while unsaved. */
  newProgramDay: boolean;
  /** The session holds its most blocks: "+ Exercise" is off. */
  blocksFull: boolean;
  /** "+ Exercise": the add sheet. */
  onAdd: () => void;
  /** "Reorder": the workout order sheet. */
  onReorder: () => void;
}

export interface StrengthSectionProps extends SectionProps {
  /** The session as the screen shows it (`effectiveSession`). */
  session: Session;
  exById: (id: number) => Exercise | undefined;
  /** Program's back control returns to the day it was opened from. */
  toProgram: { from: string };
  main: MainLiftView;
  mainActions: MainLiftActions;
  accessories: AccessoriesView;
  /** What every block list on the page reads (letters run through the page). */
  list: BlockListContext;
  blockActions: BlockActions;
  /** The progression hint to show under an accessory, if any. */
  hintFor?: (e: BlockExercise) => ExerciseHint | null;
  /** What follows strength's own content (Finish strength, once it lives here). */
  children?: ReactNode;
}

export function StrengthSection({
  day,
  session,
  exById,
  toProgram,
  main,
  mainActions,
  accessories,
  list,
  blockActions,
  hintFor,
  children,
}: StrengthSectionProps) {
  const { today, isToday, isPreview, isRecord, weekday } = day;
  const { letters, exName, exWeighted, folded } = list;
  const {
    block: primaryBlock,
    ex: primaryEx,
    exId: primaryExId,
    name: primaryName,
    max: primaryMax,
    started: primaryStarted,
    skipped: primarySkipped,
    done: primaryDone,
    plannedCount,
    skippedMain,
    openMain,
    nextMain,
    missingMain,
    swap,
    added,
    canAdd: canAddMain,
    notice: mainNotice,
  } = main;
  const hintId = useId();
  return (
    <>
      {/* Main lift */}
      {primaryBlock && primaryEx && primaryExId != null && (
        <Section
          label="Main lift"
          right={
            isPreview ? (
              <span className="label text-mute">
                max <span className="num text-fg-2">{fmt(primaryMax?.valueLb ?? session.primaryMaxLb, 0)}</span>
              </span>
            ) : (
              <button
                type="button"
                aria-haspopup="dialog"
                className="label -mx-2 -my-3.5 px-2 py-3.5 text-mute"
                onClick={() => mainActions.onSetMax(primaryExId)}
              >
                max <span className="num text-fg-2">{fmt(primaryMax?.valueLb ?? session.primaryMaxLb, 0)}</span>
              </button>
            )
          }
        >
          {primarySkipped ? (
            // Skipped today: one dimmed row; its sets count toward nothing until it's unskipped.
            <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-3">
              <div className="min-w-0 truncate text-[0.9375rem] text-mute">{primaryName}</div>
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
                      aria-label={`Unskip ${primaryName}`}
                      data-main-control="unskip"
                      className="tap label -mr-2 min-h-11 px-2 text-accent"
                      onClick={() => mainActions.onSkip(false)}
                    >
                      Unskip
                    </button>
                  </>
                )}
              </div>
            </div>
          ) : (
            // Done (every set it still holds is logged), the main lift can show as one row: its sets in a
            // line, the AMRAP with its tag. Keyed by the block: another day's main lift is another one.
            <Foldable
              key={primaryBlock.id}
              id={primaryBlock.id}
              done={primaryDone}
              folded={folded(primaryBlock.id)}
              summary={
                <FoldedBlock
                  blockId={primaryBlock.id}
                  items={foldedItems(primaryBlock, letters, exName, exWeighted)}
                  size="main"
                  // Gold as on the AMRAP's own row: it beat its target.
                  tone={
                    foldedItems(primaryBlock, letters, exName, exWeighted).some((it) =>
                      it.summary.parts.some((p) => p.tag?.tone === "gold"),
                    )
                      ? "gold"
                      : "accent"
                  }
                  // Sets skipped ("Skip rest") aren't logged: the row says so in place of "all sets logged".
                  status={skippedMain ? `${plural(skippedMain, "set")} skipped` : undefined}
                  record={isRecord}
                  onOpen={() => blockActions.onFold(primaryBlock.id, false)}
                />
              }
            >
              {/* The name gives way (truncated; its full name stays in the accessible name and the set rows) so
                      "swap" and "skip" / "skip rest" keep one line beside it at 320 px with a long name. */}
              <div className="mb-4 flex items-center justify-between gap-x-3">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-3">
                  {primaryDone ? (
                    // The name folds it again (the toggle's 44 px reach past the line is cancelled, so the header keeps its height).
                    <FoldToggle
                      blockId={primaryBlock.id}
                      size="main"
                      className="-my-1.5 max-w-full min-w-0"
                      status={skippedMain ? `${plural(skippedMain, "set")} skipped` : undefined}
                      onFold={() => blockActions.onFold(primaryBlock.id, true)}
                    >
                      <span className="block min-w-0 truncate text-2xl font-light">{primaryName}</span>
                    </FoldToggle>
                  ) : (
                    <div data-main-name className="max-w-full min-w-0 truncate text-2xl font-light">
                      {primaryName}
                    </div>
                  )}
                  {session.deload && (
                    <span className="label whitespace-nowrap text-fg-2">
                      deload · {repScheme(primaryEx.sets.slice(0, plannedCount).map((s) => s.targetReps))}
                    </span>
                  )}
                </div>
                {!isPreview && !session.completedAt && (
                  <span className="-my-2 -mr-2 ml-auto flex shrink-0 items-center">
                    {/* Another lift for this session only (equipment, timing): the day keeps its accessories.
                            Always reachable while the session is open; once a set is logged the sheet says why not. */}
                    <button
                      type="button"
                      onClick={mainActions.onSwap}
                      aria-haspopup="dialog"
                      aria-label={`Swap ${primaryName} for another lift`}
                      data-main-control="swap"
                      className="tap label inline-flex min-h-11 items-center justify-center gap-1.5 px-2 whitespace-nowrap text-mute"
                    >
                      <ArrowLeftRight size={12} aria-hidden className="max-[399px]:hidden" />
                      swap
                    </button>
                    {/* A main lift added for this session (the day's plan has none) comes out again, nothing logged in it. */}
                    {added !== null && !primaryStarted && (
                      <button
                        type="button"
                        onClick={mainActions.onRemoveAdded}
                        aria-label={`Remove ${primaryName} from this session`}
                        data-main-control="remove"
                        className="tap label inline-flex min-h-11 items-center gap-1.5 px-2 whitespace-nowrap text-mute"
                      >
                        <X size={12} aria-hidden className="max-[399px]:hidden" /> remove
                      </button>
                    )}
                    {/* Injury or fatigue: skip the main lift for today (nothing logged in it yet), or
                            the rest of it once some sets are in (those still count). */}
                    {added === null && !primaryStarted && (
                      <button
                        type="button"
                        onClick={() => mainActions.onSkip(true)}
                        aria-label={`Skip ${primaryName} today`}
                        data-main-control="skip"
                        className="tap label inline-flex min-h-11 items-center gap-1.5 px-2 whitespace-nowrap text-mute"
                      >
                        <SkipForward size={12} aria-hidden className="max-[399px]:hidden" /> skip
                      </button>
                    )}
                    {primaryStarted && openMain > 0 && (
                      <button
                        type="button"
                        onClick={mainActions.onSkipRest}
                        aria-label={`Skip rest of ${primaryName} today`}
                        data-main-control="skip-rest"
                        className="tap label inline-flex min-h-11 items-center gap-1.5 px-2 whitespace-nowrap text-mute"
                      >
                        <SkipForward size={12} aria-hidden className="max-[399px]:hidden" /> skip rest
                      </button>
                    )}
                  </span>
                )}
              </div>
              {/* Swapped for this session: which lift the plan had (the plan itself doesn't change). */}
              {swap && (
                <p data-swapped className="-mt-3 mb-4 text-xs text-mute">
                  In place of <span className="text-fg-2">{exName(swap.from)}</span> · this session only
                </p>
              )}
              {/* Added for this session: the day's plan has no main lift (the plan itself doesn't change). */}
              {added !== null && (
                <p data-added className="-mt-3 mb-4 text-xs text-mute">
                  Added for this session
                </p>
              )}
              <ul aria-label={`${primaryName} sets`}>
                {primaryEx.sets.map((s, i) => {
                  const ref = { blockId: primaryBlock.id, exIdx: 0, setId: s.id };
                  return (
                    <MainSetRow
                      key={s.id}
                      dataSet={s.id}
                      exerciseName={primaryName}
                      index={i}
                      set={s}
                      extra={i >= plannedCount}
                      preview={isPreview}
                      record={isRecord}
                      onCheck={() => blockActions.onCheck(ref)}
                      // An AMRAP is edited where it's counted (reps, load, the max bump).
                      onEdit={() => (s.amrap ? mainActions.onAmrap(ref) : blockActions.onEditSet(ref))}
                    />
                  );
                })}
              </ul>
              <div className="mt-1 flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-1">
                {/* What to load for the next open set — named, so it's clear which row the plates are for.
                        The plates give way (down to 9rem, wrapping among themselves) before "+ set"
                        is pushed onto a line of its own. */}
                <Plates
                  className="min-w-0 flex-1 basis-36"
                  weight={nextMain?.targetWeight ?? null}
                  label={nextMain && !isPreview ? `Set ${primaryEx.sets.indexOf(nextMain) + 1} · per side` : undefined}
                />
                {!isPreview && (
                  <div className="-mr-2 ml-auto flex items-center">
                    {missingMain.length > 0 && (
                      <span className="flex items-center">
                        <span className="label">{plural(missingMain.length, "set")} skipped</span>
                        <span className="label px-1.5" aria-hidden>
                          ·
                        </span>
                        <button
                          type="button"
                          aria-label={`Restore ${plural(missingMain.length, "skipped set")} of ${primaryName}`}
                          data-main-control="restore"
                          className="tap label min-h-11 px-2 text-accent"
                          onClick={mainActions.onRestore}
                        >
                          Restore
                        </button>
                      </span>
                    )}
                    {primaryEx.sets.length < MAX_SETS && (
                      <button
                        type="button"
                        onClick={mainActions.onAddSet}
                        aria-label={`Add a back-off set of ${primaryName}`}
                        className="tap label inline-flex min-h-11 items-center gap-1.5 px-2 whitespace-nowrap text-mute"
                      >
                        <Plus size={12} /> set
                      </button>
                    )}
                  </div>
                )}
              </div>
            </Foldable>
          )}
        </Section>
      )}

      {canAddMain && (
        // A lifting day whose plan has no main lift (Friday's carries): one can be added for this session.
        <Section label="Main lift">
          <p className="-mt-1 text-sm text-mute">
            None planned for {session.label}.{" "}
            <button
              type="button"
              aria-haspopup="dialog"
              data-main-control="add"
              className="-mx-1 -my-3 inline px-1 py-3 text-left text-accent"
              onClick={mainActions.onSwap}
            >
              Add one for this session
            </button>
          </p>
        </Section>
      )}

      {mainNotice && (
        <Section label="Main lift">
          <Empty>
            {mainNotice.kind === "not-started" ? (
              // Before the first cycle nothing is calculated, whatever maxes exist: say when it starts.
              <>
                {programStartSentence(mainNotice.start, today, mainNotice.cycle)}{" "}
                <Link to="/program" state={toProgram} className="-mx-1 -my-3 inline-block px-1 py-3 whitespace-nowrap text-accent">
                  Open the program →
                </Link>
              </>
            ) : (
              <>
                Set a max for {exById(mainNotice.exerciseId)?.name ?? "this lift"} and the working sets calculate themselves.{" "}
                {!isPreview && exById(mainNotice.exerciseId) && (
                  <button
                    type="button"
                    aria-haspopup="dialog"
                    className="-mx-1 -my-3 px-1 py-3 whitespace-nowrap text-accent"
                    onClick={() => mainActions.onSetMax(mainNotice.exerciseId)}
                  >
                    Set max →
                  </button>
                )}
              </>
            )}
          </Empty>
        </Section>
      )}

      {/* Accessories */}
      <Section
        label="Accessories"
        right={
          !isPreview && accessories.blocks.length > 1 ? (
            <button
              type="button"
              aria-haspopup="dialog"
              aria-label="Reorder workout"
              data-reorder
              className="tap label -my-3 -mr-2 inline-flex min-h-11 items-center gap-1.5 px-2 text-mute"
              onClick={accessories.onReorder}
            >
              <ArrowUpDown size={12} aria-hidden /> Reorder
            </button>
          ) : undefined
        }
      >
        {accessories.newProgramDay && (
          <p className="mb-4 text-sm text-mute" data-new-day-hint="">
            New in this plan: no earlier session to carry accessories from. Add them below.
          </p>
        )}
        <ExerciseBlockList blocks={accessories.blocks} ctx={list} actions={blockActions} hintFor={hintFor} />
        {/* Where the exercises end: everything after it moves as one when blocks fold (folds.ts `foldInPlace`). */}
        <div data-fold-end="" />
        {!accessories.blocks.length && (
          <p className="mb-6 text-sm text-mute">
            {isPreview
              ? `Nothing to carry over yet — the accessories you log on a ${weekday} show up here.`
              : `Add the accessories and core work for ${isToday ? "today" : weekday} — next ${weekday} they'll be here waiting.`}
          </p>
        )}
        {isPreview ? (
          // Only what's true of this preview: nothing claims a carry-over when nothing was carried.
          (accessories.blocks.length > 0 || primaryBlock) && (
            <p className="text-xs leading-relaxed text-mute">
              {accessories.blocks.length > 0
                ? `Carried over from your last ${weekday}${primaryBlock ? "; main-lift loads use today's max and move with any AMRAP before then" : ""}.`
                : "Main-lift loads use today's max and move with any AMRAP before then."}
            </p>
          )
        ) : (
          // The last exercise's "+ set" row already is the gap above.
          <div className={clsx("flex flex-wrap items-center gap-x-4 gap-y-2", accessories.blocks.length > 0 && "mt-2")}>
            <button
              type="button"
              className="btn-ghost"
              disabled={accessories.blocksFull}
              aria-describedby={accessories.blocksFull ? `${hintId}-full` : undefined}
              onClick={accessories.onAdd}
            >
              <Plus size={16} /> Exercise
            </button>
            {accessories.blocksFull && (
              <span id={`${hintId}-full`} className="text-xs text-mute">
                A session holds up to {MAX_BLOCKS} blocks
              </span>
            )}
          </div>
        )}
      </Section>
      {children}
    </>
  );
}
