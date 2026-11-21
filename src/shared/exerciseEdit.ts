/**
 * Editing an exercise in the library (§6.5): what may change, and the patch an edit sends. The
 * session side of a measure change (pre-fill, hints, the session in progress) lives in session.ts.
 */
import { WEEKDAY_SHORT } from "./dates";
import type { Exercise, ExerciseCategory, Measure, ProgramDay, Settings } from "./schemas";
import { isMainLift, isWeighted } from "./session";

export interface ExerciseLocks {
  /**
   * Weekdays (0 = Sun … 6 = Sat) whose program day in the latest plan calculates this exercise as its
   * main lift, Monday first.
   */
  programDays: number[];
  /**
   * The same in the plan before the latest one (SPEC §6.4) — the plan still in force while the
   * latest is the next cycle, scheduled. Empty with one plan.
   */
  earlierPlanDays: number[];
  /**
   * The program calculates it — in the latest plan or the one before: its category, measure and max
   * tracking stay as they are and it can't be archived, or those days would lose their main lift.
   * (Change the program's days first.) Which plans count doesn't depend on the date, so the server
   * enforces exactly what the sheet shows.
   */
  structure: boolean;
  /**
   * Max tracking can't be turned off: the program calculates the lift from its max, or a strength
   * target is set on it (Goals and Progress follow tracked lifts). Turning it on is always fine.
   */
  keepsMax: boolean;
}

/** What the exercise library may not change about `exercise` (see `ExerciseLocks`). */
export function exerciseLocks(
  exercise: Pick<Exercise, "id" | "tracksMax">,
  settings: Pick<Settings, "program" | "strengthTargets">,
): ExerciseLocks {
  const daysUsing = (days: Record<string, ProgramDay>) =>
    Object.entries(days)
      .filter(([, d]) => d.primaryExerciseId === exercise.id)
      .map(([k]) => Number(k))
      .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  const programDays = daysUsing(settings.program.days);
  const before = settings.program.earlierPlans?.at(-1);
  const earlierPlanDays = before ? daysUsing(before.days) : [];
  const structure = programDays.length > 0 || earlierPlanDays.length > 0;
  const targeted = settings.strengthTargets.some((t) => t.exerciseId === exercise.id);
  return { programDays, earlierPlanDays, structure, keepsMax: exercise.tracksMax && (structure || targeted) };
}

/**
 * Whose main lift a locked exercise is, for a sentence: "Mon & Thu's main lift". With two plans the
 * days are told apart — `when` names them ("next cycle" / "this cycle"; by default the plan before
 * the latest is "in the plan before" and the latest goes unnamed): "Wed's main lift this cycle and
 * Mon's next cycle". Days the two plans share are said once, without a name.
 */
export function mainLiftOf(locks: Pick<ExerciseLocks, "programDays" | "earlierPlanDays">, when: { latest?: string; earlier?: string } = {}): string {
  const { programDays: latest, earlierPlanDays: earlier } = locks;
  const same = latest.length === earlier.length && latest.every((d, i) => earlier[i] === d);
  if (!earlier.length || same) return `${programDayList(latest)}'s main lift`;
  const earlierText = `${programDayList(earlier)}'s ${latest.length ? "" : "main lift "}${when.earlier ?? "in the plan before"}`;
  if (!latest.length) return earlierText;
  const latestText = `${programDayList(latest)}'s main lift${when.latest ? ` ${when.latest}` : ""}`;
  return `${latestText} and ${earlierText}`;
}

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
): string | null {
  const locks = exerciseLocks(exercise, settings);
  const dropsMax = patch.tracksMax === false && exercise.tracksMax;
  if (locks.structure) {
    const breaks =
      (patch.archived === true && !exercise.archived) ||
      dropsMax ||
      (patch.category !== undefined && patch.category !== exercise.category && patch.category !== "primary") ||
      (patch.measure !== undefined && patch.measure !== exercise.measure);
    if (breaks)
      return `${exercise.name} is ${mainLiftOf(locks)}: the program calculates it, so it keeps its category, measure and max tracking and can't be archived. Change the weekly layout first.`;
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
