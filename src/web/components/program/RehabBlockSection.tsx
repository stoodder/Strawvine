/**
 * Program › Rehab (SPEC §6.8, DESIGN A.9): rehab blocks — a protocol on its own timeline ("Knee
 * rehab · 6 weeks · Mon/Wed/Fri"), independent of the strength plans. Behind the `rehab` flag
 * (screens/Program.tsx mounts it).
 *
 * - The block in force: its name, where it is ("Week 2 of 6 · Oct 19 – Nov 29", sessions logged
 *   of planned), a week rail, its days, its length (−/+ and the day it ends; a − that can't go
 *   further says why), its start, what each session starts from (the last session / the same
 *   weekday), "+ A week" with what it would do, End today, and Cancel while nothing is logged
 *   under it. A block scheduled after it shows as one row ("Hip rehab · from Mon Nov 30 · 4 wks ·
 *   Tue/Thu ›") that opens into the same card on a tap (view state).
 * - Earlier blocks, read-only: name, dates, sessions logged.
 * - A new block, starting on the first day on or after today that no block holds (the day after
 *   the one in force ends; after End today, the free days before the next one), moved on to the
 *   first of its weekdays; with none at all, an empty state that sets up the first.
 *
 * Nothing here calculates or writes a block's fields: every read and edit goes through
 * src/shared/rehab.ts, and an edit it refuses (an overlap, no day left) says why. Every change
 * leaves an Undo (`settings/undo.ts`) that works on the settings as they are when it is tapped
 * and puts back only that block's own field — and declines, saying why, when that field was
 * changed again since or the rest of the settings no longer allow it. Consecutive changes of one
 * field fold into one toast. End today and Cancel work on the block as the settings hold it when
 * tapped, and can change today's session too (its unlogged rehab blocks of the block go,
 * `endRehab` / `cancelRehab`): that is saved through the session outbox, and their Undo puts back,
 * on today's session as it is then, only those blocks. End today on a block with nothing logged in
 * it at all removes it, as Cancel does (its Undo brings it back).
 *
 * Typing stays put: the lines an edit changes keep their height (the status is two lines that
 * never wrap into a third at 320 px, the two one-line carry hints share one box), and what an
 * action adds or removes is below the control that was tapped.
 */
import clsx from "clsx";
import { useId, useRef, useState, type ReactNode } from "react";
import { ChevronRight, Plus } from "lucide-react";
import {
  addDays,
  daysBetween,
  formatShortDate,
  isISODate,
  weekdayName,
  weekdayOf,
  WEEKDAY_SHORT,
  type ISODate,
} from "../../../shared/dates";
import {
  cancelRehab,
  editRehab,
  endRehab,
  extendRehab,
  rehabById,
  rehabInForce,
  rehabLastDay,
  rehabPlannedDates,
  rehabPrograms,
  rehabSessions,
  rehabWeek,
  restoreRehabSpan,
  startRehab,
  type RehabEdit,
  type RehabFields,
} from "../../../shared/rehab";
import type { Block, RehabProgram, Session, Settings } from "../../../shared/schemas";
import { newId } from "../../../shared/session";
import { MAX_BLOCKS } from "../../../shared/sessionStructure";
import { useDeleteSession, useSaveSession } from "../../lib/store";
import { currentData } from "../../lib/sync";
import { InlineText } from "../InlineText";
import { WEEK_ORDER } from "../settings/fields";
import type { SettingsUndo } from "../settings/undo";
import type { useSettingsEditor } from "../settings/useSettingsEditor";
import { useToast } from "../Toast";
import { useFocusAfter } from "../useFocusAfter";
import { Section, Stepper } from "../ui";

type UndoableSettings = ReturnType<typeof useSettingsEditor>["undoableSettings"];
type Carry = RehabProgram["carry"];
type Focus = () => HTMLElement | null;

const dayName = (date: ISODate) => `${weekdayName(date, true)} ${formatShortDate(date)}`;
const nameOf = (p: Pick<RehabProgram, "name">) => p.name.trim() || "Rehab";
const sessionsText = (n: number) => (n === 1 ? "1 session" : `${n} sessions`);
/** "Oct 19 – Nov 29"; a date of another year than `today` says its year. */
const datesText = (from: ISODate, to: ISODate, today: ISODate) =>
  `${formatShortDate(from, from.slice(0, 4) !== today.slice(0, 4))} – ${formatShortDate(to, to.slice(0, 4) !== today.slice(0, 4))}`;
/** The weeks a block spans, from its start to its last day ("of 6"). */
const spanWeeks = (p: RehabProgram) => Math.ceil((daysBetween(p.start, rehabLastDay(p)) + 1) / 7);
const daysKey = (days: ReadonlyArray<boolean>) => days.map((d) => (d ? 1 : 0)).join("");
const daysList = (days: ReadonlyArray<boolean>) =>
  WEEK_ORDER.filter((d) => days[d])
    .map((d) => WEEKDAY_SHORT[d])
    .join(", ");

/** A block's length as stored: its weeks and, when it was ended early, its last day. */
interface Span {
  weeks: number;
  end: ISODate | undefined;
}
const spanOf = (p: RehabProgram): Span => ({ weeks: p.weeks, end: p.end });
/** A span as one comparable value (an Undo checks it is still what the change left). */
const spanKey = (s: Span) => `${s.weeks}:${s.end ?? ""}`;
const parseSpan = (key: string): Span => {
  const [weeks, end] = key.split(":");
  return { weeks: Number(weeks), end: end || undefined };
};

/** The sessions as they are now (an Undo runs from a toast, maybe after the screen is gone). */
const liveSessions = (fallback: ReadonlyArray<Session>): ReadonlyArray<Session> => currentData()?.sessions ?? fallback;

/**
 * The block `id` with its stored length set (`weeks`, and `end` — absent: not ended early): the
 * stepper's −, and every Undo of a length change, "+ A week" or End today — `restoreRehabSpan`,
 * checked like any edit (overlap, 1–52 weeks, a logged session left outside it).
 */
function setSpan(settings: Settings, id: string, span: Span, sessions: ReadonlyArray<Session>): RehabEdit {
  return restoreRehabSpan(settings, id, span, liveSessions(sessions));
}

/** The block's set-up fields (a cancelled block's Undo starts it again with them). */
const fieldsOf = (p: RehabProgram): RehabFields => ({ name: p.name, start: p.start, weeks: p.weeks, days: [...p.days], carry: p.carry });

/**
 * A block put back as it was, after it was removed (an Undo of Cancel, or of End today on a block
 * with nothing logged): started for its first week, then given its span — so an early end it had
 * counts when checking it against the blocks set up since. Refused (why) when it is back already,
 * or another block has its days now.
 */
function restoreBlock(now: Settings, p: RehabProgram, sessions: ReadonlyArray<Session>): Settings | { refused: string } {
  if (rehabById(now, p.id)) return { refused: `${nameOf(p)} was changed again since.` };
  const back = startRehab(now, { ...fieldsOf(p), weeks: 1 }, p.id);
  if ("refused" in back) return back;
  const span = setSpan(back.settings, p.id, spanOf(p), sessions);
  return "refused" in span ? span : span.settings;
}

/**
 * The first day on or after `from` that no rehab block holds: `from` itself, else the day after the
 * block in force then ends, and so on past any that follows on at once — so after End today, the
 * free days before the next block (where a new one can go), not the day after the last.
 */
function firstFreeDay(settings: Pick<Settings, "rehab">, from: ISODate): ISODate {
  const all = rehabPrograms(settings);
  let d = from;
  for (let i = 0; i <= all.length; i++) {
    const holding = all.filter((p) => rehabInForce(p, d));
    if (!holding.length) return d;
    d = addDays(holding.map(rehabLastDay).sort().at(-1)!, 1);
  }
  return d;
}

/** The first of `days` (by weekday) on or after `from`; `from` when none is set. */
function firstWeekdayFrom(from: ISODate, days: ReadonlyArray<boolean>): ISODate {
  if (!days.some(Boolean)) return from;
  let d = from;
  while (!days[weekdayOf(d)]) d = addDays(d, 1);
  return d;
}

/** "Mon/Wed/Fri". */
const daysSlashed = (days: ReadonlyArray<boolean>) =>
  WEEK_ORDER.filter((d) => days[d])
    .map((d) => WEEKDAY_SHORT[d])
    .join("/");

/**
 * End today's Undo for today's session: the session as it is now with the rehab blocks End today
 * dropped from it put back where they were — only those, and only the ones it doesn't hold again
 * (as many as `MAX_BLOCKS` leaves room for). With no session that day any more (End today deleted
 * it, nothing else was in it), one holding only them. Null: nothing to put back.
 */
function withDroppedBack(now: Session | null, ended: Session, dropped: ReadonlyArray<{ at: number; block: Block }>): Session | null {
  const base = now ?? { ...ended, blocks: [] };
  const blocks = [...base.blocks];
  let added = 0;
  for (const { at, block } of dropped) {
    if (blocks.length >= MAX_BLOCKS || blocks.some((b) => b.id === block.id)) continue;
    blocks.splice(Math.min(at, blocks.length), 0, block);
    added++;
  }
  return added ? { ...base, blocks } : null;
}

/** Why an Undo can't be: what it would undo isn't there any more. */
const changedSince = (name: string) => ({ refused: `${name} was changed again since.` });

/**
 * An Undo whose `undo` says why it can't be (`{ refused }`): the toast then says "Can't undo:"
 * and that reason — the real one (an overlap, a logged session), not a guess. (`cantUndo` is read
 * when the Undo is declined, right after `undo` ran: a getter hands it the reason.)
 */
function undoSaying<T>(
  name: string,
  u: Omit<SettingsUndo<T>, "undo" | "cantUndo"> & { undo: (now: Settings, from: T) => Settings | { refused: string } },
): SettingsUndo<T> {
  let why = changedSince(name).refused;
  return {
    ...u,
    undo: (now, from) => {
      const r = u.undo(now, from);
      if ("refused" in r) {
        why = r.refused;
        return null;
      }
      return r;
    },
    get cantUndo() {
      return `Can't undo: ${why}`;
    },
  };
}

/** The block `id`'s card (`data-rehab-block`), as a selector. */
const blockSel = (id: string) => `[data-rehab-block="${id.replace(/["\\]/g, "\\$&")}"]`;
/** Where focus goes after an Undo of the block `id`: what `selector` matches in its card. */
const inBlock =
  (id: string, selector: string): Focus =>
  () =>
    document.querySelector<HTMLElement>(`${blockSel(id)} ${selector}`);

/** Each choice with its one-line hint (one line at 320 px: the two share a box, so a choice never moves what's under it). */
const CARRY: Array<[Carry, string, string]> = [
  ["last", "The last session", "Wednesday starts from Monday’s session."],
  ["weekday", "The same weekday", "Monday starts from last Monday’s session."],
];

// ---------------------------------------------------------------------------
// Small parts
// ---------------------------------------------------------------------------

/** A heading inside the section ("Earlier rehab blocks"), in the section heading's voice. */
function SubHead({ children }: { children: ReactNode }) {
  return (
    <div className="mt-10 mb-2 flex items-center gap-3">
      <h3 className="label shrink-0">{children}</h3>
      <div className="rule min-w-4 flex-1" />
    </div>
  );
}

/**
 * A label on the left, its control on the right: the control drops under it when both don't fit
 * (zoomed in) — or, with `shrink`, the control narrows instead (the weekday pills).
 */
function Row({
  label,
  hint,
  children,
  labelId,
  shrink = false,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  labelId?: string;
  shrink?: boolean;
}) {
  return (
    <div className={clsx("flex items-center justify-between gap-x-3 gap-y-2 py-2", !shrink && "flex-wrap")}>
      <div className="min-w-0 shrink-0">
        <div id={labelId} className="text-[0.9375rem] text-fg">
          {label}
        </div>
        {hint && <div className="mt-0.5 text-xs whitespace-nowrap text-mute">{hint}</div>}
      </div>
      <div className={clsx("ml-auto max-w-full", shrink && "flex min-w-0 flex-1 justify-end")}>{children}</div>
    </div>
  );
}

/** The weekday pills (Monday first, as Targets & days): seven 44px-tall targets that shrink, never overlap. */
function WeekdayPills({ label, value, onChange }: { label: string; value: ReadonlyArray<boolean>; onChange: (days: boolean[]) => void }) {
  return (
    <div role="group" aria-label={label} data-rehab-days="" className="grid w-[16.5rem] max-w-full grid-cols-7">
      {WEEK_ORDER.map((d) => (
        <button
          key={d}
          type="button"
          aria-pressed={!!value[d]}
          aria-label={WEEKDAY_SHORT[d]}
          onClick={() => onChange(value.map((x, i) => (i === d ? !x : x)))}
          className="tap grid h-11 place-items-center"
        >
          <span
            className={clsx(
              "grid aspect-square w-full max-w-8 place-items-center rounded-full font-mono text-[0.6875rem]",
              value[d] ? "bg-accent text-accent-ink" : "bg-white/[0.05] text-fg-2",
            )}
          >
            {WEEKDAY_SHORT[d]![0]}
          </span>
        </button>
      ))}
    </div>
  );
}

/** − 6 weeks + : a length in weeks. */
function WeeksStepper({ weeks, min, label, onChange }: { weeks: number; min: number; label: string; onChange: (weeks: number) => void }) {
  return (
    <Stepper
      value={weeks}
      min={min}
      max={52}
      label={label}
      format={(v) => (
        <>
          {v} <span className="text-sm text-fg-2">{v === 1 ? "week" : "weeks"}</span>
        </>
      )}
      onChange={(v) => v !== weeks && onChange(v)}
    />
  );
}

/** "The last session / The same weekday", and a one-line hint of what the choice means (both share one box: a tap never moves what's below). */
function CarryChoice({ label, value, onChange }: { label: string; value: Carry; onChange: (v: Carry) => void }) {
  const noteId = useId();
  return (
    <div className="pt-3">
      <div className="text-[0.9375rem] text-fg">Each session starts from</div>
      <div role="group" aria-label={label} aria-describedby={noteId} className="mt-2.5 flex rounded-full bg-white/[0.04] p-1">
        {CARRY.map(([v, text]) => (
          <button
            key={v}
            type="button"
            aria-pressed={value === v}
            data-carry={v}
            onClick={() => value !== v && onChange(v)}
            className={clsx(
              // One line each at 320 px.
              "tap min-h-11 flex-1 rounded-full px-1.5 text-[0.8125rem] min-[24rem]:text-sm",
              value === v ? "bg-white/[0.08] text-fg" : "text-fg-2",
            )}
          >
            {text}
          </button>
        ))}
      </div>
      <p id={noteId} className="mt-2 grid text-xs text-mute">
        {CARRY.map(([v, , note]) => (
          <span key={v} className={clsx("[grid-area:1/1]", value !== v && "invisible")} aria-hidden={value !== v || undefined}>
            {note}
          </span>
        ))}
      </p>
    </div>
  );
}

/** The block's weeks as segments: the weeks gone lit, this one filling, a tick at today. The status line says it in words. */
function WeekRail({ p, today }: { p: RehabProgram; today: ISODate }) {
  const weeks = spanWeeks(p);
  const days = daysBetween(p.start, rehabLastDay(p)) + 1;
  const elapsed = Math.min(days, Math.max(0, daysBetween(p.start, today)));
  const current = rehabWeek(p, today);
  // Every week's name while they fit; past eight, the first, this one and the last.
  const named = (i: number) => weeks <= 8 || i === 0 || i === weeks - 1 || i + 1 === current;
  return (
    <div aria-hidden className="mt-3" data-rehab-rail="">
      <div className="relative flex h-1 gap-0.5">
        {Array.from({ length: weeks }, (_, i) => {
          const from = i * 7;
          const fill = Math.min(1, Math.max(0, (elapsed - from) / Math.min(7, days - from)));
          return (
            <span key={i} className="relative h-1 flex-1 overflow-hidden rounded-sm bg-[var(--track)]">
              {fill > 0 && <span className="glow-line absolute inset-y-0 left-0 rounded-sm" style={{ width: `${fill * 100}%` }} />}
            </span>
          );
        })}
        {current !== null && (
          <span
            className="absolute -top-1.5 h-4 w-0.5 rounded-sm bg-fg"
            style={{ left: `clamp(0px, calc(${(elapsed / days) * 100}% - 1px), calc(100% - 2px))` }}
          />
        )}
      </div>
      <div className="mt-2.5 flex gap-0.5">
        {Array.from({ length: weeks }, (_, i) => (
          <span
            key={i}
            className={clsx("text-2xs min-w-0 flex-1 font-mono whitespace-nowrap", i + 1 === current ? "text-fg-2" : "text-mute")}
          >
            {named(i) ? `W${i + 1}` : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A block in force or scheduled
// ---------------------------------------------------------------------------

/** What a − that can't shorten a block in force any further says. */
const EARLIEST_END = "Ends this week at the earliest — End today stops it now.";
/** "+ A week" refused: "Can't add a week: Hip rehab starts Nov 30." */
const cantExtend = (why: string) => `Can't add a week: ${why}`;

/** An edit through rehab.ts: the new settings, or why it can't be made. */
type Edit = (now: Settings) => { settings: Settings } | { refused: string };

interface BlockContext {
  /**
   * An edit with an Undo toast, worked out on the settings as they are now; a refusal is said in a
   * warning toast and saves nothing. False when nothing was saved.
   */
  run: <T>(edit: Edit, undo: SettingsUndo<T>) => boolean;
  today: ISODate;
  sessions: ReadonlyArray<Session>;
  settings: Settings;
  /** Focus after the block left the list (ended, cancelled): the section's own action. */
  focusAway: () => void;
}

function BlockCard({ p, ctx, heading }: { p: RehabProgram; ctx: BlockContext; heading?: string }) {
  const { run, today, sessions, settings, focusAway } = ctx;
  const toast = useToast();
  const saveSession = useSaveSession();
  const deleteSession = useDeleteSession();
  const name = nameOf(p);
  const id = p.id;
  const last = rehabLastDay(p);
  const weeks = spanWeeks(p);
  const week = rehabWeek(p, today);
  const started = p.start <= today;
  const planned = rehabPlannedDates(p).length;
  const logged = rehabSessions(p, sessions).length;
  const extend = extendRehab(settings, id, 1);
  const previewId = useId();
  const startId = useId();
  const dateField = useRef<HTMLInputElement>(null);

  /**
   * One field of this block set to `after`, with its Undo: back to `from` (the first `before` of
   * the folded changes) only while the field still reads `after` — and only if rehab.ts lets it
   * (else the toast says why).
   */
  const editField = <T,>(
    key: string,
    read: (q: RehabProgram) => T,
    before: T,
    after: T,
    set: (now: Settings, to: T) => RehabEdit,
    message: string | ((from: T) => string),
    focus: Focus,
  ) =>
    run<T>(
      (now) => set(now, after),
      undoSaying(name, {
        fold: { key: `rehab-${key}-${id}`, before, after },
        message,
        undo: (now, from) => {
          const q = rehabById(now, id);
          if (!q || read(q) !== after) return changedSince(name);
          const r = set(now, from);
          return "refused" in r ? r : r.settings;
        },
        focus,
      }),
    );

  /** The length set to `to` (one toast for the stepper and "+ A week", however many taps). */
  const setLength = (to: Span, focus: Focus) =>
    editField<string>(
      "length",
      (q) => spanKey(spanOf(q)),
      spanKey(spanOf(p)),
      spanKey(to),
      (now, key) => setSpan(now, id, parseSpan(key), sessions),
      `${name} ends ${dayName(rehabLastDay({ ...p, ...to }))}`,
      focus,
    );
  /** "+ A week" (and the stepper's +): what `extendRehab` makes of it, saved as a length change. */
  const addWeek = (focus: Focus) => {
    if ("refused" in extend) return run(() => ({ refused: cantExtend(extend.refused) }), { message: "", undo: () => null });
    return setLength(spanOf(extend.program), focus);
  };
  // The − never ends it before this week is out: ending it is End today — which a − tapped there says.
  const minWeeks = Math.max(1, week ?? 1);
  const shorter = (to: number) => {
    if (to < minWeeks) {
      toast.show({ message: EARLIEST_END });
      return;
    }
    const natural = addDays(p.start, to * 7 - 1);
    setLength(
      { weeks: to, end: p.end !== undefined && p.end < natural ? p.end : undefined },
      inBlock(id, `[data-rehab-length] button[aria-label^="Decrease"]`),
    );
  };

  /**
   * A change of the block that can change today's session too (End today, Cancel): worked out on
   * the block and the sessions as they are when tapped (`edit` gets the block as settings hold it
   * then); today's session as `edit` says (`today`: what to save, null to delete it) is saved
   * through the session outbox like any session edit. Its Undo puts back the block (`undo`, given
   * the block as it was) and — only once that can be — on today's session as it is then, only the
   * blocks it dropped. Declined, it says why.
   */
  const changeWithToday = <R extends { settings: Settings; today?: Session | null }>(
    edit: (now: Settings, before: RehabProgram, all: ReadonlyArray<Session>) => R | { refused: string },
    u: {
      message: (r: R) => string;
      undo: (now: Settings, before: RehabProgram, r: R) => Settings | { refused: string };
      focus: Focus;
    },
  ): R | null => {
    const date = today;
    const done: {
      r: R | null;
      before: RehabProgram | null;
      /** Today's session when the change touches it: as it was, what to save (null: delete it), the blocks it dropped and where they were. */
      session: { was: Session; next: Session | null; dropped: Array<{ at: number; block: Block }> } | null;
    } = { r: null, before: null, session: null };
    const saved = run<undefined>(
      (now) => {
        const before = rehabById(now, id);
        if (!before) return { refused: "That rehab block is gone." };
        const all = liveSessions(sessions);
        const r = edit(now, before, all);
        if ("refused" in r) return r;
        done.r = r;
        done.before = before;
        const was = all.findLast((x) => x.date === date);
        if (r.today !== undefined && was) {
          const kept = new Set((r.today?.blocks ?? []).map((b) => b.id));
          const dropped = was.blocks.flatMap((block, at) => (kept.has(block.id) ? [] : [{ at, block }]));
          done.session = { was, next: r.today, dropped };
        }
        return r;
      },
      undoSaying(name, {
        message: () => u.message(done.r!),
        undo: (now) => {
          const back = u.undo(now, done.before!, done.r!);
          const x = done.session;
          if (!("refused" in back) && x) {
            const restored = withDroppedBack(liveSessions(sessions).findLast((y) => y.date === date) ?? null, x.was, x.dropped);
            if (restored) saveSession(restored);
          }
          return back;
        },
        focus: u.focus,
      }),
    );
    if (!saved) return null;
    if (done.session) {
      if (done.session.next) saveSession(done.session.next);
      else deleteSession(date);
    }
    return done.r;
  };

  /**
   * End today: its last day is today with rehab of it logged today, else yesterday; today's
   * session loses its unlogged rehab blocks of it (`endRehab`). A block with nothing logged in it at
   * all is removed instead, as Cancel does (no block of no sessions is left in the history). Its
   * Undo puts back the block as it was when tapped.
   */
  const endToday = () => {
    const r = changeWithToday<{ settings: Settings; today?: Session | null; lastDay: ISODate | null }>(
      (now, before, all) => {
        if (rehabSessions(before, all).length) return endRehab(now, id, today, all);
        const c = cancelRehab(now, id, all, today);
        return "refused" in c ? c : { ...c, lastDay: null };
      },
      {
        message: (r) =>
          r.lastDay === null
            ? `${name} removed: nothing was logged in it`
            : r.lastDay === today
              ? `${name} ends today`
              : `${name} ended: its last day was yesterday`,
        undo: (now, before, r) => {
          const q = rehabById(now, id);
          if (!q) return r.lastDay === null ? restoreBlock(now, before, sessions) : changedSince(name);
          if (r.lastDay === null || q.end !== r.lastDay) return changedSince(name);
          const back = setSpan(now, id, spanOf(before), sessions);
          return "refused" in back ? back : back.settings;
        },
        focus: inBlock(id, `[data-rehab-control="end"]`),
      },
    );
    // Ended before today (or removed): its card goes.
    if (r && r.lastDay !== today) focusAway();
  };

  /** Cancel (nothing logged in it): the block goes, and its draft in today's session with it (`cancelRehab`). */
  const cancel = () => {
    const r = changeWithToday((now, _before, all) => cancelRehab(now, id, all, today), {
      message: () => `${name} cancelled`,
      undo: (now, before) => restoreBlock(now, before, sessions),
      focus: inBlock(id, `[data-rehab-control="cancel"]`),
    });
    if (r) focusAway();
  };

  return (
    <div data-rehab-block={id} tabIndex={-1} className="outline-none">
      {heading && <SubHead>{heading}</SubHead>}
      <InlineText
        ariaLabel="Rehab block name"
        value={p.name}
        maxLength={60}
        required
        requiredMessage="Name the rehab block."
        onCommit={(to) =>
          editField<string>(
            "name",
            (q) => q.name,
            p.name,
            to,
            (now, v) => editRehab(now, id, { name: v }, liveSessions(sessions)),
            (from) => `Renamed ${from.trim() || "Rehab"} to ${to}`,
            inBlock(id, `input[aria-label="Rehab block name"]`),
          )
        }
        className="w-full"
        inputClassName="text-2xl font-light tracking-tight"
      />
      {/* Two lines, each short enough never to wrap at 320 px: an edit never moves the controls under them. */}
      <div className="mt-2 text-sm text-mute" data-rehab-status="">
        <p>
          <span className="text-fg-2">
            {week !== null ? `Week ${week} of ${weeks}` : `Starts ${daysBetween(today, p.start) === 1 ? "tomorrow" : dayName(p.start)}`}
          </span>{" "}
          · {datesText(p.start, last, today)}
        </p>
        <p>{started ? `${logged} of ${planned} sessions logged` : `${sessionsText(planned)} planned`}</p>
      </div>
      <WeekRail p={p} today={today} />

      <div className="mt-4">
        <Row label="Days" shrink>
          <WeekdayPills
            label={`${name} days`}
            value={p.days}
            onChange={(days) =>
              editField<string>(
                "days",
                (q) => daysKey(q.days),
                daysKey(p.days),
                daysKey(days),
                (now, key) => editRehab(now, id, { days: [...key].map((c) => c === "1") }, liveSessions(sessions)),
                `${name} days: ${daysList(days) || "none"}`,
                inBlock(id, "[data-rehab-days] button"),
              )
            }
          />
        </Row>
        <Row label="Length" hint={`Ends ${formatShortDate(last)}`}>
          <div data-rehab-length="">
            <WeeksStepper
              weeks={weeks}
              // Not `minWeeks`: once started, a − there still answers, saying why it can't (`shorter`).
              min={started ? 0 : 1}
              label={`${name} length`}
              onChange={(to) => (to > weeks ? addWeek(inBlock(id, `[data-rehab-length] button[aria-label^="Increase"]`)) : shorter(to))}
            />
          </div>
        </Row>
        <Row label={started ? "Started" : "Starts"} labelId={startId}>
          <input
            ref={dateField}
            type="date"
            aria-labelledby={startId}
            value={p.start}
            onChange={(e) => {
              const to = e.target.value;
              if (!isISODate(to) || to === p.start) return;
              // A start that would put it all in the past would take the card from under the finger.
              if (started && rehabLastDay({ ...p, start: to }) < today) {
                toast.show({ message: `That would end ${name} before today: End today ends it.`, tone: "warn" });
                return;
              }
              editField<ISODate>(
                "start",
                (q) => q.start,
                p.start,
                to,
                (now, v) => editRehab(now, id, { start: v }, liveSessions(sessions)),
                `${name} starts ${dayName(to)}`,
                () => dateField.current,
              );
            }}
            className="field num box-field rounded-xl bg-white/[0.05] px-3 py-2 text-base [color-scheme:dark]"
          />
        </Row>
        <CarryChoice
          label={`${name}: each session starts from`}
          value={p.carry}
          onChange={(carry) =>
            editField<Carry>(
              "carry",
              (q) => q.carry,
              p.carry,
              carry,
              (now, v) => editRehab(now, id, { carry: v }, liveSessions(sessions)),
              `${name}: each session starts from ${carry === "last" ? "the last session" : "the same weekday"}`,
              inBlock(id, `[data-carry][aria-pressed="true"]`),
            )
          }
        />
      </div>

      <div className="mt-6 flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-ghost"
          data-rehab-control="extend"
          aria-describedby={previewId}
          disabled={"refused" in extend}
          onClick={() => addWeek(inBlock(id, `[data-rehab-control="extend"]`))}
        >
          <Plus size={14} aria-hidden /> A week
        </button>
        {started && p.end !== today && (
          <button type="button" className="btn-ghost" data-rehab-control="end" onClick={endToday}>
            End today
          </button>
        )}
        {logged === 0 && (
          <button type="button" className="btn-ghost" data-rehab-control="cancel" onClick={cancel}>
            Cancel it
          </button>
        )}
      </div>
      <p id={previewId} className="mt-2 text-xs text-mute" data-rehab-preview="">
        {"refused" in extend
          ? cantExtend(extend.refused)
          : `“+ A week” ends it ${dayName(extend.lastDay)} instead of ${formatShortDate(extend.was)}.`}
      </p>
    </div>
  );
}

/**
 * A block scheduled after the one in force, folded to one row — "Hip rehab · from Mon Nov 30 ·
 * 4 wks · Tue/Thu ›" — that opens into its card on a tap (view state: nothing folds by itself).
 */
function NextBlockRow({ p, onOpen }: { p: RehabProgram; onOpen: () => void }) {
  const weeks = spanWeeks(p);
  return (
    <div data-rehab-block={p.id} data-rehab-folded="">
      <SubHead>Next rehab block</SubHead>
      <button type="button" aria-expanded={false} onClick={onOpen} className="tap flex min-h-11 w-full items-center gap-3 py-2 text-left">
        <span className="min-w-0 flex-1 text-[0.9375rem] text-fg">
          {nameOf(p)}
          {/* Each part keeps together: a narrow phone breaks the line between them, never inside one. */}
          {[`from ${dayName(p.start)}`, `${weeks} ${weeks === 1 ? "wk" : "wks"}`, daysSlashed(p.days)].map((part) => (
            <span key={part} className="text-mute">
              {" "}
              · <span className="whitespace-nowrap">{part}</span>
            </span>
          ))}
        </span>
        <ChevronRight size={14} className="shrink-0 text-mute" aria-hidden />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A new block
// ---------------------------------------------------------------------------

/** What a first block is set up with until changed (the latest block's, when there is one). */
const FIRST_DAYS = [false, true, false, true, false, true, false];
const FIRST_WEEKS = 6;

/**
 * Setting up a rehab block: nothing is saved until "Start it". Until a start is picked, it starts on
 * the first of its days on or after `from` — and follows the days as they are changed.
 */
function NewBlockForm({
  from,
  like,
  heading,
  onStart,
  onClose,
}: {
  /** The first day it can start (`firstFreeDay`). */
  from: ISODate;
  /** The latest block: a new one starts with its days, length and carry. */
  like: RehabProgram | null;
  /** Its own heading, under others' blocks (with none, the section's heading says it all). */
  heading: boolean;
  /** Saves it; why it can't be, or null. */
  onStart: (fields: RehabFields) => string | null;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [days, setDays] = useState<boolean[]>(like ? [...like.days] : FIRST_DAYS);
  const [weeks, setWeeks] = useState(like?.weeks ?? FIRST_WEEKS);
  const [picked, setStart] = useState<ISODate | null>(null);
  const start = picked ?? firstWeekdayFrom(from, days);
  const [carry, setCarry] = useState<Carry>(like?.carry ?? "last");
  const [refused, setRefused] = useState<string | null>(null);
  const nameId = useId();
  const startId = useId();
  const errorId = useId();
  return (
    <div data-rehab-new="">
      {heading && <SubHead>New rehab block</SubHead>}
      <div className="py-2">
        <label htmlFor={nameId} className="text-[0.9375rem] text-fg">
          Name
        </label>
        <input
          id={nameId}
          value={name}
          maxLength={60}
          placeholder="Knee rehab"
          autoComplete="off"
          enterKeyHint="done"
          onChange={(e) => setName(e.target.value)}
          className="field mt-1 w-full py-2 text-base placeholder:text-faint"
        />
      </div>
      <Row label="Days" shrink>
        <WeekdayPills label="New rehab block days" value={days} onChange={setDays} />
      </Row>
      <Row label="Length" hint={`Ends ${formatShortDate(addDays(start, weeks * 7 - 1))}`}>
        <WeeksStepper weeks={weeks} min={1} label="New rehab block length" onChange={setWeeks} />
      </Row>
      <Row label="Starts" labelId={startId}>
        <input
          type="date"
          aria-labelledby={startId}
          value={start}
          onChange={(e) => isISODate(e.target.value) && setStart(e.target.value)}
          className="field num box-field rounded-xl bg-white/[0.05] px-3 py-2 text-base [color-scheme:dark]"
        />
      </Row>
      <CarryChoice label="New rehab block: each session starts from" value={carry} onChange={setCarry} />
      <div className="mt-6 flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-primary"
          aria-describedby={refused ? errorId : undefined}
          onClick={() => setRefused(name.trim() ? onStart({ name, start, weeks, days, carry }) : "Name the rehab block.")}
        >
          Start it
        </button>
        <button type="button" className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
      {/* Under the buttons, after a tap: it never moves a field being typed in. */}
      {refused && (
        <p id={errorId} role="alert" className="mt-2 text-sm text-warn">
          {refused}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

export function RehabBlockSection({
  id,
  settings,
  sessions,
  today,
  undoableSettings,
}: {
  id?: string;
  settings: Settings;
  sessions: ReadonlyArray<Session>;
  today: ISODate;
  undoableSettings: UndoableSettings;
}) {
  const toast = useToast();
  const focusAfter = useFocusAfter();
  const [adding, setAdding] = useState(false);
  const newButton = useRef<HTMLButtonElement>(null);
  const lineId = useId();
  const all = rehabPrograms(settings);
  // In force today, then any scheduled after it; the rest is history, newest first.
  const ahead = all.filter((p) => rehabLastDay(p) >= today);
  const earlier = all.filter((p) => rehabLastDay(p) < today).reverse();
  const inForce = ahead.find((p) => rehabInForce(p, today)) ?? null;
  const latest = all.at(-1) ?? null;
  // A new block: from the first day no block holds, on the first of its days.
  const freeFrom = firstFreeDay(settings, today);
  const newStart = firstWeekdayFrom(freeFrom, latest?.days ?? FIRST_DAYS);
  const follows = ahead.find((p) => addDays(rehabLastDay(p), 1) === freeFrom) ?? null;
  // Rehab of the block in force logged today: End today would make today its last day, so the next could start tomorrow.
  const loggedToday = !!inForce && rehabSessions(inForce, sessions).some((x) => x.date === today);
  const any = all.length > 0;
  // Blocks scheduled after the one in force show as one row until opened (view state).
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const open = (blockId: string) => setOpened((o) => new Set([...o, blockId]));

  const run: BlockContext["run"] = (edit, u) => {
    let refused: string | null = null;
    const saved = undoableSettings((now) => {
      const r = edit(now);
      if ("refused" in r) {
        refused = r.refused;
        return null;
      }
      return r.settings;
    }, u);
    if (!saved && refused) toast.show({ message: refused, tone: "warn" });
    return saved;
  };
  const ctx: BlockContext = { run, today, sessions, settings, focusAway: () => focusAfter(() => newButton.current) };

  const startNew = (fields: RehabFields): string | null => {
    const blockId = newId();
    const set = { ...fields, name: fields.name.trim() };
    let refused: string | null = null;
    const saved = undoableSettings(
      (now) => {
        const r = startRehab(now, set, blockId);
        if ("refused" in r) {
          refused = r.refused;
          return null;
        }
        return r.settings;
      },
      {
        message: `${set.name} set up from ${dayName(set.start)}`,
        // Only while it is still exactly as it was set up, with nothing logged under it.
        undo: (now) => {
          const p = rehabById(now, blockId);
          if (!p || p.end !== undefined || JSON.stringify(fieldsOf(p)) !== JSON.stringify(set)) return null;
          const r = cancelRehab(now, blockId, liveSessions(sessions));
          return "refused" in r ? null : r.settings;
        },
        cantUndo: `Can't undo: ${set.name} was changed or logged since.`,
        focus: () => newButton.current,
      },
    );
    if (!saved) return refused ?? "Couldn't set it up.";
    setAdding(false);
    open(blockId);
    focusAfter(() => document.querySelector<HTMLElement>(blockSel(blockId)));
    return null;
  };

  const newLine = follows
    ? `Starts ${dayName(newStart)}, ${newStart === freeFrom ? "the day after" : "after"} ${nameOf(follows)} ends${
        inForce?.id === follows.id ? ` — or ${loggedToday ? "tomorrow, if you end it today" : "today, if you end it first"}` : ""
      }.`
    : `Starts ${newStart === today ? "today" : dayName(newStart)}.`;

  return (
    <Section label="Rehab" id={id}>
      <div data-rehab-section="">
        {ahead.length === 0 && !adding && (
          <div data-rehab-empty="">
            <p className="text-2xl leading-tight font-light tracking-tight">{any ? "No rehab block now" : "No rehab block yet"}</p>
            <p className="mt-1.5 text-sm text-mute">
              A rehab block is a protocol on its own timeline — say knee rehab on Monday, Wednesday and Friday for six weeks. Train adds its
              section on those days, and the lifting plan never moves it.
            </p>
          </div>
        )}
        {ahead.map((p, i) =>
          i > 0 && !rehabInForce(p, today) && !opened.has(p.id) ? (
            <NextBlockRow
              key={p.id}
              p={p}
              onOpen={() => {
                open(p.id);
                focusAfter(() => document.querySelector<HTMLElement>(blockSel(p.id)));
              }}
            />
          ) : (
            <BlockCard key={p.id} p={p} ctx={ctx} heading={i > 0 ? "Next rehab block" : undefined} />
          ),
        )}

        {earlier.length > 0 && (
          <div data-rehab-history="">
            <SubHead>Earlier rehab blocks</SubHead>
            <ul>
              {earlier.map((p) => (
                <li key={p.id} className="flex min-h-11 flex-wrap items-baseline justify-between gap-x-4 py-1.5">
                  <span className="min-w-0 text-[0.9375rem] text-fg">{nameOf(p)}</span>
                  <span className="num ml-auto text-xs text-mute">
                    {datesText(p.start, rehabLastDay(p), today)} · {sessionsText(rehabSessions(p, sessions).length)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {adding ? (
          <NewBlockForm
            from={freeFrom}
            like={latest}
            heading={any}
            onStart={startNew}
            onClose={() => {
              setAdding(false);
              focusAfter(() => newButton.current);
            }}
          />
        ) : (
          <div className={any ? "mt-8" : "mt-5"}>
            <button ref={newButton} type="button" className="btn-ghost" aria-describedby={lineId} onClick={() => setAdding(true)}>
              <Plus size={14} aria-hidden /> {any ? "New rehab block" : "Set up a rehab block"}
            </button>
            <p id={lineId} className="mt-2 text-xs text-mute">
              {newLine}
            </p>
          </div>
        )}
      </div>
    </Section>
  );
}
