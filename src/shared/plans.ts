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
import { addDays, daysBetween, type ISODate } from "./dates";
import { cyclePosition, FIRST_PLAN_ID, planAt, planInForce, planTimeline } from "./program";
import type { Plan, Session, Settings } from "./schemas";
import { planDateOf } from "./session";

/** Every plan of the settings, oldest first (the last is the latest, the document's top level). */
export function planList(settings: Settings): Plan[] {
  const { program } = settings;
  return [
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
  ];
}

/**
 * `settings` holding `plans` (oldest first, at least one): the last becomes the top level, the
 * rest `earlierPlans`. `earlierPlans` is only written when there are earlier plans and `planId`
 * only when it isn't the first plan's (absent, both mean exactly that), so a document that never
 * had a second plan — or had it cancelled — is stored as before plans existed.
 */
export function withPlans(settings: Settings, plans: ReadonlyArray<Plan>): Settings {
  const latest = plans[plans.length - 1]!;
  const earlier = plans.slice(0, -1);
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

/** The plan with `id`, or null. */
export function planById(settings: Settings, id: string): Plan | null {
  return planList(settings).find((p) => p.id === id) ?? null;
}

/** The plan in force on `today` (before the program: the first), as stored. */
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

/** Whether a session saved for a day of [from, to] — by its date or the day it was planned for. */
const savedBetween = (sessions: ReadonlyArray<Session>, from: ISODate, to: ISODate) =>
  sessions.some((s) => (planDateOf(s) >= from && planDateOf(s) <= to) || (s.date >= from && s.date <= to));

/**
 * Where a new cycle set up on `today` starts: the next cycle's Monday — or the current cycle's,
 * when no session has been saved in it yet (the cycle is opened on its first Monday and the choice
 * made then) and that isn't the current plan's own first day. Null before the program starts (the
 * plan itself is edited then) and while a next cycle is already scheduled.
 */
export function newCycleStart(settings: Settings, sessions: ReadonlyArray<Session>, today: ISODate): ISODate | null {
  const pos = cyclePosition(settings.program, today);
  if (!pos || nextPlan(settings, today)) return null;
  if (pos.cycleStart > pos.plan.start && !savedBetween(sessions, pos.cycleStart, pos.cycleEnd)) return pos.cycleStart;
  return addDays(pos.cycleEnd, 1);
}

/**
 * "Set up a new cycle": a copy of the plan in force on `today` (everything it holds: weeks, lifting
 * days, targets, schedule, name), as the latest plan from `newCycleStart` on, with the id `id`.
 * Null when no new cycle can be set up now (see `newCycleStart`).
 */
export function startNewCycle(
  settings: Settings,
  sessions: ReadonlyArray<Session>,
  today: ISODate,
  id: string,
): { settings: Settings; plan: Plan } | null {
  const start = newCycleStart(settings, sessions, today);
  if (!start) return null;
  const plans = planList(settings);
  const copy: Plan = { ...currentPlan(settings, today), id, start };
  // Plans that would start on or after the new one never came into force: there are none while
  // nothing is scheduled, but a copy is never put before a plan it would hide.
  const kept = plans.filter((p) => p.start < start);
  if (kept.length !== plans.length) return null;
  return { settings: withPlans(settings, [...kept, copy]), plan: copy };
}

/**
 * The next cycle cancelled: the scheduled plan `id` (the latest, not yet in force on `today`)
 * removed, so the plan before it repeats. Null when `id` isn't such a plan.
 */
export function cancelPlan(settings: Settings, id: string, today: ISODate): Settings | null {
  const next = nextPlan(settings, today);
  if (!next || next.id !== id) return null;
  return withPlans(settings, planList(settings).slice(0, -1));
}

/**
 * Undo of a new cycle's cancellation: `plan` back as the latest — while no plan starts on or after
 * its start (otherwise null: something else has been set up since).
 */
export function restorePlan(settings: Settings, plan: Plan): Settings | null {
  const plans = planList(settings);
  if (plans.some((p) => p.id === plan.id || p.start >= plan.start)) return null;
  return withPlans(settings, [...plans, plan]);
}

/** Undo of "Set up a new cycle": the plan `id` removed again, while it is still the latest. Null otherwise. */
export function removeNewPlan(settings: Settings, id: string): Settings | null {
  const plans = planList(settings);
  if (plans.length < 2 || plans[plans.length - 1]!.id !== id) return null;
  return withPlans(settings, plans.slice(0, -1));
}

// ---------------------------------------------------------------------------
// The choice at the end of a cycle (SPEC §7)
// ---------------------------------------------------------------------------

/**
 * The seen mark of "Repeat cycle N" (stored with the seen achievements: a set that only grows and
 * syncs by union, so the choice can't be lost or asked again by a merge).
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
 * The quiet card of a cycle's last week (Train, Program › Now): "Cycle 2 ends Sun Nov 29. Next:
 * Repeat cycle 2 · Set up a new cycle". Null outside a cycle's last seven days, and once "Repeat"
 * was chosen for the cycle (`repeatCycleKey` in `seen`) while nothing else is set up.
 */
export function cycleEndCard(settings: Settings, seen: ReadonlyArray<string> | ReadonlySet<string>, today: ISODate): CycleEndCard | null {
  const pos = cyclePosition(settings.program, today);
  if (!pos || daysBetween(today, pos.cycleEnd) >= 7) return null;
  const next = nextPlan(settings, today);
  if (next && next.start === addDays(pos.cycleEnd, 1)) return { cycle: pos.cycle, end: pos.cycleEnd, next };
  const has = (k: string) => (Array.isArray(seen) ? seen.includes(k) : (seen as ReadonlySet<string>).has(k));
  if (has(repeatCycleKey(pos.cycle)) || next) return null;
  return { cycle: pos.cycle, end: pos.cycleEnd, next: null };
}

/**
 * Whether "Cycle N complete" offers the choice too (Repeat cycle N · Set up a new cycle): `cycle`
 * is the one that ended most recently (today is in the cycle after it), nothing has been saved in
 * the new cycle yet, Repeat wasn't chosen and no new plan starts with it. "Set up a new cycle" then
 * starts the plan on today's cycle's Monday (`newCycleStart`).
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
