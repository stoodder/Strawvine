/**
 * What Train says about the program around a session — wording only, built on the program maths in
 * src/shared (no formulas here):
 *
 *   - the header's link to Program, which is always there: the week in words once the first cycle
 *     has started for the day shown, else when it starts ("Starts Mon Nov 2");
 *   - what stands in for a main lift the day has no sets for: the program hasn't started yet, or
 *     the day's lift has no max to calculate from.
 */
import { formatShortDate, weekdayName, type ISODate } from "../../../shared/dates";
import { currentMax, cycleLabel, cyclePosition, programDayFor } from "../../../shared/program";
import type { MaxEntry, Program } from "../../../shared/schemas";

export interface ProgramLinkLabel {
  /** What the link shows: "Week 1 of 5", "Deload week", "Cycle 2 · Week 1 of 5", "Starts Mon Nov 2". */
  text: string;
  /**
   * The same on a narrow screen: "Week 1", "Deload", "Cycle 2 · Week 1", "Starts Mon". Always part
   * of `name`, word for word, so the link's visible label stays in its accessible name (WCAG 2.5.3).
   */
  short: string;
  /** The link's accessible name: "Program: Week 1 of 5", "Program: starts Mon Nov 2". */
  name: string;
  /** A deload week: the label reads a step brighter. */
  deload: boolean;
}

/** "Nov 2", with the year when it isn't `relativeTo`'s. */
const shortDate = (date: ISODate, relativeTo: ISODate) => formatShortDate(date, date.slice(0, 4) !== relativeTo.slice(0, 4));

/**
 * The header link's label for the day shown (`date`: a moved session's own program day). Before
 * the first cycle starts — a new account before its first Monday, a plan pushed back in week 1,
 * a day from before the program — it says when the cycle starts (or started, seen from `today`).
 */
export function programLinkLabel(program: Program, date: ISODate, today: ISODate): ProgramLinkLabel {
  const pos = cyclePosition(program, date);
  if (pos) {
    const text = cycleLabel(pos, program.weeks.length);
    return { text, short: cycleLabel(pos, program.weeks.length, { short: true }), name: `Program: ${text}`, deload: pos.week.deload };
  }
  // No cycle to place the day in (a program always has a week; this is for a document that doesn't).
  if (program.weeks.length === 0) return { text: "Program", short: "Program", name: "Program", deload: false };
  const start = program.cycleStartDate;
  const verb = start > today ? "Starts" : "Started";
  const day = weekdayName(start, true);
  const text = `${verb} ${day} ${shortDate(start, today)}`;
  return { text, short: `${verb} ${day}`, name: `Program: ${verb.toLowerCase()} ${day} ${shortDate(start, today)}`, deload: false };
}

/**
 * What stands in for the main lift on a day the program gives one but the session has no sets for:
 *   "not-started" — the first cycle hasn't started for this day, so nothing is calculated yet
 *                   (whatever maxes exist);
 *   "needs-max"   — the cycle is running and the day's lift has no max to calculate from.
 * null when there is nothing to say: the session holds its main lift (or the plan would build one
 * — a recalculation is offered instead), or the day has no main lift.
 */
export type MainLiftNotice = { kind: "not-started"; start: ISODate } | { kind: "needs-max"; exerciseId: number } | null;

export function mainLiftNotice({
  program,
  date,
  maxEntries,
  hasMainLift,
}: {
  program: Program;
  /** The day whose plan the session follows (a moved session's own program day). */
  date: ISODate;
  maxEntries: ReadonlyArray<MaxEntry>;
  /** The session shows a main lift, or the plan has one for it. */
  hasMainLift: boolean;
}): MainLiftNotice {
  if (hasMainLift) return null;
  const exerciseId = programDayFor(program, date)?.primaryExerciseId;
  if (exerciseId == null || program.weeks.length === 0) return null;
  if (!cyclePosition(program, date)) return { kind: "not-started", start: program.cycleStartDate };
  // The max is the program day's lift's — there is no main-lift block to read it from.
  return currentMax(maxEntries, exerciseId) ? null : { kind: "needs-max", exerciseId };
}

/** "Your program starts Monday, Nov 2." — the not-started notice in words. */
export function programStartSentence(start: ISODate, today: ISODate): string {
  const when = `${weekdayName(start)}, ${shortDate(start, today)}`;
  return start > today ? `Your program starts ${when}.` : `Your program started ${when} — after this day.`;
}
