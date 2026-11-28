/**
 * Program › Rehab (SPEC §6.8, DESIGN A.9): rehab blocks — a protocol on its own timeline ("Knee
 * rehab · 6 weeks · Mon/Wed/Fri"), independent of the strength plans. Behind the `rehab` flag
 * (screens/Program.tsx mounts it).
 *
 * - The block in force (and any scheduled after it): its name, where it is ("Week 2 of 6 · Oct 19
 *   – Nov 29", sessions logged of planned), a week rail, its days, its length (−/+ and the day it
 *   ends), its start, what each session starts from (the last session / the same weekday),
 *   "+ A week" with what it would do, End today, and Cancel while nothing is logged under it.
 * - Earlier blocks, read-only: name, dates, sessions logged.
 * - A new block, starting where `newRehabStart` says (the day after the latest one ends, or
 *   today); with none at all, an empty state that sets up the first.
 *
 * Nothing here calculates or writes a block's fields: every read and edit goes through
 * src/shared/rehab.ts, and an edit it refuses (an overlap, no day left) says why. Every change
 * leaves an Undo (`settings/undo.ts`) that works on the settings as they are when it is tapped
 * and puts back only that block's own field — and declines when that field was changed again
 * since. Consecutive changes of one field fold into one toast. End today can change today's
 * session too (its unlogged rehab blocks of the block go, `endRehab`): that is saved through the
 * session outbox, and its Undo puts back, on today's session as it is then, only those blocks.
 *
 * Typing stays put: the lines an edit changes keep their height (the status is two lines that
 * never wrap into a third at 320 px, the two carry explanations share one box), and what an
 * action adds or removes is below the control that was tapped.
 */
import clsx from "clsx";
import { useId, useRef, useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { addDays, daysBetween, formatShortDate, isISODate, weekdayName, WEEKDAY_SHORT, type ISODate } from "../../../shared/dates";
import {
  cancelRehab,
  editRehab,
  endRehab,
  extendRehab,
  newRehabStart,
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
 * A block put back as it was, after it was removed (an Undo of Cancel, or of End today on its
 * first day): started for its first week, then given its span — so an early end it had counts
 * when checking it against the blocks set up since.
 */
function restoreBlock(now: Settings, p: RehabProgram, sessions: ReadonlyArray<Session>): Settings | null {
  if (rehabById(now, p.id)) return null;
  const back = startRehab(now, { ...fieldsOf(p), weeks: 1 }, p.id);
  if ("refused" in back) return null;
  const span = setSpan(back.settings, p.id, spanOf(p), sessions);
  return "refused" in span ? null : span.settings;
}

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

/** The block `id`'s card (`data-rehab-block`), as a selector. */
const blockSel = (id: string) => `[data-rehab-block="${id.replace(/["\\]/g, "\\$&")}"]`;
/** Where focus goes after an Undo of the block `id`: what `selector` matches in its card. */
const inBlock =
  (id: string, selector: string): Focus =>
  () =>
    document.querySelector<HTMLElement>(`${blockSel(id)} ${selector}`);

const CARRY: Array<[Carry, string, string]> = [
  [
    "last",
    "The last session",
    "Each session starts from the one before it — Wednesday from Monday — with its exercises, sets and loads. Pick “The same weekday” when each day has its own routine.",
  ],
  [
    "weekday",
    "The same weekday",
    "Each session starts from the same weekday’s last one — Monday from last Monday. Pick “The last session” when every day is the same routine.",
  ],
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

/** "The last session / The same weekday", and what the choice means (both lines share one box: a tap never moves what's below). */
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
   * the folded changes) only while the field still reads `after`.
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
    run<T>((now) => set(now, after), {
      fold: { key: `rehab-${key}-${id}`, before, after },
      message,
      undo: (now, from) => {
        const q = rehabById(now, id);
        if (!q || read(q) !== after) return null;
        const r = set(now, from);
        return "refused" in r ? null : r.settings;
      },
      cantUndo: `Can't undo: ${name} was changed again since.`,
      focus,
    });

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
    if ("refused" in extend) return run(() => extend, { message: "", undo: () => null });
    return setLength(spanOf(extend.program), focus);
  };
  // The − never ends it before this week is out: ending it is End today.
  const minWeeks = Math.max(1, week ?? 1);
  const shorter = (to: number) => {
    const natural = addDays(p.start, to * 7 - 1);
    setLength(
      { weeks: to, end: p.end !== undefined && p.end < natural ? p.end : undefined },
      inBlock(id, `[data-rehab-length] button[aria-label^="Decrease"]`),
    );
  };

  /**
   * End today. With nothing of it logged today, today's session loses its rehab blocks of it (an
   * unlogged draft the first edit saved) — saved through the session outbox like any session edit,
   * or deleted when nothing else was in it (`endRehab`'s `today`). Its Undo puts back the block's
   * length and, on today's session as it is when Undo is tapped, only those blocks.
   */
  const endToday = () => {
    const date = today;
    const ended: {
      lastDay: ISODate | null;
      /**
       * Today's session when End today changes it: as it was, what to save (null: delete it), and
       * the blocks it dropped, with where they were.
       */
      session: { was: Session; next: Session | null; dropped: Array<{ at: number; block: Block }> } | null;
    } = { lastDay: null, session: null };
    const saved = run<undefined>(
      (now) => {
        const all = liveSessions(sessions);
        const r = endRehab(now, id, date, all);
        if ("refused" in r) return r;
        ended.lastDay = r.lastDay;
        const was = all.findLast((s) => s.date === date);
        if (r.today !== undefined && was) {
          const kept = new Set((r.today?.blocks ?? []).map((b) => b.id));
          const dropped = was.blocks.flatMap((block, at) => (kept.has(block.id) ? [] : [{ at, block }]));
          ended.session = { was, next: r.today, dropped };
        }
        return r;
      },
      {
        message: () =>
          ended.lastDay === null
            ? `${name} removed: it started today, with nothing logged`
            : ended.lastDay === date
              ? `${name} ends today`
              : `${name} ended: its last day was yesterday`,
        undo: (now) => {
          const q = rehabById(now, id);
          let back: Settings | null;
          if (!q) back = restoreBlock(now, p, sessions);
          else if (q.end !== ended.lastDay) back = null;
          else {
            const r = setSpan(now, id, spanOf(p), sessions);
            back = "refused" in r ? null : r.settings;
          }
          // Today's session too — only once the block's length can be put back (else neither is).
          const s = ended.session;
          if (back && s) {
            const restored = withDroppedBack(liveSessions(sessions).findLast((x) => x.date === date) ?? null, s.was, s.dropped);
            if (restored) saveSession(restored);
          }
          return back;
        },
        cantUndo: `Can't undo: ${name} was changed again since.`,
        focus: inBlock(id, `[data-rehab-control="end"]`),
      },
    );
    if (saved && ended.session) {
      if (ended.session.next) saveSession(ended.session.next);
      else deleteSession(date);
    }
    // Ended before today: its card goes (to the earlier blocks).
    if (saved && ended.lastDay !== date) focusAway();
  };

  const cancel = () => {
    const saved = run<undefined>((now) => cancelRehab(now, id, liveSessions(sessions)), {
      message: `${name} cancelled`,
      undo: (now) => restoreBlock(now, p, sessions),
      cantUndo: `Can't undo: another rehab block has ${name}'s dates now.`,
      focus: inBlock(id, `[data-rehab-control="cancel"]`),
    });
    if (saved) focusAway();
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
              min={minWeeks}
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
        {"refused" in extend ? extend.refused : `“+ A week” ends it ${dayName(extend.lastDay)} instead of ${formatShortDate(extend.was)}.`}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A new block
// ---------------------------------------------------------------------------

/** What a first block is set up with until changed (the latest block's, when there is one). */
const FIRST_DAYS = [false, true, false, true, false, true, false];
const FIRST_WEEKS = 6;

/** Setting up a rehab block: nothing is saved until "Start it". */
function NewBlockForm({
  start: initialStart,
  like,
  onStart,
  onClose,
}: {
  start: ISODate;
  /** The latest block: a new one starts with its days, length and carry. */
  like: RehabProgram | null;
  /** Saves it; why it can't be, or null. */
  onStart: (fields: RehabFields) => string | null;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [days, setDays] = useState<boolean[]>(like ? [...like.days] : FIRST_DAYS);
  const [weeks, setWeeks] = useState(like?.weeks ?? FIRST_WEEKS);
  const [start, setStart] = useState(initialStart);
  const [carry, setCarry] = useState<Carry>(like?.carry ?? "last");
  const [refused, setRefused] = useState<string | null>(null);
  const nameId = useId();
  const startId = useId();
  const errorId = useId();
  return (
    <div data-rehab-new="">
      <SubHead>New rehab block</SubHead>
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
  const until = ahead.at(-1) ?? null;
  const newStart = newRehabStart(settings, today);
  const any = all.length > 0;

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
    focusAfter(() => document.querySelector<HTMLElement>(blockSel(blockId)));
    return null;
  };

  const newLine = until
    ? `Starts ${dayName(newStart)}, the day after ${nameOf(until)} ends${inForce?.id === until.id ? " — or today, if you end it first" : ""}.`
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
        {ahead.map((p, i) => (
          <BlockCard key={p.id} p={p} ctx={ctx} heading={i > 0 ? "Next rehab block" : undefined} />
        ))}

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
            start={newStart}
            like={latest}
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
