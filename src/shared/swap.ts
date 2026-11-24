/**
 * Swapping a session's main lift for that session only (SPEC §6.5, "Swap the main lift"): the day
 * keeps its label, accessories, notes, week and deload; only the main lift is another one, its
 * working sets calculated exactly as the plan's would be (§6.2) from that lift's max. The plan
 * doesn't change, and nothing marks the swap but the main block's lift (`mainLiftSwap`).
 */
import type { ISODate } from "./dates";
import { currentMax, cyclePosition, planAt, programDayFor } from "./program";
import type { Block, Session } from "./schemas";
import { mainLiftBlock, mainLiftSwap, planDateOf, planSignature, type BuildContext } from "./session";

type Ctx = Omit<BuildContext, "sessions">;

/** Why a swap can't be made. */
export type SwapRefusal =
  /** The session has no main lift to swap. */
  | "no-main"
  /** A set of the main lift is logged: logged work is never thrown away to swap. */
  | "logged"
  /** The main lift is skipped today: unskip it first. */
  | "skipped"
  /** The session is finished. */
  | "finished"
  /** The lift is unknown or archived. */
  | "unknown"
  /** The lift has no max to calculate from. */
  | "no-max"
  /** Nothing can be calculated for the day (before the program, in a pause). */
  | "not-planned";

const mainOf = (s: Pick<Session, "blocks">): Block | undefined => s.blocks.find((b) => b.kind === "primary");

/** Whether a session's main lift can be swapped now, and if not, why. */
export function swapBlocked(session: Session): SwapRefusal | null {
  const main = mainOf(session);
  if (!main) return "no-main";
  if (session.completedAt) return "finished";
  if (main.exercises.some((e) => e.sets.some((s) => s.done))) return "logged";
  if (main.skipped) return "skipped";
  return null;
}

/**
 * `session` with `exerciseId` as its main lift, for this session only: a new main-lift block (fresh
 * ids) calculated for the session's program day (`plannedFor ?? date`) — this cycle week's scheme,
 * deload and the day's AMRAP setting — from that lift's current max (`primaryMaxLb`). The label,
 * accessories, notes, week and deload stay. The plan signature stays the plan's, so the swap is
 * never read as a plan change — except when `exerciseId` is the day's planned lift ("back to the
 * planned lift"): the session then follows the plan as it is now, signature included.
 */
export function swapMainLift(session: Session, exerciseId: number, ctx: Ctx): { session: Session } | { refused: SwapRefusal } {
  const blocked = swapBlocked(session);
  if (blocked) return { refused: blocked };
  const ex = ctx.exercises.find((e) => e.id === exerciseId);
  if (!ex || ex.archived) return { refused: "unknown" };
  if (!currentMax(ctx.maxEntries, exerciseId)) return { refused: "no-max" };
  const planDate = planDateOf(session);
  const calc = mainLiftBlock(planDate, ctx, exerciseId);
  if (!calc) return { refused: "not-planned" };
  const main = mainOf(session)!;
  const planned = programDayFor(ctx.settings.program, planDate)?.primaryExerciseId ?? null;
  const next: Session = {
    ...session,
    primaryMaxLb: calc.primaryMaxLb,
    blocks: session.blocks.map((b) => (b === main ? calc.block : b)),
  };
  if (exerciseId === planned) next.planSig = planSignature(planDate, ctx);
  return { session: next };
}

/**
 * The Undo of a swap, on the session as it is now (`current`, another device may have saved
 * since): only what the swap changed — the main block, `primaryMaxLb`, `planSig` — goes back to
 * `before`, and only while the main block is still the one the swap put there (`swapped`) with
 * nothing logged in it. Otherwise why it can't: "logged" (a set of it is logged since) or
 * "changed" (the main lift was swapped or recalculated again).
 */
export function undoSwap(current: Session, swapped: Session, before: Session): Session | "logged" | "changed" {
  const now = mainOf(current);
  const put = mainOf(swapped);
  const was = mainOf(before);
  if (!now || !put || !was || now.id !== put.id) return "changed";
  if (now.exercises.some((e) => e.sets.some((s) => s.done))) return "logged";
  const next: Session = {
    ...current,
    primaryMaxLb: before.primaryMaxLb,
    blocks: current.blocks.map((b) => (b === now ? was : b)),
  };
  if (before.planSig === undefined) delete next.planSig;
  else next.planSig = before.planSig;
  return next;
}

/** A lift the swap sheet offers. */
export interface SwapChoice {
  exerciseId: number;
  /** The weekdays (0 = Sun) it is the main lift of, Monday first; empty for a lift on no program day. */
  days: number[];
  /** Whether it has a max to calculate from (one without can't be picked). */
  hasMax: boolean;
}

const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0];

/**
 * What the swap sheet offers for `session`: the planned lift to go back to (when swapped), then
 * the main lifts of the session's plan (`planAt` its program day), Monday first, each with its
 * days, then every other lift a day could have as its main lift (max-tracked, not archived — the
 * weekly layout's choice), by name. The lift in the main block now is not among them.
 */
export function swapChoices(session: Session, ctx: Ctx): { back: number | null; choices: SwapChoice[] } {
  const main = mainOf(session)?.exercises[0]?.exerciseId ?? null;
  const planDate = planDateOf(session);
  const planned = programDayFor(ctx.settings.program, planDate)?.primaryExerciseId ?? null;
  const back = mainLiftSwap(session) && planned !== null && planned !== main ? planned : null;
  const days = planAt(ctx.settings.program, planDate).days;
  const hasMax = (id: number) => !!currentMax(ctx.maxEntries, id);
  const live = (id: number) => ctx.exercises.some((e) => e.id === id && !e.archived);
  const choices: SwapChoice[] = [];
  const listed = new Set<number>([...(main !== null ? [main] : []), ...(back !== null ? [back] : [])]);
  for (const wd of MONDAY_FIRST) {
    const id = days[String(wd)]?.primaryExerciseId;
    if (id == null || !live(id)) continue;
    const at = choices.find((c) => c.exerciseId === id);
    if (at) at.days.push(wd);
    else if (!listed.has(id)) choices.push({ exerciseId: id, days: [wd], hasMax: hasMax(id) });
  }
  for (const c of choices) listed.add(c.exerciseId);
  const others = ctx.exercises
    .filter((e) => e.tracksMax && !e.archived && !listed.has(e.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => ({ exerciseId: e.id, days: [], hasMax: hasMax(e.id) }));
  return { back, choices: [...choices, ...others] };
}

/** "Back squat was done Tue. Do Deadlift today?" — see `swapSuggestion`. */
export interface SwapSuggestion {
  /** The day's planned main lift, already done this week in a swap. */
  done: number;
  /** When (the date of the session that did it). */
  doneOn: ISODate;
  /** The lift that session's day had planned, still to do this week: the one to swap in. */
  suggest: number;
}

/**
 * Swapping between days, derived and never stored: when the main lift `date` plans was already
 * done earlier this cycle week in place of another day's lift (a swapped session, its main lift
 * logged, `mainLiftSwap`), the lift that day had planned — unless it was done this week too — with a max to
 * calculate from. Only for a day without a session of its own (the caller passes the saved ones);
 * null otherwise.
 */
export function swapSuggestion(date: ISODate, ctx: BuildContext): SwapSuggestion | null {
  const { program } = ctx.settings;
  if (ctx.sessions.some((s) => s.date === date)) return null;
  const pos = cyclePosition(program, date);
  const planned = pos ? programDayFor(program, date)?.primaryExerciseId : null;
  if (!pos || planned == null) return null;
  const week = ctx.sessions.filter((s) => s.date >= pos.weekStart && s.date < date).sort((a, b) => (a.date < b.date ? -1 : 1));
  const didMain = (s: Session, lift: number) => {
    const main = mainOf(s);
    return !!main && !main.skipped && main.exercises[0]?.exerciseId === lift && main.exercises[0].sets.some((x) => x.done);
  };
  for (const s of [...week].reverse()) {
    const swap = mainLiftSwap(s);
    if (!swap || swap.to !== planned || swap.from === planned || !didMain(s, planned)) continue;
    if (week.some((o) => o !== s && didMain(o, swap.from))) return null;
    if (!currentMax(ctx.maxEntries, swap.from) || !ctx.exercises.some((e) => e.id === swap.from && !e.archived)) return null;
    return { done: planned, doneOn: s.date, suggest: swap.from };
  }
  return null;
}
