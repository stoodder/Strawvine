/**
 * Plans over time (SPEC §6.4): the weekly training plan — the cycle's weeks, the lifting days, the
 * steps and Zone 2 targets and the metcon / Zone 2 days — as a sequence, each plan in force from its
 * Monday until the next one starts. This module edits that sequence (start a new cycle, cancel it,
 * edit one plan) and decides when to offer the choice at the end of a cycle. Reading a date's plan
 * is program.ts's (`planAt`, `cyclePosition`, `planTargets`).
 *
 * Storage: the latest plan is the settings' top level (`program.name / cycleStartDate / weeks / days
 * / planId`, `targets`, `schedule`) and the plans before it are `program.earlierPlans`, oldest first.
 * A document without `earlierPlans` has one plan — every document stored before plans existed.
 */
import { addDays, daysBetween, formatShortDate, weekdayName, type ISODate } from "./dates";
import { byStart, cyclePosition, FIRST_PLAN_ID, planAt, planInForce, planTimeline } from "./program";
import type { Plan, Session, Settings } from "./schemas";
import { planDateOf } from "./session";

/**
 * Every plan of the settings in time order (by start; the last is the latest, the document's top
 * level). A document stored out of order reads as if it were in order, as the timeline does.
 */
export function planList(settings: Settings): Plan[] {
  const { program } = settings;
  return byStart([
    ...(program.earlierPlans ?? []),
    {
      id: program.planId ?? FIRST_PLAN_ID,
      start: program.cycleStartDate,
      name: program.name,
      weeks: program.weeks,
      days: program.days,
      targets: settings.targets,
      schedule: settings.schedule,
    },
  ]);
}

/**
 * `settings` holding `plans` (at least one; put in order of their starts): the last becomes the top
 * level, the rest `earlierPlans`. `earlierPlans` is only written when there are earlier plans and
 * `planId` only when it isn't the first plan's (absent, both mean exactly that), so a document that
 * never had a second plan — or had it cancelled — is stored as before plans existed. The latest
 * plan has no `end` (it runs on).
 */
export function withPlans(settings: Settings, plans: ReadonlyArray<Plan>): Settings {
  const sorted = byStart(plans);
  const latest = sorted[sorted.length - 1]!;
  const earlier = sorted.slice(0, -1);
  const { earlierPlans: _e, planId: _p, ...rules } = settings.program;
  const keepId = latest.id !== FIRST_PLAN_ID;
  const keepList = earlier.length > 0;
  return {
    ...settings,
    targets: latest.targets,
    schedule: latest.schedule,
    program: {
      ...rules,
      name: latest.name,
      cycleStartDate: latest.start,
      weeks: latest.weeks,
      days: latest.days,
      ...(keepId ? { planId: latest.id } : {}),
      ...(keepList ? { earlierPlans: earlier } : {}),
    },
  };
}

/** What a plan holds besides its identity and start. */
export type PlanFields = Pick<Plan, "name" | "weeks" | "days" | "targets" | "schedule">;

/** `settings` with the plan `id` changed by `patch` (unchanged when there is no such plan). */
export function updatePlan(settings: Settings, id: string, patch: Partial<PlanFields>): Settings {
  const plans = planList(settings);
  const i = plans.findIndex((p) => p.id === id);
  if (i < 0) return settings;
  return withPlans(
    settings,
    plans.map((p, j) => (j === i ? { ...p, ...patch } : p)),
  );
}

/**
 * `updatePlan`, keeping the next plan where it was set up to start (SPEC §6.4): a next plan set up
 * for the end of this cycle (it starts the Monday the plan in force on `today` finishes the cycle
 * `today` is in) stays there when the cycle's weeks change — it moves, with every plan after it, to
 * the Monday after this cycle as it now runs, and the plan in force is set up to end there. Refused
 * (the settings unchanged) when that Monday wouldn't be after `today`.
 */
export function editPlan(
  settings: Settings,
  id: string,
  patch: Partial<PlanFields>,
  today: ISODate,
): { settings: Settings; refused: string | null } {
  const updated = updatePlan(settings, id, patch);
  if (!patch.weeks || updated === settings) return { settings: updated, refused: null };
  const pos = cyclePosition(settings.program, today);
  const next = nextPlan(settings, today);
  if (!pos || pos.plan.id !== id || !next) return { settings: updated, refused: null };
  // Attached: it starts where this cycle, run in full, ends.
  if (next.start !== addDays(pos.cycleStart, pos.weeksCount * 7)) return { settings: updated, refused: null };
  const weeks = patch.weeks.length;
  const inCycle = Math.floor(Math.floor(daysBetween(pos.plan.start, today) / 7) / weeks);
  const to = addDays(pos.plan.start, (inCycle + 1) * weeks * 7);
  if (to <= today) return { settings, refused: "The next cycle would start before today. Change the weeks once it has started." };
  if (to === next.start) return { settings: updated, refused: null };
  const delta = daysBetween(next.start, to);
  return {
    settings: withPlans(
      updated,
      planList(updated).map((p) => {
        if (p.id === id) return { ...p, end: to };
        if (p.start < next.start) return p;
        return { ...p, start: addDays(p.start, delta), ...(p.end ? { end: addDays(p.end, delta) } : {}) };
      }),
    ),
    refused: null,
  };
}

/** The plan with `id`, or null. */
export function planById(settings: Settings, id: string): Plan | null {
  return planList(settings).find((p) => p.id === id) ?? null;
}

/** The plan `today` reads (in force; before the program the first; in a pause the next), as stored. */
export function currentPlan(settings: Settings, today: ISODate): Plan {
  return planList(settings)[planAt(settings.program, today).index]!;
}

/**
 * The next cycle's plan when one is scheduled: the latest plan, when it starts after `today` and
 * another plan is in force (or comes first) until then. Null otherwise.
 */
export function nextPlan(settings: Settings, today: ISODate): Plan | null {
  const plans = planList(settings);
  if (plans.length < 2) return null;
  const latest = plans[plans.length - 1]!;
  if (latest.start <= today || planAt(settings.program, today).index === plans.length - 1) return null;
  return latest;
}

/** Whether a session was saved for a day of [from, to] — by its date or the day it was planned for. */
const savedBetween = (sessions: ReadonlyArray<Session>, from: ISODate, to: ISODate) =>
  sessions.some((s) => (planDateOf(s) >= from && planDateOf(s) <= to) || (s.date >= from && s.date <= to));

/** Whether a session was saved for `from` or a later day (by its date or the day it was planned for). */
const savedFrom = (sessions: ReadonlyArray<Session>, from: ISODate) => sessions.some((s) => planDateOf(s) >= from || s.date >= from);

export interface NewCycleOptions {
  /**
   * From the end-of-cycle note (the cycle's last week): always the Monday after this cycle — the
   * note asks about the next cycle, never this one.
   */
  atCycleEnd?: boolean;
}

/**
 * Where a new plan set up on `today` starts: the Monday after the current cycle — or the current
 * cycle's own Monday, when today is in the cycle's first seven days, nothing has been saved in it
 * yet (the cycle is opened on its first days and the choice made then: "Cycle N complete") and
 * that isn't the current plan's own first day. Never from the end-of-cycle note (`atCycleEnd`).
 * Null before the program starts (the plan itself is edited then), in a pause before a plan, and
 * while a next cycle is already scheduled (see `newCycleRefusal`).
 */
export function newCycleStart(
  settings: Settings,
  sessions: ReadonlyArray<Session>,
  today: ISODate,
  opts: NewCycleOptions = {},
): ISODate | null {
  const pos = cyclePosition(settings.program, today);
  if (!pos || nextPlan(settings, today)) return null;
  const firstWeek = daysBetween(pos.cycleStart, today) < 7;
  if (!opts.atCycleEnd && firstWeek && pos.cycleStart > pos.plan.start && !savedBetween(sessions, pos.cycleStart, pos.cycleEnd))
    return pos.cycleStart;
  return addDays(pos.cycleEnd, 1);
}

const day = (date: ISODate) => `${weekdayName(date, true)} ${formatShortDate(date)}`;

/** Why no new plan can be set up on `today` (`newCycleStart` is null), as a sentence; null when one can. */
export function newCycleRefusal(
  settings: Settings,
  sessions: ReadonlyArray<Session>,
  today: ISODate,
  opts: NewCycleOptions = {},
): string | null {
  if (newCycleStart(settings, sessions, today, opts)) return null;
  const next = nextPlan(settings, today);
  if (next) return `A new plan is already set up from ${day(next.start)}. Review it on Program.`;
  const upcoming = planAt(settings.program, today);
  if (!planInForce(settings.program, today) && upcoming.index > 0)
    return `Cycle ${upcoming.cyclesBefore + 1} hasn't started yet (it starts ${day(upcoming.start)}): change its plan on Program.`;
  return "The program hasn't started yet: change the plan itself on Program.";
}

/**
 * "Set up a new plan": a copy of the plan in force on `today` (everything it holds: weeks, lifting
 * days, targets, schedule, name), as the latest plan from `newCycleStart` on, with the id `id`; the
 * plan in force is set up to end there (its `end`). Null when no new plan can be set up now
 * (`newCycleRefusal` says why).
 */
export function startNewCycle(
  settings: Settings,
  sessions: ReadonlyArray<Session>,
  today: ISODate,
  id: string,
  opts: NewCycleOptions = {},
): { settings: Settings; plan: Plan } | null {
  const start = newCycleStart(settings, sessions, today, opts);
  if (!start) return null;
  const plans = planList(settings);
  const { end: _end, ...inForce } = currentPlan(settings, today);
  const copy: Plan = { ...inForce, id, start };
  // Plans that would start on or after the new one never came into force: there are none while
  // nothing is scheduled, but a copy is never put before a plan it would hide.
  if (plans.some((p) => p.start >= start || p.id === id)) return null;
  const last = plans.length - 1;
  return { settings: withPlans(settings, [...plans.map((p, i) => (i === last ? { ...p, end: start } : p)), copy]), plan: copy };
}

/**
 * The latest plan when it can be cancelled on `today`: while it is scheduled (starts after
 * `today`), and once in force while nothing is saved under it (no session for its start or a later
 * day). Null with one plan, or once something is saved under it (it is history then).
 */
export function cancellablePlan(settings: Settings, sessions: ReadonlyArray<Session>, today: ISODate): Plan | null {
  const plans = planList(settings);
  if (plans.length < 2) return null;
  const latest = plans[plans.length - 1]!;
  return latest.start > today || !savedFrom(sessions, latest.start) ? latest : null;
}

/**
 * The new plan cancelled: `id` (the latest, `cancellablePlan`) removed, so the plan before it is
 * the latest again — exactly as it was before the new plan was set up (it runs on: no `end`).
 * Null when `id` isn't such a plan.
 */
export function cancelPlan(settings: Settings, id: string, sessions: ReadonlyArray<Session>, today: ISODate): Settings | null {
  const plan = cancellablePlan(settings, sessions, today);
  if (!plan || plan.id !== id) return null;
  return withPlans(settings, planList(settings).slice(0, -1));
}

/** The stored `end` of the plan before `id` (what an Undo of cancelling `id` puts back). */
export function endBefore(settings: Settings, id: string): ISODate | undefined {
  const plans = planList(settings);
  const i = plans.findIndex((p) => p.id === id);
  return i > 0 ? plans[i - 1]!.end : undefined;
}

/**
 * Undo of a new plan's cancellation: `plan` back as the latest, the plan before it set up to end as
 * it was (`end`, from `endBefore`) — while no plan starts on or after its start (otherwise null:
 * something else has been set up since).
 */
export function restorePlan(settings: Settings, plan: Plan, end?: ISODate): Settings | null {
  const plans = planList(settings);
  if (plans.some((p) => p.id === plan.id || p.start >= plan.start)) return null;
  const last = plans.length - 1;
  const before = plans.map((p, i) => {
    if (i !== last) return p;
    const { end: _e, ...rest } = p;
    return end ? { ...rest, end } : rest;
  });
  return withPlans(settings, [...before, plan]);
}

/**
 * Undo of "Set up a new plan": the plan `id` removed again — while it is still the latest and still
 * exactly the copy that was made (`made`); an edit or a move of it since makes it the person's, and
 * the Undo declines (null).
 */
export function removeNewPlan(settings: Settings, id: string, made: Plan): Settings | null {
  const plans = planList(settings);
  const latest = plans[plans.length - 1]!;
  if (plans.length < 2 || latest.id !== id || !sameValue(latest, made)) return null;
  return withPlans(settings, plans.slice(0, -1));
}

/** Deep equality of JSON values (key order doesn't matter; an undefined key is an absent one). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b))
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra).filter((k) => ra[k] !== undefined);
  const kb = Object.keys(rb).filter((k) => rb[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => sameValue(ra[k], rb[k]));
}

// ---------------------------------------------------------------------------
// The choice at the end of a cycle (SPEC §7)
// ---------------------------------------------------------------------------

/**
 * The seen mark of "Keep this plan" at the end of cycle N (stored with the seen achievements: a set
 * that only grows and syncs by union, so the choice can't be lost or asked again by a merge).
 */
export const repeatCycleKey = (cycle: number) => `repeat-cycle-${cycle}`;

export interface CycleEndCard {
  /** The cycle that ends. */
  cycle: number;
  /** Its last day. */
  end: ISODate;
  /** The next cycle's plan, when one is set up (the card says so instead of asking). */
  next: Plan | null;
}

/**
 * The quiet card of a cycle's last week (Train, Program › Now): "Cycle 2 ends Sun Nov 29. For cycle
 * 3: Keep this plan · Set up a new plan". Null outside a cycle's last seven days; once "Keep" was
 * chosen for the cycle (`repeatCycleKey` in `seen`) while nothing else is set up; and in the first
 * week of a new plan that started with this cycle (a one-week cycle's first week is its last: the
 * question was just answered).
 */
export function cycleEndCard(settings: Settings, seen: ReadonlyArray<string> | ReadonlySet<string>, today: ISODate): CycleEndCard | null {
  const pos = cyclePosition(settings.program, today);
  if (!pos || daysBetween(today, pos.cycleEnd) >= 7) return null;
  if (pos.plan.index > 0 && pos.plan.start === pos.cycleStart && daysBetween(pos.cycleStart, today) < 7) return null;
  const next = nextPlan(settings, today);
  if (next && next.start === addDays(pos.cycleEnd, 1)) return { cycle: pos.cycle, end: pos.cycleEnd, next };
  const has = (k: string) => (Array.isArray(seen) ? seen.includes(k) : (seen as ReadonlySet<string>).has(k));
  if (has(repeatCycleKey(pos.cycle)) || next) return null;
  return { cycle: pos.cycle, end: pos.cycleEnd, next: null };
}

/**
 * Whether "Cycle N complete" offers the choice too (Keep this plan · Set up a new plan): `cycle` is
 * the one that ended most recently (today is in the first week of the cycle after it), nothing has
 * been saved in the new cycle yet, Keep wasn't chosen and no new plan starts with it. "Set up a new
 * plan" then starts the plan on today's cycle's Monday (`newCycleStart`).
 */
export function offersCycleChoice(
  settings: Settings,
  sessions: ReadonlyArray<Session>,
  seen: ReadonlyArray<string> | ReadonlySet<string>,
  today: ISODate,
  cycle: number,
): boolean {
  const pos = cyclePosition(settings.program, today);
  if (!pos || pos.cycle !== cycle + 1) return false;
  const has = (k: string) => (Array.isArray(seen) ? seen.includes(k) : (seen as ReadonlySet<string>).has(k));
  if (has(repeatCycleKey(cycle))) return false;
  if (pos.plan.index > 0 && pos.plan.start === pos.cycleStart) return false;
  if (savedBetween(sessions, pos.cycleStart, pos.cycleEnd)) return false;
  return newCycleStart(settings, sessions, today) === pos.cycleStart;
}

/** The plan in force on `today` is an earlier one (a next cycle is scheduled) — for the editor's switch. */
export function planIsHistory(settings: Settings, id: string, today: ISODate): boolean {
  const spans = planTimeline(settings.program);
  const i = planList(settings).findIndex((p) => p.id === id);
  const span = spans[i];
  if (!span) return false;
  const now = planInForce(settings.program, today);
  return !!now && span.index < now.index;
}
