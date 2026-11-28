/**
 * The training day on Train, by section (SPEC §6.7): **Metcon → Strength (main lift, Accessories,
 * Core) → Rehab → Zone 2**. A section is there when the plan has it on the day, when the day holds
 * it (data wins), or when it was added for the day (view state). Each reads To do / In progress /
 * Done / Not today / Not done (a past day) / Planned (a preview), all derived — nothing here is
 * stored but the existing per-exercise `skipped` flags and the day log's `metconSkipped` /
 * `zone2Skipped` (B.4). Pure.
 *
 * Strength is finished only by Finish (`completedAt`, the one meaning it has: "strength
 * finished"); rehab is done when every set of it not skipped is logged. Neither the sections nor
 * "day complete" touch the checklist, streaks or achievements (SPEC §7).
 */
import type { ISODate } from "./dates";
import { weekdayOf } from "./dates";
import type { AppData } from "./gamify";
import { planTargets, scheduledProgramDay } from "./program";
import { rehabById, rehabInForce, rehabPlanned, rehabProgramsAt, withRehabDraft } from "./rehab";
import type { Block, BlockExercise, DayLog, RehabProgram, Session } from "./schemas";
import { allLogged, buildSession, countsOf, isStrengthBlock, movedSessionsByPlan, strengthCounts, type SetCounts } from "./session";
import { blockGroup } from "./sessionStructure";

/** The label of a strength session started on a day without one ("Add to the day" → Strength). */
export const EXTRA_SESSION_LABEL = "Extra session";

export type SectionKey = "metcon" | "strength" | "rehab" | "zone2";

/**
 * - `todo`: there, nothing logged (to do on today, or the day's draft);
 * - `progress`: something logged (a set; a metcon's notes or score, a Zone 2 duration or reading) but not done;
 * - `done`: Metcon / Zone 2 checked, Strength finished (`completedAt`, or its plan finished on
 *   another day: `doneOn`), Rehab with every set not skipped logged;
 * - `skipped`: "Not today" (on purpose);
 * - `notDone`: a past day's section neither done nor skipped;
 * - `notSetUp`: Rehab with no exercises yet (`empty`) on a past day: never "Not done", never missed;
 * - `planned`: a future day (a preview, which never saves).
 */
export type SectionStatus = "todo" | "progress" | "done" | "skipped" | "notDone" | "notSetUp" | "planned";

export interface DaySection {
  key: SectionKey;
  status: SectionStatus;
  /** Sets logged / to log (what is skipped left out); Metcon and Zone 2 count as one item (0 or 1 of 1). */
  counts: SetCounts;
  /** The plan has it on the day (Strength: a lifting day, or the day holds a moved session). */
  planned: boolean;
  /** There without being planned: the day holds it, or it was added for the day. */
  added: boolean;
  /** Rehab with no exercises yet (not set up): no Not today, and "day complete" leaves it out. */
  empty: boolean;
  /** Rehab only: the rehab block it is (`program` null for blocks naming none that settings hold). */
  rehab?: { id: string; program: RehabProgram | null };
  /** Strength only: the day's plan was finished on another day ("Done Sun"), what makes it done. */
  doneOn?: ISODate;
}

export interface DaySectionsOptions {
  today: ISODate;
  /** The day's session as shown (saved, or the plan's draft); by default the saved one, else `buildSession(date)`. */
  session?: Session;
  /** Sections added for the day and not stored yet (view state: "Added for today"). */
  added?: ReadonlyArray<SectionKey>;
}

export type DayData = Pick<AppData, "settings" | "days" | "sessions" | "exercises" | "maxEntries">;

const lastOf = <T extends { date: ISODate }>(list: ReadonlyArray<T>, date: ISODate): T | undefined => list.findLast((x) => x.date === date);
const logged = (blocks: ReadonlyArray<Block>) => blocks.some((b) => b.exercises.some((e) => e.sets.some((s) => s.done)));
const filled = (v: string | null | undefined) => !!v && v.trim() !== "";

/**
 * Whether a saved session holds Strength: a strength block (every session saved before rehab
 * existed that holds anything), finished, a moved plan, an extra session. A session holding only
 * rehab blocks doesn't — nor one holding no block at all and none of the rest (notes only: what
 * Reset to plan keeps on a day whose plan has no strength, `resetStrength`), which would otherwise
 * show a Strength section with nothing in it, never to be done. On a lifting day Strength is there
 * anyway, as the plan's.
 */
export function holdsStrength(session: Session): boolean {
  return session.blocks.some(isStrengthBlock) || !!session.completedAt || !!session.plannedFor || session.label === EXTRA_SESSION_LABEL;
}

const exerciseSkipped = (b: Block, e: BlockExercise) => !!b.skipped || !!e.skipped;

/** Strength has something and all of it is skipped: "Not today" (the main lift's block and every accessory and core exercise). */
export function strengthSkipped(session: Pick<Session, "blocks">): boolean {
  const xs = session.blocks.filter(isStrengthBlock).flatMap((b) => b.exercises.map((e) => exerciseSkipped(b, e)));
  return xs.length > 0 && xs.every(Boolean);
}

/**
 * The day's sections in order (Metcon, Strength, Rehab — one per rehab block, by start — Zone 2),
 * each with its status and counts. Plans over time are read through program.ts (`planTargets`,
 * `scheduledProgramDay`), rehab blocks through rehab.ts; the session is the day's view with the
 * live rehab draft (`withRehabDraft`). A rehab block held in the session shows while it is in
 * force or has a logged set (data wins); one ended with nothing done leaves at once.
 */
export function daySections(date: ISODate, data: DayData, opts: DaySectionsOptions): DaySection[] {
  const { settings } = data;
  const added = new Set(opts.added ?? []);
  const preview = date > opts.today;
  const past = date < opts.today;
  const saved = lastOf(data.sessions, date);
  const view = withRehabDraft(opts.session ?? saved ?? buildSession(date, data, { core: true }), data);
  const day: Partial<DayLog> | undefined = lastOf(data.days, date);
  const plan = planTargets(settings, date);
  const wd = weekdayOf(date);
  const out: DaySection[] = [];
  const open = (s: { done: boolean; skipped: boolean; progress: boolean }): SectionStatus =>
    s.done ? "done" : preview ? "planned" : s.skipped ? "skipped" : s.progress ? "progress" : past ? "notDone" : "todo";

  // Metcon
  const metcon = { planned: !!plan.metcon[wd], done: !!day?.metconDone, skipped: !!day?.metconSkipped };
  const metconData = filled(day?.metconNotes) || filled(day?.metconBenchmark) || filled(day?.metconScore);
  if (metcon.planned || metcon.done || metcon.skipped || metconData || added.has("metcon"))
    out.push({
      key: "metcon",
      status: open({ ...metcon, progress: metconData }),
      counts: { done: metcon.done ? 1 : 0, total: 1 },
      planned: metcon.planned,
      added: !metcon.planned,
      empty: false,
    });

  // Strength
  const movedFrom = !!saved?.plannedFor && saved.plannedFor !== date;
  const strengthPlanned = !!scheduledProgramDay(settings.program, date) || movedFrom;
  if (strengthPlanned || (saved && holdsStrength(saved)) || added.has("strength")) {
    const early = movedSessionsByPlan(data.sessions).get(date);
    const earlyDone = early?.completedAt && early.date !== date ? early : null;
    const counts = strengthCounts(view);
    const section: DaySection = {
      key: "strength",
      status: open({
        done: !!view.completedAt || !!earlyDone,
        skipped: strengthSkipped(view),
        progress: counts.done > 0,
      }),
      counts,
      planned: strengthPlanned,
      added: !strengthPlanned,
      empty: false,
    };
    if (!view.completedAt && earlyDone) section.doneOn = earlyDone.date;
    out.push(section);
  }

  // Rehab: the blocks planned on the day, those the day holds, and (added) those in force.
  const ids: string[] = rehabPlanned(settings, date).map((p) => p.id);
  for (const b of view.blocks) {
    if (b.kind !== "rehab") continue;
    const id = b.rehab ?? "";
    if (ids.includes(id)) continue;
    const program = id ? rehabById(settings, id) : null;
    const own = view.blocks.filter((x) => x.kind === "rehab" && (x.rehab ?? "") === id);
    if (logged(own) || (program && rehabInForce(program, date))) ids.push(id);
  }
  if (added.has("rehab")) for (const p of rehabProgramsAt(settings, date)) if (!ids.includes(p.id)) ids.push(p.id);
  const rehab = ids
    .map((id, i) => ({ id, i, program: id ? rehabById(settings, id) : null }))
    .sort((a, b) => {
      const sa = a.program?.start ?? "~";
      const sb = b.program?.start ?? "~";
      return sa < sb ? -1 : sa > sb ? 1 : a.i - b.i;
    });
  for (const { id, program } of rehab) {
    const blocks = view.blocks.filter((b) => b.kind === "rehab" && (b.rehab ?? "") === id);
    const counts = countsOf(blocks);
    const exercises = blocks.flatMap((b) => b.exercises);
    const planned = !!program && rehabPlanned(settings, date).some((p) => p.id === id);
    const status = open({
      done: allLogged(counts),
      skipped: exercises.length > 0 && exercises.every((e) => e.skipped),
      progress: counts.done > 0,
    });
    out.push({
      key: "rehab",
      // Nothing to do yet (B.4: not set up): a past day says so, never "Not done".
      status: status === "notDone" && exercises.length === 0 ? "notSetUp" : status,
      counts,
      planned,
      added: !planned,
      empty: exercises.length === 0,
      rehab: { id, program },
    });
  }

  // Zone 2
  const zone2 = { planned: !!plan.zone2[wd], done: !!day?.zone2Done, skipped: !!day?.zone2Skipped };
  const zone2Data = day?.zone2Minutes != null || day?.zone2Kcal != null;
  if (zone2.planned || zone2.done || zone2.skipped || zone2Data || day?.zone2Machine != null || added.has("zone2"))
    out.push({
      key: "zone2",
      status: open({ ...zone2, progress: zone2Data }),
      counts: { done: zone2.done ? 1 : 0, total: 1 },
      planned: zone2.planned,
      added: !zone2.planned,
      empty: false,
    });

  return out;
}

/**
 * The day is complete: every section it holds is done or Not today, and at least one is done.
 * Rehab not set up yet (no exercises) is left out. Derived, never stored, and no part of closing
 * the day (the checklist) or the streak.
 */
export function dayComplete(sections: ReadonlyArray<DaySection>): boolean {
  const counted = sections.filter((s) => !s.empty);
  return (
    counted.length > 0 && counted.every((s) => s.status === "done" || s.status === "skipped") && counted.some((s) => s.status === "done")
  );
}

/** The section to name in the day line and mark on the page: the first in progress, else the first to do. */
export function currentSection(sections: ReadonlyArray<DaySection>): DaySection | null {
  return sections.find((s) => s.status === "progress") ?? sections.find((s) => s.status === "todo" && !s.empty) ?? null;
}

// ---------------------------------------------------------------------------
// Subsections, Not today and Bring back (B.4)
// ---------------------------------------------------------------------------

/** What "Not today" applies to: Strength whole, one of its subsections, or a rehab block's section (`rehab: ""` = rehab blocks naming none). */
export type SkipScope = "strength" | "main" | "accessories" | "core" | { rehab: string };

const inScope = (b: Block, scope: SkipScope): boolean => {
  if (typeof scope === "object") return b.kind === "rehab" && (b.rehab ?? "") === scope.rehab;
  if (scope === "strength") return isStrengthBlock(b);
  return blockGroup(b, { core: true }) === scope;
};

/** A part of the day's session as its label row shows it ("2/6", "DONE", "NOT TODAY"). */
export interface ScopeState {
  /** Logged / to log, what is skipped left out. */
  counts: SetCounts;
  /** Exercises it holds (skipped or not). */
  exercises: number;
  /** `empty`: nothing in it. `skipped`: it has exercises and all are skipped (the main lift: its block). */
  status: "empty" | "todo" | "progress" | "done" | "skipped";
  /** "Not today" is offered: something to skip, nothing logged in it (a skipped exercise's sets too), Strength not finished. */
  canSkip: boolean;
  /** Something of it is skipped: "Bring back" has something to clear. */
  anySkipped: boolean;
}

/** The state of a part of the session (`SkipScope`). */
export function scopeState(session: Pick<Session, "blocks" | "completedAt">, scope: SkipScope): ScopeState {
  const blocks = session.blocks.filter((b) => inScope(b, scope));
  const flags = blocks.flatMap((b) => b.exercises.map((e) => exerciseSkipped(b, e)));
  const counts = countsOf(blocks);
  const skipped = flags.length > 0 && flags.every(Boolean);
  const status: ScopeState["status"] = !flags.length
    ? "empty"
    : allLogged(counts)
      ? "done"
      : skipped
        ? "skipped"
        : counts.done > 0
          ? "progress"
          : "todo";
  const strength = typeof scope !== "object";
  const canSkip = flags.length > 0 && !skipped && !logged(blocks) && !(strength && session.completedAt);
  return { counts, exercises: flags.length, status, canSkip, anySkipped: flags.some(Boolean) };
}

/** Strength's subsection state: Main lift, Accessories or Core. */
export const subsectionState = (session: Pick<Session, "blocks" | "completedAt">, sub: "main" | "accessories" | "core"): ScopeState =>
  scopeState(session, sub);

/** `session` with `fn` applied to the blocks in `scope`; the same object when nothing changes. */
function mapScope(session: Session, scope: SkipScope, fn: (b: Block) => Block): Session {
  let changed = false;
  const blocks = session.blocks.map((b) => {
    if (!inScope(b, scope)) return b;
    const next = fn(b);
    if (next !== b) changed = true;
    return next;
  });
  return changed ? { ...session, blocks } : session;
}

/** `b` with its exercises through `fn` (the same block when none changes). */
function mapExercises(b: Block, fn: (e: BlockExercise) => BlockExercise): Block {
  const exercises = b.exercises.map(fn);
  return exercises.every((e, i) => e === b.exercises[i]) ? b : { ...b, exercises };
}

const skipEx = (e: BlockExercise): BlockExercise => (e.skipped ? e : { ...e, skipped: true });
function unskipEx(e: BlockExercise): BlockExercise {
  if (e.skipped === undefined) return e;
  const { skipped: _s, ...rest } = e;
  return rest;
}
function unskipBlock(b: Block): Block {
  if (b.skipped === undefined) return b;
  const { skipped: _s, ...rest } = b;
  return rest;
}

/**
 * "Not today" on a section or subsection, stored as nothing new (B.4): every exercise in it gets
 * the existing `skipped: true` — the main lift, its block's `skipped` (Strength: the main block's
 * plus every accessory and core exercise's). Old builds read these flags as ever: the sets count
 * for nothing, and next week's pre-fill carries the exercises un-skipped. Only while it is offered
 * (`scopeState(…).canSkip`: nothing in it logged); otherwise the same session.
 */
export function skipSection(session: Session, scope: SkipScope): Session {
  if (!scopeState(session, scope).canSkip) return session;
  return mapScope(session, scope, (b) => (b.kind === "primary" ? (b.skipped ? b : { ...b, skipped: true }) : mapExercises(b, skipEx)));
}

/**
 * "Bring back": every skip flag in the section cleared (removed, as never skipped), an exercise
 * skipped on its own before included — the Undo of the toast (`restoreSkips`) is what puts back
 * exactly the flags there were. The same session when nothing in it is skipped.
 */
export function bringBack(session: Session, scope: SkipScope): Session {
  return mapScope(session, scope, (b) => mapExercises(unskipBlock(b), unskipEx));
}

/**
 * The Undo of `skipSection` / `bringBack` / `markRestNotToday`, on the session as it is now
 * (another device may have saved since): only the skip flags of what `scope` holds go back to
 * those of `before` — for the blocks (by id) and exercises (same place and exercise, else the
 * exercise holding one of its sets) still there. Nothing else changes.
 */
export function restoreSkips(current: Session, before: Session, scope: SkipScope): Session {
  return mapScope(current, scope, (b) => {
    const was = before.blocks.find((x) => x.id === b.id);
    if (!was) return b;
    const block = was.skipped ? (b.skipped ? b : { ...b, skipped: true as const }) : unskipBlock(b);
    return mapExercises(block, (e) => {
      const at = block.exercises.indexOf(e);
      const same = was.exercises[at];
      const ids = new Set(e.sets.map((s) => s.id));
      const prev =
        same && same.exerciseId === e.exerciseId
          ? same
          : was.exercises.find((x) => x.exerciseId === e.exerciseId && x.sets.some((s) => ids.has(s.id)));
      if (!prev) return e;
      return prev.skipped ? skipEx(e) : unskipEx(e);
    });
  });
}

/**
 * The Finish guardrail's "Finish — mark the rest not today": every strength exercise with nothing
 * logged gets `skipped: true` (the main lift: its block), exercises partly logged stay as they are.
 * The same session when there is none.
 */
export function markRestNotToday(session: Session): Session {
  const untouched = (e: BlockExercise) => !e.sets.some((s) => s.done);
  return mapScope(session, "strength", (b) =>
    b.kind === "primary"
      ? !b.skipped && b.exercises.every(untouched)
        ? { ...b, skipped: true }
        : b
      : mapExercises(b, (e) => (untouched(e) ? skipEx(e) : e)),
  );
}
