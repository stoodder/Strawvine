/**
 * Editing an exercise in the library (§6.5): what may change, and the patch an edit sends. The
 * session side of a measure change (pre-fill, hints, the session in progress) lives in session.ts.
 */
import { addDays, WEEKDAY_SHORT, type ISODate } from "./dates";
import { planTimeline } from "./program";
import type { Exercise, ExerciseCategory, Measure, ProgramDay, Settings } from "./schemas";
import { isMainLift, isWeighted } from "./session";

export interface ExerciseLocks {
  /**
   * Weekdays (0 = Sun … 6 = Sat) whose program day in the latest plan calculates this exercise as its
   * main lift, Monday first.
   */
  programDays: number[];
  /**
   * The same in the plan before the latest one (SPEC §6.4) while the latest hasn't started yet — the
   * plan in force ("this cycle") while the latest is the next cycle, scheduled. Empty with one plan
   * and once the latest has started (the plan before is history then).
   */
  earlierPlanDays: number[];
  /** The latest plan is the next cycle, scheduled (another plan is in force until it starts). */
  latestIsNext: boolean;
  /**
   * The program calculates it — in the latest plan, or in this cycle's while the latest is the next
   * cycle: its category, measure and max tracking stay as they are and it can't be archived, or
   * those days would lose their main lift. (Change the weekly layout first: both are editable on
   * Program then.)
   */
  structure: boolean;
  /**
   * Max tracking can't be turned off: the program calculates the lift from its max, or a strength
   * target is set on it (Goals and Progress follow tracked lifts). Turning it on is always fine.
   */
  keepsMax: boolean;
}

/**
 * What the exercise library may not change about `exercise` (see `ExerciseLocks`), on `today`. The
 * server, which doesn't know the person's time zone, passes its own date plus a day
 * (`serverLockDate`): it never refuses what the sheet allows; a stale client asking a day early
 * only reaches a lock the sheet itself still shows.
 */
export function exerciseLocks(
  exercise: Pick<Exercise, "id" | "tracksMax">,
  settings: Pick<Settings, "program" | "strengthTargets">,
  today: ISODate,
): ExerciseLocks {
  const daysUsing = (days: Record<string, ProgramDay>) =>
    Object.entries(days)
      .filter(([, d]) => d.primaryExerciseId === exercise.id)
      .map(([k]) => Number(k))
      .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  const spans = planTimeline(settings.program);
  const latest = spans[spans.length - 1]!;
  const programDays = daysUsing(latest.days);
  // The plan in force until the latest starts: the last one before it that is ever in force.
  const before = latest.start > today ? spans.slice(0, -1).findLast((s) => !s.empty) : undefined;
  const earlierPlanDays = before ? daysUsing(before.days) : [];
  const structure = programDays.length > 0 || earlierPlanDays.length > 0;
  const targeted = settings.strengthTargets.some((t) => t.exerciseId === exercise.id);
  return { programDays, earlierPlanDays, latestIsNext: !!before, structure, keepsMax: exercise.tracksMax && (structure || targeted) };
}

/**
 * Whose main lift a locked exercise is, for a sentence: "Mon & Thu's main lift". While a next cycle
 * is scheduled the days of the two plans are told apart: "Mon's main lift next cycle and Wed's this
 * cycle". Days the two plans share are said once, without a name.
 */
export function mainLiftOf(locks: Pick<ExerciseLocks, "programDays" | "earlierPlanDays" | "latestIsNext">): string {
  const { programDays: latest, earlierPlanDays: earlier } = locks;
  if (!earlier.length) return `${programDayList(latest)}'s main lift${locks.latestIsNext ? " next cycle" : ""}`;
  if (sameDays(latest, earlier)) return `${programDayList(latest)}'s main lift`;
  const earlierText = `${programDayList(earlier)}'s ${latest.length ? "" : "main lift "}this cycle`;
  if (!latest.length) return earlierText;
  return `${programDayList(latest)}'s main lift next cycle and ${earlierText}`;
}

const sameDays = (a: ReadonlyArray<number>, b: ReadonlyArray<number>) => a.length === b.length && a.every((d, i) => b[i] === d);

/** Where to change what locks a lift, for a sentence: the weekly layout of the plans that use it. */
function layoutToChange(locks: Pick<ExerciseLocks, "programDays" | "earlierPlanDays" | "latestIsNext">): string {
  const { programDays: latest, earlierPlanDays: earlier } = locks;
  if (!earlier.length) return locks.latestIsNext ? "the next cycle's weekly layout" : "the weekly layout";
  if (!latest.length) return "this cycle's weekly layout";
  return sameDays(latest, earlier) ? "the weekly layout of this cycle and the next" : "the weekly layout of both cycles";
}

/** The date the server checks the locks on (`exerciseLocks`): its own date plus a day for time zones. */
export const serverLockDate = (serverToday: ISODate): ISODate => addDays(serverToday, 1);

/** Program days as words: "Mon", "Mon & Thu", "Mon, Wed & Fri". */
export function programDayList(days: ReadonlyArray<number>): string {
  const names = days.map((d) => WEEKDAY_SHORT[d] ?? "");
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} & ${names.at(-1)}` : (names[0] ?? "");
}

/**
 * Why the server refuses `patch` of `exercise`, or null when it may be saved: the locks the edit
 * sheet shows (`exerciseLocks`), enforced for every client — a stale device, an older build. A lift
 * the program calculates can't be archived, stop tracking its max, leave the barbell category or
 * change its measure; a lift with a strength target can't stop tracking its max. Fields set to what
 * they already are (and anything else) pass.
 */
export function exercisePatchRefusal(
  exercise: Pick<Exercise, "id" | "name" | "category" | "measure" | "tracksMax" | "archived">,
  patch: ExerciseEditPatch,
  settings: Pick<Settings, "program" | "strengthTargets">,
  today: ISODate,
): string | null {
  const locks = exerciseLocks(exercise, settings, today);
  const dropsMax = patch.tracksMax === false && exercise.tracksMax;
  if (locks.structure) {
    const breaks =
      (patch.archived === true && !exercise.archived) ||
      dropsMax ||
      (patch.category !== undefined && patch.category !== exercise.category && patch.category !== "primary") ||
      (patch.measure !== undefined && patch.measure !== exercise.measure);
    if (breaks)
      return `${exercise.name} is ${mainLiftOf(locks)}: the program calculates it, so it keeps its category, measure and max tracking and can't be archived. Change ${layoutToChange(locks)} on Program first.`;
  }
  if (dropsMax && locks.keepsMax) return `${exercise.name} has a strength target, so it keeps tracking its max.`;
  return null;
}

/** An exercise as the edit form holds it. */
export interface ExerciseDraft {
  name: string;
  category: ExerciseCategory;
  measure: Measure;
  weighted: boolean;
  tracksMax: boolean;
  archived: boolean;
}

/** The form's starting point for `exercise`. */
export function exerciseDraft(exercise: Exercise): ExerciseDraft {
  return {
    name: exercise.name,
    category: exercise.category,
    measure: exercise.measure,
    weighted: isWeighted(exercise),
    tracksMax: exercise.tracksMax,
    archived: exercise.archived,
  };
}

export type ExerciseEditPatch = Partial<Omit<Exercise, "id">>;

/**
 * The patch that turns `before` into `draft`: only the fields that change, so one edit never
 * overwrites another device's edit of a field it didn't touch (patches merge per field). The name
 * is trimmed (blank keeps the old one); locked fields (`locks`) keep their value; a main lift
 * (`isMainLift`, after the edit) is always weighted — making an unweighted exercise a main lift turns
 * its load on.
 */
export function exerciseEditPatch(before: Exercise, draft: ExerciseDraft, locks?: ExerciseLocks): ExerciseEditPatch {
  const name = draft.name.trim() || before.name;
  const category = locks?.structure ? before.category : draft.category;
  const measure = locks?.structure ? before.measure : draft.measure;
  const tracksMax = locks?.structure || (locks?.keepsMax && !draft.tracksMax) ? before.tracksMax : draft.tracksMax;
  const archived = locks?.structure && draft.archived ? before.archived : draft.archived;
  const weighted = isMainLift({ category, tracksMax }) || draft.weighted;
  const patch: ExerciseEditPatch = {};
  if (name !== before.name) patch.name = name;
  if (category !== before.category) patch.category = category;
  if (measure !== before.measure) patch.measure = measure;
  if (weighted !== isWeighted(before)) patch.weighted = weighted;
  if (tracksMax !== before.tracksMax) patch.tracksMax = tracksMax;
  if (archived !== before.archived) patch.archived = archived;
  return patch;
}
