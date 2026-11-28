/**
 * The top of a Train day: the date bar (‹ date › and the program link), the cycle's end note, the
 * title and the line under it, and the day's chips — the swap suggestion, "Planned for …" with
 * its revert, "Plan done … · view", "← Today", "Do this session today" (with its confirm) and the
 * recalculation.
 *
 * Everything it shows comes from the screen; its only state is the "Replace today's saved
 * session?" confirm, which goes when the day changes.
 */
import clsx from "clsx";
import { useId, useState } from "react";
import { Link } from "react-router";
import { CalendarCheck, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { addDays, weekdayName } from "../../../shared/dates";
import type { swapSuggestion } from "../../../shared/swap";
import { fmt } from "../../lib/format";
import { CycleEndNote } from "../program/CycleEndNote";
import type { useCycleChoice } from "../program/useCycleChoice";
import { DateJump } from "../today/DateJump";
import type { ProgramLinkLabel } from "./programLink";
import type { TrainDay } from "./sectionProps";

/** A session done on another day than its own: which day, and what it was. */
export interface DayRef {
  date: string;
  label: string;
}

export interface TrainHeaderProps {
  day: TrainDay;
  /** The last day that can be previewed: the date bar stops there. */
  lastPreview: string;
  /** The day has edits waiting to sync (the date bar marks it). */
  pending: boolean;
  /** Show another day. */
  onGo: (date: string) => void;
  /** Where this day sits in the program (`programLinkLabel`). */
  programLink: ProgramLinkLabel;
  /** The path the screen is on: Program's back control (and the cycle note's review) return to it. */
  from: string;
  /** A cycle's last week: repeat it, or set up a new one (shown on today only). */
  cycleChoice: ReturnType<typeof useCycleChoice>;
  /** The h1: the session's label. */
  title: string;
  /** This day's plan was done on another day, and the day has no session of its own. */
  shownEarly: DayRef | null;
  /** This day's plan was done on another day, and the day holds a session of its own. */
  planDoneEarly: DayRef | null;
  doneSets: number;
  totalSets: number;
  /** lb moved. */
  volume: number;
  /** The program plans lifting on the day, or it has a session. */
  isPlannedDay: boolean;
  /** Swapping between days (`swapSuggestion`, held while a field has focus). */
  suggestion: ReturnType<typeof swapSuggestion>;
  /** The suggestion can be taken (else it is held: the same words, nothing to tap). */
  suggestionLive: boolean;
  onSuggestion: () => void;
  exName: (exerciseId: number) => string;
  /** The day the session was planned for, when it was moved here ("Do this session today"). */
  plannedFor: string | null;
  canRevert: boolean;
  onRevert: () => void;
  /** A previewed day can be done today instead. */
  canMove: boolean;
  /** Today holds a saved session (the move asks first), and whether it has notes (they come along). */
  todayHasSession: boolean;
  todayNotes: boolean;
  onDoThisToday: () => void;
  /** The main lift can be recalculated: the chip's words, and the recalculation. */
  recalc: { label: string; onRecalc: () => void } | null;
  /** The screen's focus hand-off (one pending request at a time, page-wide). */
  focusAfter: (find: () => HTMLElement | null) => void;
}

export function TrainHeader({
  day,
  lastPreview,
  pending,
  onGo,
  programLink,
  from,
  cycleChoice,
  title,
  shownEarly,
  planDoneEarly,
  doneSets,
  totalSets,
  volume,
  isPlannedDay,
  suggestion,
  suggestionLive,
  onSuggestion,
  exName,
  plannedFor,
  canRevert,
  onRevert,
  canMove,
  todayHasSession,
  todayNotes,
  onDoThisToday,
  recalc,
  focusAfter,
}: TrainHeaderProps) {
  const { date, today, isToday, isPreview, weekday } = day;
  const hintId = useId();
  /** Program's back control returns to the day it was opened from. */
  const toProgram = { from };
  const trainPath = (d: string) => (d === today ? "/train" : `/train/${d}`);
  const [confirmMove, setConfirmMove] = useState(false);
  const [confirmFor, setConfirmFor] = useState(date);
  if (confirmFor !== date) {
    setConfirmFor(date);
    setConfirmMove(false);
  }
  const doThisToday = () => {
    setConfirmMove(false);
    onDoThisToday();
  };

  return (
    <>
      {/* The program link stays beside the dates down to 320 px (below 360 it shows its short form,
          a size smaller); when even that has no room it drops to a line of its own, still at the right. */}
      <header className="flex flex-wrap items-center justify-between gap-x-2 pt-2 max-[359px]:gap-x-0">
        {/* Below 360 px the link may reach 8 px into the empty side of the next-day button
            ("Cycle 2 · Week 3" then still fits on this row at 320). */}
        <div className="flex min-w-0 items-center max-[359px]:-mr-2">
          <button
            type="button"
            aria-label="Previous day"
            onClick={() => onGo(addDays(date, -1))}
            className="tap -ml-3 grid h-11 w-11 place-items-center text-mute"
          >
            <ChevronLeft size={18} />
          </button>
          {/* Jump to any day, up to the last previewable one. */}
          <DateJump date={date} today={today} max={lastPreview} pending={pending} onPick={onGo} />
          <button
            type="button"
            aria-label="Next day"
            disabled={date >= lastPreview}
            onClick={() => onGo(addDays(date, 1))}
            className="tap grid h-11 w-11 place-items-center text-mute disabled:opacity-20"
          >
            <ChevronRight size={18} />
          </button>
        </div>
        {/* Where this session sits in the program, in plain words — or, before the first cycle,
            when it starts. Always here: the program itself is a tap away from any day. */}
        <Link
          to="/program"
          state={toProgram}
          aria-label={programLink.name}
          data-program-link=""
          // Plain small text rather than the wide mono label: "Cycle 2 · Week 1 of 5" still fits beside the dates on a 375 px phone.
          className={clsx(
            "tap -mr-2 ml-auto inline-flex min-h-11 items-center gap-1 px-2 text-xs whitespace-nowrap",
            "max-[359px]:gap-0.5 max-[359px]:pl-0 max-[359px]:text-[0.6875rem]",
            programLink.deload ? "text-fg-2" : "text-mute",
          )}
        >
          {programLink.short === programLink.text ? (
            programLink.text
          ) : (
            <>
              {/* Below 360 px the short form ("Week 1", "Deload", "Cycle 2 · Week 1") keeps the link beside the dates. */}
              <span className="max-[359px]:hidden">{programLink.text}</span>
              <span className="min-[360px]:hidden">{programLink.short}</span>
            </>
          )}
          <ChevronRight size={12} aria-hidden className="opacity-60" />
        </Link>
      </header>
      {/* A cycle's last week: repeat it, or set up a new one (SPEC §7). Today only. */}
      {isToday && cycleChoice.card && (
        <div className="mt-4">
          <CycleEndNote choice={cycleChoice} reviewFrom={from} />
        </div>
      )}

      <div className="mt-6">
        <h1 data-train-title tabIndex={-1} className="text-[clamp(1.75rem,11vw,2.75rem)] leading-none font-light tracking-tight">
          {title}
        </h1>
        <p className="mt-3 text-sm text-mute">
          {shownEarly ? (
            <>
              Done {weekdayName(shownEarly.date, true)} · <span className="text-fg-2">{shownEarly.label}</span> —{" "}
              <Link
                to={trainPath(shownEarly.date)}
                aria-label={`View ${weekdayName(shownEarly.date)}'s ${shownEarly.label} session`}
                className="-mx-1 -my-3 inline-block px-1 py-3 text-accent"
              >
                view
              </Link>
            </>
          ) : isPreview ? (
            <>
              <span className="label mr-2 rounded-full bg-white/[0.05] px-2 py-1 text-fg-2">Preview</span>
              {totalSets ? (
                <>
                  <span className="num text-fg-2">{totalSets}</span> sets planned
                </>
              ) : isPlannedDay ? (
                "Nothing planned yet"
              ) : (
                "Rest day"
              )}
            </>
          ) : totalSets ? (
            <>
              <span className="num text-fg-2">{doneSets}</span>/{totalSets} sets
              {volume > 0 && (
                <>
                  {" "}
                  · <span className="num text-fg-2">{fmt(volume)}</span> lb moved
                </>
              )}
            </>
          ) : isPlannedDay ? (
            isToday ? (
              "Build today's work below."
            ) : (
              `Build ${weekday}'s work below.`
            )
          ) : (
            "Rest day."
          )}
        </p>
        {suggestion && !shownEarly && (
          // Swapping between days: this day's lift was done earlier this week in another day's place.
          <p data-swap-suggestion className="mt-1 text-sm text-mute">
            {exName(suggestion.done)} was done {weekdayName(suggestion.doneOn, true)}.
            {!isPreview && (
              <>
                {" "}
                {suggestionLive ? (
                  <button type="button" className="-mx-1 -my-3 inline px-1 py-3 text-left text-accent" onClick={onSuggestion}>
                    Do {exName(suggestion.suggest)} {isToday ? "today" : "instead"}?
                  </button>
                ) : (
                  // Held while a field has focus (the day saved meanwhile): the same words, nothing to tap.
                  <span data-swap-suggestion-held className="-mx-1 px-1">
                    Do {exName(suggestion.suggest)} {isToday ? "today" : "instead"}?
                  </span>
                )}
              </>
            )}
          </p>
        )}
        {plannedFor && (
          <div className="mt-1 flex flex-wrap items-center gap-x-3">
            <span className="text-sm text-mute">
              Planned for <span className="text-fg-2">{weekdayName(plannedFor, true)}</span>
            </span>
            {canRevert && (
              <button type="button" className="tap label -mx-2 min-h-11 px-2 text-left text-accent" onClick={onRevert}>
                {isToday ? "Revert to today's plan" : `Revert to ${weekday}'s plan`}
              </button>
            )}
          </div>
        )}
        {planDoneEarly && (
          <p className="mt-1 text-sm text-mute">
            Plan done {weekdayName(planDoneEarly.date, true)} ·{" "}
            <Link
              to={trainPath(planDoneEarly.date)}
              aria-label={`View ${weekdayName(planDoneEarly.date)}'s ${planDoneEarly.label} session`}
              className="-mx-1 -my-3 inline-block px-1 py-3 text-accent"
            >
              view
            </Link>
          </p>
        )}
        {(!isToday || recalc) && (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
            {!isToday && (
              <Link to="/train" className="label inline-flex min-h-11 items-center text-accent">
                ← Today
              </Link>
            )}
            {canMove &&
              (confirmMove ? (
                <div role="group" aria-labelledby={`${hintId}-move`} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1">
                  <span id={`${hintId}-move`} className="text-sm text-fg-2">
                    {todayNotes ? "Replace today's saved session? Its notes come along." : "Replace today's saved session?"}
                  </span>
                  <span className="inline-flex items-center gap-2">
                    <button
                      type="button"
                      data-move-cancel
                      className="chip min-h-9 bg-white/[0.05] text-fg-2"
                      onClick={() => {
                        setConfirmMove(false);
                        focusAfter(() => document.querySelector<HTMLElement>("[data-move-start]"));
                      }}
                    >
                      Cancel
                    </button>
                    <button type="button" data-move-confirm className="chip min-h-9 bg-accent/10 text-accent" onClick={doThisToday}>
                      Replace
                    </button>
                  </span>
                </div>
              ) : (
                <button
                  type="button"
                  data-move-start
                  className="chip min-h-9 bg-accent/10 text-accent"
                  onClick={() => {
                    if (todayHasSession) {
                      setConfirmMove(true);
                      // The safe choice first: a stray second tap doesn't replace anything.
                      focusAfter(() => document.querySelector<HTMLElement>("[data-move-cancel]"));
                    } else doThisToday();
                  }}
                >
                  <CalendarCheck size={12} className="mr-1.5" />
                  Do this session today
                </button>
              ))}
            {recalc && (
              <button type="button" onClick={recalc.onRecalc} className="chip min-h-9 bg-accent/10 text-accent">
                <RefreshCw size={12} className="mr-1.5" />
                {recalc.label}
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
