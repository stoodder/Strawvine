/**
 * Rehab blocks (SPEC §6.8): a protocol on its own timeline ("Knee rehab · 6 weeks · Mon/Wed/Fri"),
 * independent of the strength plans — a pause, a new cycle or a moved start never moves it. The
 * one resolver: everything reads and edits `settings.rehab` through here, never the fields. Pure.
 *
 * A block is **in force** on `d` when `start ≤ d ≤ min(start + 7·weeks − 1, end)` and **planned**
 * on `d` when it is in force and `days[weekday(d)]` is set; its week is `⌊(d − start)/7⌋ + 1`. A
 * session's rehab blocks (`kind: "rehab"`) name the rehab block they were logged for (`rehab`).
 * Rehab is outside strength: it never completes a session (`completedAt` means "strength
 * finished"), so it never closes the lift, a streak day or a cycle.
 */
import { addDays, daysBetween, formatShortDate, isISODate, weekdayOf, type ISODate } from "./dates";
import type { Block, RehabProgram, Session, Settings } from "./schemas";
import { carryOverExercise, countsOf, lastRehabPerformance, newId, type BuildContext, type SetCounts } from "./session";
import { MAX_BLOCKS } from "./sessionStructure";

/** Most rehab blocks settings hold (the schema's limit). */
export const MAX_REHAB_PROGRAMS = 100;

/** The rehab blocks, ordered by start (stable). */
export function rehabPrograms(settings: Pick<Settings, "rehab">): RehabProgram[] {
  return [...(settings.rehab?.programs ?? [])]
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (a.p.start < b.p.start ? -1 : a.p.start > b.p.start ? 1 : a.i - b.i))
    .map((x) => x.p);
}

/** A rehab block by its id. */
export function rehabById(settings: Pick<Settings, "rehab">, id: string): RehabProgram | null {
  return settings.rehab?.programs.find((p) => p.id === id) ?? null;
}

/** Its natural last day: `start + 7·weeks − 1`. */
const naturalEnd = (p: Pick<RehabProgram, "start" | "weeks">): ISODate => addDays(p.start, p.weeks * 7 - 1);

/** A block's last day (inclusive): its natural end, or the day it was ended early (`end`), whichever is first. */
export function rehabLastDay(p: Pick<RehabProgram, "start" | "weeks" | "end">): ISODate {
  const natural = naturalEnd(p);
  return p.end !== undefined && p.end < natural ? p.end : natural;
}

/** Whether the block is in force on `date` (`start ≤ date ≤ rehabLastDay`). */
export function rehabInForce(p: Pick<RehabProgram, "start" | "weeks" | "end">, date: ISODate): boolean {
  return p.start <= date && date <= rehabLastDay(p);
}

/** Whether the block is planned on `date`: in force, and one of its days. */
export function rehabDay(p: RehabProgram, date: ISODate): boolean {
  return rehabInForce(p, date) && !!p.days[weekdayOf(date)];
}

/** The rehab blocks in force on `date`, by start (one, while overlap is refused). */
export function rehabProgramsAt(settings: Pick<Settings, "rehab">, date: ISODate): RehabProgram[] {
  return rehabPrograms(settings).filter((p) => rehabInForce(p, date));
}

/** The rehab blocks planned on `date` (in force, one of their days), by start. */
export function rehabPlanned(settings: Pick<Settings, "rehab">, date: ISODate): RehabProgram[] {
  return rehabPrograms(settings).filter((p) => rehabDay(p, date));
}

/** The block's week on `date` (1-based), or null when it isn't in force then. */
export function rehabWeek(p: Pick<RehabProgram, "start" | "weeks" | "end">, date: ISODate): number | null {
  return rehabInForce(p, date) ? Math.floor(daysBetween(p.start, date) / 7) + 1 : null;
}

/** Every day the block is planned, in order ("of 18 sessions"). */
export function rehabPlannedDates(p: RehabProgram): ISODate[] {
  const out: ISODate[] = [];
  for (let d = p.start, last = rehabLastDay(p); d <= last; d = addDays(d, 1)) if (p.days[weekdayOf(d)]) out.push(d);
  return out;
}

/** A session's rehab blocks — of the rehab block `id` only, when given. */
export function rehabBlocks(session: Pick<Session, "blocks">, id?: string): Block[] {
  return session.blocks.filter((b) => b.kind === "rehab" && (id === undefined || b.rehab === id));
}

/** Logged and total rehab sets of a session (of the rehab block `id`, when given), what is skipped left out. */
export function rehabCounts(session: Pick<Session, "blocks">, id?: string): SetCounts {
  return countsOf(rehabBlocks(session, id));
}

const hasLogged = (blocks: ReadonlyArray<Block>) => blocks.some((b) => b.exercises.some((e) => e.sets.some((s) => s.done)));

/** The sessions holding a logged set of the rehab block, by date ("4 of 18 sessions"). */
export function rehabSessions(p: Pick<RehabProgram, "id">, sessions: ReadonlyArray<Session>): Session[] {
  return sessions.filter((s) => hasLogged(rehabBlocks(s, p.id))).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Carrying forward (B.3)
// ---------------------------------------------------------------------------

/**
 * The session a rehab draft on `date` starts from: the earlier sessions holding rehab blocks of
 * `from` (default: the block itself). By its `carry` — "last": the most recent with a logged set
 * there, else the most recent; "weekday": the same weekday first (logged, then any), then as
 * "last". Null when there is none (a first session starts empty).
 */
export function rehabTemplateSource(
  date: ISODate,
  program: Pick<RehabProgram, "id" | "carry">,
  sessions: ReadonlyArray<Session>,
  from: string = program.id,
): Session | null {
  const prior = sessions
    .filter((s) => s.date < date && rehabBlocks(s, from).length > 0)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const logged = (s: Session) => hasLogged(rehabBlocks(s, from));
  const wd = weekdayOf(date);
  const sameDay = prior.filter((s) => weekdayOf(s.date) === wd);
  const order = program.carry === "weekday" ? [sameDay.find(logged), sameDay[0]] : [];
  return [...order, prior.find(logged), prior[0]].find((s) => s !== undefined) ?? null;
}

/**
 * A rehab draft for `date` (fresh ids, `kind: "rehab"`, `rehab: program.id`): the blocks of
 * `rehabTemplateSource`, exercises and supersets as they were, carried as accessories are — reps
 * as targets, loads as logged, none for an unweighted exercise, targets reset when the measure
 * changed, an archived or unknown exercise dropped, a skipped one from its last real (not
 * skipped) rehab performance. No deload scaling and no progression hint: rehab follows its
 * protocol, not the strength cycle. `opts.from` carries another rehab block's last session (a new
 * block "starting from Knee rehab's last session"). Empty when there is nothing to carry.
 */
export function rehabTemplate(
  date: ISODate,
  program: Pick<RehabProgram, "id" | "carry">,
  ctx: Pick<BuildContext, "sessions" | "exercises">,
  opts: { from?: string } = {},
): Block[] {
  const from = opts.from ?? program.id;
  const source = rehabTemplateSource(date, program, ctx.sessions, from);
  if (!source) return [];
  const out: Block[] = [];
  for (const b of rehabBlocks(source, from)) {
    const exercises = b.exercises.flatMap((e) => {
      const ex = ctx.exercises.find((x) => x.id === e.exerciseId && !x.archived);
      if (!ex) return [];
      const done = e.skipped
        ? (lastRehabPerformance(e.exerciseId, date, ctx.sessions, from) ?? lastRehabPerformance(e.exerciseId, date, ctx.sessions))
        : null;
      // A load factor of 1: never scaled (the rounding is then unused).
      return [carryOverExercise(done?.exercise ?? e, 1, 1, ex)];
    });
    if (exercises.length) out.push({ id: newId(), kind: "rehab", exercises, rehab: program.id });
  }
  return out;
}

/**
 * `session` with the live rehab draft (`rehabTemplate`) of every rehab block planned on its date
 * that it holds no blocks of yet, after its own blocks (as many as `MAX_BLOCKS` leaves room for).
 * The view of a day — saved or the strength plan's draft — before its first rehab edit saves it.
 * The same object when nothing is added (no rehab planned, already saved, nothing to carry).
 */
export function withRehabDraft(session: Session, ctx: Pick<BuildContext, "settings" | "sessions" | "exercises">): Session {
  const add: Block[] = [];
  for (const p of rehabPlanned(ctx.settings, session.date)) {
    if (rehabBlocks(session, p.id).length) continue;
    add.push(...rehabTemplate(session.date, p, ctx));
  }
  const room = Math.max(0, MAX_BLOCKS - session.blocks.length);
  return add.length && room ? { ...session, blocks: [...session.blocks, ...add.slice(0, room)] } : session;
}

// ---------------------------------------------------------------------------
// Editing (Program › Rehab)
// ---------------------------------------------------------------------------

/** The fields a rehab block is set up with. */
export type RehabFields = Pick<RehabProgram, "name" | "start" | "weeks" | "days" | "carry">;

/** An edit's result: the new settings and the block as it now is, or why it can't be made (a sentence). */
export type RehabEdit = { settings: Settings; program: RehabProgram } | { refused: string };

const nameOf = (p: Pick<RehabProgram, "name">) => p.name.trim() || "Rehab";

/** Why a block's fields are invalid, or null. */
function invalid(p: RehabFields & Pick<RehabProgram, "end">): string | null {
  if (!isISODate(p.start)) return "Pick the day it starts.";
  if (!Number.isInteger(p.weeks) || p.weeks < 1 || p.weeks > 52) return "A rehab block lasts 1 to 52 weeks.";
  if (p.days.length !== 7 || !p.days.some(Boolean)) return "Pick at least one day.";
  if (p.end !== undefined && p.end < p.start) return "It would end before it starts.";
  return null;
}

/** How many days two blocks are both in force (0: none; a block ended before its first day has none). */
function sharedDays(a: RehabProgram, b: RehabProgram): number {
  const from = a.start > b.start ? a.start : b.start;
  const aLast = rehabLastDay(a);
  const bLast = rehabLastDay(b);
  const to = aLast < bLast ? aLast : bLast;
  return to < from || aLast < a.start || bLast < b.start ? 0 : daysBetween(from, to) + 1;
}

/**
 * Why `p` can't sit beside the other blocks, or null. Overlap is refused for now — but only what
 * this edit creates or makes longer: `was` (the block before the edit) may already overlap another
 * (two devices each started one, then merged, SPEC §6.8), and an edit that doesn't add a shared
 * day with it (a rename, other weekdays, an earlier end) is let through.
 */
function overlap(p: RehabProgram, others: ReadonlyArray<RehabProgram>, was?: RehabProgram): string | null {
  for (const o of rehabPrograms({ rehab: { programs: [...others] } })) {
    if (o.id === p.id) continue;
    const shared = sharedDays(p, o);
    if (shared === 0 || (was && shared <= sharedDays(was, o))) continue;
    return o.start <= p.start
      ? `${nameOf(o)} runs until ${formatShortDate(rehabLastDay(o))}: end it or start this one after.`
      : `${nameOf(o)} starts ${formatShortDate(o.start)}: end this one before it.`;
  }
  return null;
}

/**
 * Why an edit of `was` into `p` would leave a logged session of it outside the block (a start
 * moved past it, a block shortened before it), or null: those sessions keep their place in it.
 */
function orphans(p: RehabProgram, was: RehabProgram, sessions: ReadonlyArray<Session>): string | null {
  for (const s of rehabSessions(was, sessions)) {
    if (!rehabInForce(was, s.date) || rehabInForce(p, s.date)) continue;
    return s.date < p.start
      ? `${nameOf(was)} has a session logged ${formatShortDate(s.date)}: start it on or before then.`
      : `${nameOf(was)} has a session logged ${formatShortDate(s.date)}: end it on or after then.`;
  }
  return null;
}

/** Settings with `programs` as the rehab blocks (by start). */
function withPrograms(settings: Settings, programs: ReadonlyArray<RehabProgram>): Settings {
  return { ...settings, rehab: { ...settings.rehab, programs: rehabPrograms({ rehab: { programs: [...programs] } }) } };
}

/** `p` checked against the others and written in place of the block of its id (or added). */
function put(settings: Settings, p: RehabProgram): RehabEdit {
  const why = invalid(p);
  if (why) return { refused: why };
  const programs = settings.rehab?.programs ?? [];
  const others = programs.filter((o) => o.id !== p.id);
  const clash = overlap(
    p,
    others,
    programs.find((o) => o.id === p.id),
  );
  if (clash) return { refused: clash };
  if (others.length >= MAX_REHAB_PROGRAMS) return { refused: "Settings hold up to 100 rehab blocks." };
  const at = programs.findIndex((o) => o.id === p.id);
  return { settings: withPrograms(settings, at === -1 ? [...programs, p] : programs.map((o, i) => (i === at ? p : o))), program: p };
}

/**
 * Where a new rehab block starts by default: the day after the block in force (or scheduled) on
 * or after `today` ends — the latest one's — or `today` when there is none.
 */
export function newRehabStart(settings: Pick<Settings, "rehab">, today: ISODate): ISODate {
  const last = rehabPrograms(settings)
    .map(rehabLastDay)
    .filter((d) => d >= today)
    .sort()
    .at(-1);
  return last ? addDays(last, 1) : today;
}

/** A new rehab block `id` with `fields`. Refused when the fields are invalid, it overlaps another, or the id is taken. */
export function startRehab(settings: Settings, fields: RehabFields, id: string): RehabEdit {
  if (rehabById(settings, id)) return { refused: "That rehab block already exists." };
  return put(settings, {
    id,
    name: fields.name.trim(),
    start: fields.start,
    weeks: fields.weeks,
    days: [...fields.days],
    carry: fields.carry,
  });
}

/**
 * The block `id` with `patch` applied (name, start, length, days, carry) — refused like
 * `startRehab`, and when it would leave a session logged in it (`sessions`) outside it.
 */
export function editRehab(settings: Settings, id: string, patch: Partial<RehabFields>, sessions: ReadonlyArray<Session>): RehabEdit {
  const p = rehabById(settings, id);
  if (!p) return { refused: "That rehab block is gone." };
  const next: RehabProgram = { ...p, ...patch };
  if (patch.name !== undefined) next.name = patch.name.trim();
  if (patch.days !== undefined) next.days = [...patch.days];
  const lost = invalid(next) ?? orphans(next, p, sessions);
  return lost ? { refused: lost } : put(settings, next);
}

/** `extendRehab`'s result: also the last day before (`was`) and after (`lastDay`), or why it can't. */
export type RehabExtend = { settings: Settings; program: RehabProgram; was: ISODate; lastDay: ISODate } | { refused: string };

/**
 * "+ A week": the block's last day `weeks` weeks later (`was` → `lastDay`, for the preview "ends it
 * Sun Dec 6 instead of Nov 29"). A block ended early stays ended early, a week later. Refused when
 * it would overlap the next block or pass 52 weeks.
 */
export function extendRehab(settings: Settings, id: string, weeks = 1): RehabExtend {
  const p = rehabById(settings, id);
  if (!p) return { refused: "That rehab block is gone." };
  const was = rehabLastDay(p);
  const lastDay = addDays(was, weeks * 7);
  const length = Math.max(p.weeks, Math.ceil((daysBetween(p.start, lastDay) + 1) / 7));
  if (length > 52) return { refused: "A rehab block lasts 1 to 52 weeks." };
  const { end: _end, ...rest } = p;
  const next: RehabProgram = { ...rest, weeks: length };
  if (lastDay < naturalEnd(next)) next.end = lastDay;
  const r = put(settings, next);
  return "refused" in r ? r : { ...r, was, lastDay };
}

/** `endRehab`'s result. */
export interface RehabEnded {
  settings: Settings;
  /** The block as it now is; null when it was removed. */
  program: RehabProgram | null;
  /** Its last day; null when it was removed. */
  lastDay: ISODate | null;
  /**
   * Today's session, when ending changes it: without its rehab blocks of the block (nothing of
   * them logged — a draft the first edit saved), to save; null to delete it (nothing else was left
   * in it). Absent: today's session stays as it is.
   */
  today?: Session | null;
}

/**
 * "End today": the block's last day is `today` when rehab of it is logged today (a set in today's
 * session), otherwise yesterday — so with nothing done, its section leaves Train at once, and
 * today's session loses its rehab blocks of it (`today`; unlogged, they are only the draft). A
 * block that would then have no day at all (it started today) is removed instead
 * (`lastDay: null`) — unless a session holds a logged set of it (`rehabSessions`): then it is
 * ended before its first day (`end` the day before `start`: in force on no day), so the sessions
 * still name a block that settings hold. Refused when it isn't in force today.
 */
export function endRehab(
  settings: Settings,
  id: string,
  today: ISODate,
  sessions: ReadonlyArray<Session>,
): RehabEnded | { refused: string } {
  const p = rehabById(settings, id);
  if (!p) return { refused: "That rehab block is gone." };
  if (p.start > today) return { refused: `${nameOf(p)} hasn't started yet: cancel it instead.` };
  if (!rehabInForce(p, today)) return { refused: `${nameOf(p)} ended ${formatShortDate(rehabLastDay(p))}.` };
  const saved = sessions.findLast((s) => s.date === today);
  const loggedToday = !!saved && hasLogged(rehabBlocks(saved, p.id));
  const last = loggedToday ? today : addDays(today, -1);
  let out: RehabEnded;
  if (last < p.start && !rehabSessions(p, sessions).length)
    out = {
      settings: withPrograms(
        settings,
        settings.rehab!.programs.filter((o) => o.id !== id),
      ),
      program: null,
      lastDay: null,
    };
  else {
    const program: RehabProgram = { ...p, end: last };
    out = {
      settings: withPrograms(
        settings,
        settings.rehab!.programs.map((o) => (o.id === id ? program : o)),
      ),
      program,
      lastDay: last,
    };
  }
  if (saved && !loggedToday && rehabBlocks(saved, p.id).length) {
    const blocks = saved.blocks.filter((b) => !(b.kind === "rehab" && b.rehab === p.id));
    const empty = !blocks.length && !saved.notes && !saved.completedAt && !saved.plannedFor;
    out.today = empty ? null : { ...saved, blocks };
  }
  return out;
}

/**
 * Remove a rehab block set up by mistake — only while no session holds a logged set of it (one
 * with logged sessions is ended, `endRehab`, so its history stays).
 */
export function cancelRehab(
  settings: Settings,
  id: string,
  sessions: ReadonlyArray<Session>,
): { settings: Settings } | { refused: string } {
  const p = rehabById(settings, id);
  if (!p) return { refused: "That rehab block is gone." };
  if (rehabSessions(p, sessions).length) return { refused: `${nameOf(p)} has logged sessions: end it instead.` };
  return {
    settings: withPrograms(
      settings,
      settings.rehab!.programs.filter((o) => o.id !== id),
    ),
  };
}
