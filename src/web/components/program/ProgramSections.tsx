/**
 * The Program screen's sections (see screens/Program.tsx): where the cycle is now (and the next
 * cycle, when one is set up), the weekly layout, the targets and training days, the cycle's weeks,
 * the rules and the rep-max table. Each edits the settings through the setters of
 * `useSettingsEditor` — the plan sections the plan picked with the "This cycle / Next cycle" switch
 * (SPEC §6.4); nothing here calculates — positions, shifts, plans and percentages come from
 * src/shared (program.ts, plans.ts). Changes that are easy to make by accident (moving the cycle,
 * switching a lifting day off, removing a week, cancelling the next cycle) leave an Undo.
 */
import clsx from "clsx";
import { useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { Plus, Trash2 } from "lucide-react";
import { daysBetween, formatShortDate, isISODate, startOfWeek, weekdayName, WEEKDAY_SHORT, type ISODate } from "../../../shared/dates";
import { newCycleStart, type PlanFields } from "../../../shared/plans";
import {
  cyclePosition,
  movePlanStart,
  movingPlan,
  planAt,
  planTimeline,
  previewCycleShift,
  repMaxPct,
  snapCycleStart,
  type CyclePosition,
} from "../../../shared/program";
import type { Plan, Program, ProgramDay, ProgramWeek, Session } from "../../../shared/schemas";
import { useData } from "../../lib/store";
import { InlineText } from "../InlineText";
import { DayPicker, NumSetting, RestSetting, WEEK_ORDER } from "../settings/fields";
import type { PlanUndo, ProgramUndo, TrainingPrefs } from "../settings/useSettingsEditor";
import { useToast } from "../Toast";
import { BoxNumber, Field, Section, Toggle } from "../ui";
import { CycleEndNote, type CycleChoice } from "./CycleEndNote";

interface ProgramEdit {
  program: Program;
  setProgram: (p: Partial<Program>) => void;
  /** Section id (jump target). */
  id?: string;
}
/** A program change with an Undo toast (`useSettingsEditor().undoableProgram`); false when it wasn't saved. */
type UndoableProgram = <T = undefined>(p: Partial<Program>, undo: ProgramUndo<T>) => boolean;

/** Editing one plan (SPEC §6.4): the plan picked with the switch, and its setters. */
export interface PlanEdit {
  plan: Plan;
  setPlan: (p: Partial<PlanFields>) => void;
  /** A change of the plan with an Undo toast; false when it wasn't saved. */
  undoable: <T = undefined>(p: Partial<PlanFields>, undo: PlanUndo<T>) => boolean;
  /** The "This cycle / Next cycle" switch, while a next cycle is set up (null otherwise). */
  switcher: ReactNode;
  /** Section id (jump target). */
  id?: string;
}

// ---------------------------------------------------------------------------
// This cycle / Next cycle
// ---------------------------------------------------------------------------

export type PlanChoice = "this" | "next";

/**
 * Which plan the plan sections edit while a next cycle is set up: this cycle's (the plan in force)
 * or the next one's. One switch per section, all showing the same choice.
 */
export function PlanSwitch({ value, onChange, nextStart }: { value: PlanChoice; onChange: (v: PlanChoice) => void; nextStart: ISODate }) {
  const options: Array<[PlanChoice, string]> = [
    ["this", "This cycle"],
    ["next", "Next cycle"],
  ];
  return (
    <div className="mb-4">
      <div role="group" aria-label="Plan to edit" className="inline-flex rounded-full bg-white/[0.04] p-1" data-plan-switch="">
        {options.map(([v, label]) => (
          <button
            key={v}
            type="button"
            aria-pressed={value === v}
            onClick={() => onChange(v)}
            className={clsx(
              "tap min-h-11 rounded-full px-4 text-sm",
              value === v ? "bg-white/[0.08] text-fg" : "text-mute",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-mute">
        {value === "next"
          ? `From ${weekdayName(nextStart, true)} ${formatShortDate(nextStart)}. This cycle stays as it is.`
          : `Until ${weekdayName(nextStart, true)} ${formatShortDate(nextStart)}, when the next cycle starts.`}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Now
// ---------------------------------------------------------------------------

/** "today", "tomorrow", "this Thursday", "next Monday", else "Mon Nov 16" — a day, seen from today. */
function dayFromToday(date: ISODate, today: ISODate): string {
  const days = daysBetween(today, date);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  const weeks = daysBetween(startOfWeek(today), startOfWeek(date)) / 7;
  if (weeks === 0 && days > 0) return `this ${weekdayName(date)}`;
  if (weeks === 1) return `next ${weekdayName(date)}`;
  return `${weekdayName(date, true)} ${formatShortDate(date)}`;
}

/**
 * A week by its own name, for a sentence: "Week 3", "Heavy", "Easy (deload)" when the name doesn't
 * say it is one, and "Week 1 (cycle 2)" when its cycle isn't the one the sentence is already in.
 */
function weekName(pos: CyclePosition, inCycle: number): string {
  const notes = [pos.week.deload && !/deload/i.test(pos.week.label) && "deload", pos.cycle !== inCycle && `cycle ${pos.cycle}`].filter(Boolean);
  return notes.length ? `${pos.week.label} (${notes.join(", ")})` : pos.week.label;
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * What delaying the program a week (`weeks` 1) or skipping ahead a week (−1) would do, in one
 * line, before it is tapped — this week and the next, from `previewCycleShift`:
 *
 *   "This week repeats Week 2; next Monday is Week 3 · Push."        (delay, mid-cycle)
 *   "This week becomes Week 3; next Monday is Week 4 · Push."        (skip ahead)
 *   "Starts Mon Nov 9 instead of Nov 2: this week is before the program; next Monday is Week 1 · Push."
 *   "Starts Mon Nov 23 instead of Nov 16."                           (still more than a week away)
 *   "This week goes back to the plan before: Deload (cycle 2); …"   (delaying a new plan's first week)
 *
 * The plan in force moves with every later plan, never an earlier one; a move that can't be made
 * says why (`refused`).
 */
export function shiftEffect(program: Program, weeks: 1 | -1, today: ISODate): string {
  const { refused, from, to, before, position: after, nextWeek } = previewCycleShift(program, weeks, today);
  if (refused) return refused;
  if (to === from) return "The program can't move any further.";
  const starts = `Starts ${weekdayName(to, true)} ${formatShortDate(to)} instead of ${formatShortDate(from)}`;
  /** "next Monday is Week 3 · Push", or from its first lifting day when that isn't the Monday. */
  const nextWeekIs = (inCycle: number): string | null => {
    if (!nextWeek.position) return null;
    const name = weekName(nextWeek.position, inCycle);
    const first = nextWeek.first;
    if (!first) return `next week is ${name}`;
    return first.date === nextWeek.start
      ? `next ${weekdayName(first.date)} is ${name} · ${first.day.label}`
      : `next week is ${name}, from ${weekdayName(first.date)} · ${first.day.label}`;
  };
  const sentence = (thisWeek: string, next: string | null) => (next ? `${thisWeek}; ${next}.` : `${thisWeek}.`);

  // Afterwards the first cycle hasn't started yet: say when it does — and, when that is next
  // week, what this week and the next turn into.
  if (!after) return nextWeek.position ? `${starts}: ${sentence("this week is before the program", nextWeekIs(1))}` : `${starts}.`;
  // Delayed into the plan before: this week reads under it again. Skipped ahead into the next
  // cycle's plan (it moves up too): this week is under it already.
  if (before && after.plan.index < before.plan.index)
    return sentence(`This week goes back to the plan before: ${weekName(after, before.cycle)}`, nextWeekIs(after.cycle));
  if (before && after.plan.index > before.plan.index)
    return sentence(`This week becomes ${weekName(after, before.cycle)}, on the next cycle's plan`, nextWeekIs(after.cycle));
  // A one-week program has one week to be in: only the count of cycles moves.
  if (before && after.weeksCount === 1 && before.weeksCount === 1)
    return `Every week is ${weekName(after, after.cycle)}, so only the cycle count changes: this week is cycle ${after.cycle} instead of ${before.cycle}.`;
  // Delayed, this week is last week's over again; skipping ahead, it turns into next week's.
  const thisWeek = `This week ${weeks > 0 ? "repeats" : "becomes"} ${weekName(after, before?.cycle ?? after.cycle)}`;
  const text = sentence(thisWeek, nextWeekIs(after.cycle));
  // Skipping ahead brought the start to this week: lead with the new start.
  return before ? text : `${starts}: ${lowerFirst(text)}`;
}

/** Taps on the shift buttons closer together than this are one tap (a double-tap moves one week, not two). */
export const SHIFT_GUARD_MS = 600;

const weeksText = (n: number) => (n === 1 ? "a week" : `${n} weeks`);
/** The toast for a start moved from `from` to `to` by the shift buttons: the net move, however many taps it took. */
function shiftedMessage(from: ISODate, to: ISODate): string {
  const weeks = Math.round(daysBetween(from, to) / 7);
  return weeks > 0 ? `Program delayed ${weeksText(weeks)}` : `Program moved ahead ${weeksText(-weeks)}`;
}

function ShiftAction({
  label,
  weeks,
  program,
  today,
  onShift,
}: {
  label: string;
  weeks: 1 | -1;
  program: Program;
  today: ISODate;
  onShift: (to: ISODate, button: RefObject<HTMLButtonElement | null>) => void;
}) {
  const effectId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const preview = previewCycleShift(program, weeks, today);
  return (
    <div className="py-3">
      <button
        ref={button}
        type="button"
        className="btn-ghost"
        aria-describedby={effectId}
        disabled={!!preview.refused || preview.to === preview.from}
        onClick={() => onShift(preview.to, button)}
      >
        {label}
      </button>
      <p id={effectId} className="mt-2 text-xs text-mute">
        {shiftEffect(program, weeks, today)}
      </p>
    </div>
  );
}

/** What the Now section does with the next cycle (`useCycleChoice`). */
export interface NextCycleActions extends CycleChoice {
  /** Cancels the scheduled next cycle (with Undo): the cycle in force repeats. */
  cancelNext: (plan: Plan) => void;
}

/**
 * Where the program is today — cycle, week, the week's dates — and the controls that move it:
 * the cycle start date, and delaying it / skipping ahead a week in one tap. Every move of the
 * start leaves one Undo toast: moves made while it is up fold into it (its Undo goes back to
 * where the start was before the first), and it only undoes a start that is still where it put it.
 * With more than one plan a move is of the plan in force now (before the program: the first) and
 * every later plan, never an earlier plan's start.
 *
 * Then the next cycle: when one is set up, "Next cycle · from Mon Nov 30" with its name and a way to
 * cancel it; otherwise "Start a new cycle" (and, in a cycle's last week, the end-of-cycle note).
 */
export function CycleNow({
  program,
  current,
  next,
  setPlan,
  undoable,
  today,
  sessions,
  settingsForStart,
  actions,
  id,
}: {
  program: Program;
  /** The plan in force (before the program: the first). */
  current: Plan;
  /** The next cycle's plan, when one is set up. */
  next: Plan | null;
  setPlan: (id: string, p: Partial<PlanFields>) => void;
  undoable: UndoableProgram;
  today: ISODate;
  sessions: ReadonlyArray<Session>;
  /** The settings, to say where a new cycle would start (`newCycleStart`). */
  settingsForStart: Parameters<typeof newCycleStart>[0];
  actions: NextCycleActions;
  id?: string;
}) {
  const toast = useToast();
  const pos = cyclePosition(program, today);
  const moving = movingPlan(program, today);
  const firstUp = planAt(program, today);
  const startsIn = daysBetween(today, firstUp.start);
  // "Week 2" as a week's name adds nothing next to "Week 2 of 5"; a name of its own ("Heavy") does.
  const ownLabel = pos && pos.week.label.trim().toLowerCase() !== `week ${pos.weekIndex + 1}` ? pos.week.label : null;
  const deloadNote = pos?.week.deload && !/deload/i.test(ownLabel ?? "") ? "Deload week" : null;
  const dateField = useRef<HTMLInputElement>(null);
  const lastShift = useRef(0);
  const newStart = newCycleStart(settingsForStart, sessions, today);
  const startId = useId();

  const moveStart = (to: ISODate, message: (from: ISODate) => string, control: RefObject<HTMLElement | null>) => {
    const planId = moving.id;
    const was = moving.start;
    if (to === was) return;
    const moved = movePlanStart(program, planId, to);
    if (moved.refused) {
      toast.show({ message: moved.refused, tone: "warn" });
      return;
    }
    const { cycleStartDate, earlierPlans } = moved.program;
    undoable<ISODate>(
      { cycleStartDate, ...(earlierPlans ? { earlierPlans } : {}) },
      {
        fold: { key: `cycle-start-${planId}`, before: was, after: to },
        message,
        undo: (now, from) => {
          // A tap after an Undo is a new decision, however soon it comes.
          lastShift.current = 0;
          // Relative: only a start that is still where this put it goes back.
          const plan = movingPlanById(now, planId);
          if (!plan || plan.start !== to) return null;
          const back = movePlanStart(now, planId, from);
          if (back.refused) return null;
          return { cycleStartDate: back.program.cycleStartDate, ...(back.program.earlierPlans ? { earlierPlans: back.program.earlierPlans } : {}) };
        },
        cantUndo: "Can't undo: the cycle start was changed again since.",
        focus: () => control.current,
      },
    );
  };
  const shift = (to: ISODate, button: RefObject<HTMLButtonElement | null>) => {
    // One move per tap: a double-tap (or a tap landing while the first is still being saved) is one.
    const now = Date.now();
    if (now - lastShift.current < SHIFT_GUARD_MS) return;
    lastShift.current = now;
    moveStart(to, (from) => shiftedMessage(from, to), button);
  };

  return (
    <Section label="Now" id={id}>
      <div data-cycle-now="">
        {pos ? (
          <>
            <p className="text-2xl leading-tight font-light tracking-tight">
              Cycle {pos.cycle} <span aria-hidden>·</span> Week {pos.weekIndex + 1} of {pos.weeksCount}
            </p>
            <p className="mt-1.5 text-sm text-mute">
              {(ownLabel || deloadNote) && <span className="text-fg-2">{[ownLabel, deloadNote].filter(Boolean).join(" · ")} · </span>}
              {formatShortDate(pos.weekStart)} – {formatShortDate(pos.weekEnd)} · cycle ends {formatShortDate(pos.cycleEnd)}
            </p>
          </>
        ) : (
          <>
            <p className="text-2xl leading-tight font-light tracking-tight">Starts {dayFromToday(firstUp.start, today)}</p>
            <p className="mt-1.5 text-sm text-mute">
              Cycle 1 · Week 1 of {firstUp.weeks.length} begins {weekdayName(firstUp.start, true)} {formatShortDate(firstUp.start)}
              {startsIn > 1 && `, in ${startsIn} days`}
            </p>
          </>
        )}
      </div>
      {actions.card && !actions.card.next && (
        <div className="mt-4">
          <CycleEndNote choice={actions} />
        </div>
      )}
      <div className="mt-3 divide-y divide-white/[0.04]">
        <Field label="Cycle start date" hint={program.earlierPlans?.length ? "This cycle's plan began on this Monday" : "Snaps to that week's Monday"}>
          <input
            ref={dateField}
            type="date"
            value={moving.start}
            onChange={(e) => {
              if (!isISODate(e.target.value)) return;
              const to = snapCycleStart(e.target.value);
              moveStart(to, () => `Program starts ${weekdayName(to, true)} ${formatShortDate(to)}`, dateField);
            }}
            className="field num rounded-xl bg-white/[0.05] px-3 py-2 text-base [color-scheme:dark]"
          />
        </Field>
        <ShiftAction label="Delay a week" weeks={1} program={program} today={today} onShift={shift} />
        <ShiftAction label="Skip ahead a week" weeks={-1} program={program} today={today} onShift={shift} />
        {/* Long names need the full width: label above, the name below. */}
        <div className="py-3">
          <div className="text-sm text-fg-2">Program name</div>
          <InlineText
            ariaLabel="Program name"
            value={current.name}
            maxLength={60}
            required
            requiredMessage="Give the program a name."
            onCommit={(name) => setPlan(current.id, { name })}
            className="mt-1"
            inputClassName="text-base"
          />
        </div>
        {next ? (
          <div className="py-4" data-next-cycle="">
            <p className="text-sm text-fg-2">
              Next cycle <span aria-hidden>·</span> from {weekdayName(next.start, true)} {formatShortDate(next.start)}
            </p>
            <p className="mt-1 text-xs text-mute">
              Cycle {pos ? pos.cycle + 1 : 1} onward follows the plan below (Next cycle). Until then this cycle stays as it is.
            </p>
            <div className="mt-3">
              <div className="text-xs text-mute">Its name</div>
              <InlineText
                ariaLabel="Next cycle's program name"
                value={next.name}
                maxLength={60}
                required
                requiredMessage="Give the program a name."
                onCommit={(name) => setPlan(next.id, { name })}
                className="mt-1"
                inputClassName="text-base"
              />
            </div>
            <button type="button" className="btn-ghost mt-3" onClick={() => actions.cancelNext(next)}>
              Cancel the new cycle
            </button>
          </div>
        ) : pos ? (
          <div className="py-3">
            <button
              type="button"
              className="btn-ghost"
              aria-describedby={startId}
              disabled={!newStart}
              onClick={() => actions.setUpNewCycle()}
            >
              Start a new cycle
            </button>
            <p id={startId} className="mt-2 text-xs text-mute">
              {newStart && newStart <= today
                ? `A copy of this plan to change — the days, lifts, weeks and targets — from ${weekdayName(newStart, true)} ${formatShortDate(newStart)}: nothing is logged in this cycle yet, so it starts over now.`
                : newStart
                  ? `A copy of this plan to change — the days, lifts, weeks and targets — from ${weekdayName(newStart, true)} ${formatShortDate(newStart)}, when cycle ${pos.cycle} ends. Until then nothing changes.`
                  : "A new cycle can be set up once this one is under way."}
            </p>
          </div>
        ) : null}
      </div>
    </Section>
  );
}

/** The plan `id` on the program's timeline (an Undo finds the moved plan by it). */
function movingPlanById(program: Program, id: string): { start: ISODate } | null {
  return planTimeline(program).find((s) => s.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// Weekly layout
// ---------------------------------------------------------------------------

const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export function WeeklyLayout({ plan, setPlan, undoable, switcher, id }: PlanEdit) {
  const { data } = useData();
  const tracked = data.exercises.filter((e) => e.tracksMax && !e.archived);
  // The stored program has no place for a day that is off (days are keyed by weekday; a day
  // without an entry isn't a lifting day), so what a day was when it was switched off is kept
  // here for as long as the screen is open: switching it back on brings it back as it was.
  const switchedOff = useRef<Record<string, ProgramDay>>({});
  return (
    <Section label="Weekly layout" id={id}>
      {switcher}
      <div className="space-y-1">
        {WEEK_ORDER.map((wd) => {
          const key = String(wd);
          const offKey = `${plan.id}:${key}`;
          const day = plan.days[key];
          const name = WEEKDAY_SHORT[wd]!;
          const setDay = (patch: Partial<ProgramDay>) => day && setPlan({ days: { ...plan.days, [key]: { ...day, ...patch } } });
          const DAY_DEFAULT: ProgramDay = { label: "Training", primaryExerciseId: null, progression: true };
          const setLifting = (on: boolean) => {
            const fold = { key: `lifting-${plan.id}-${key}`, before: true, after: on };
            if (on) {
              // Back on, as it was. That is what the "switched off" toast's Undo would do: the fold
              // ends where it began, so a toast still on offer goes (and none is raised).
              undoable<boolean>({ days: { ...plan.days, [key]: switchedOff.current[offKey] ?? DAY_DEFAULT } }, { fold, message: "", undo: () => null });
              return;
            }
            if (!day) return;
            switchedOff.current[offKey] = day;
            const { [key]: _off, ...days } = plan.days;
            undoable<boolean>(
              { days },
              {
                fold,
                message: `${WEEKDAY_LONG[wd]} lifting switched off`,
                // Its name, main lift and AMRAP setting go back — unless the day is a lifting day again by then.
                undo: (now) => (now.days[key] ? null : { days: { ...now.days, [key]: day } }),
                cantUndo: `Can't undo: ${WEEKDAY_LONG[wd]} is a lifting day again.`,
                focus: () => document.querySelector<HTMLElement>(`[role="switch"][aria-label="${name} lifting day"]`),
              },
            );
          };
          return (
            <div key={wd} className="py-3">
              {/* At 200% zoom the switch (with its caption) drops under the name, right-aligned. */}
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <span className={clsx("w-10 shrink-0 text-sm", day ? "text-fg" : "text-mute")}>{name}</span>
                {day ? (
                  <InlineText
                    ariaLabel={`${name} session name`}
                    value={day.label}
                    maxLength={40}
                    required
                    requiredMessage="Name the session."
                    onCommit={(label) => setDay({ label })}
                    className="min-w-[4.5rem] flex-1"
                    inputClassName="text-sm text-fg-2"
                  />
                ) : (
                  <span className="min-w-[4.5rem] flex-1 text-sm text-mute">No lifting</span>
                )}
                {/* Two switches per day: each says what it switches. */}
                <span className="ml-auto flex shrink-0 items-center gap-3">
                  <span className="text-xs text-mute" aria-hidden>
                    Lift
                  </span>
                  <Toggle label={`${name} lifting day`} on={!!day} onChange={setLifting} />
                </span>
              </div>
              {day && (
                <div className="mt-2 flex flex-wrap items-center gap-3 min-[25rem]:pl-[3.25rem]">
                  <select
                    aria-label={`${name} main lift`}
                    value={day.primaryExerciseId ?? ""}
                    onChange={(e) => setDay({ primaryExerciseId: e.target.value ? Number(e.target.value) : null })}
                    className="field min-w-[8rem] flex-1 rounded-xl bg-white/[0.05] px-3 py-2 text-base [color-scheme:dark]"
                  >
                    <option value="">No main lift</option>
                    {tracked.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                  <span className="ml-auto text-xs text-mute" aria-hidden>
                    AMRAP
                  </span>
                  <Toggle label={`${name} AMRAP progression`} on={day.progression} onChange={(v) => setDay({ progression: v })} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Targets and training days
// ---------------------------------------------------------------------------

/**
 * The plan's daily targets and training days (SPEC §3, §6.4): the steps target, Zone 2's minutes and
 * days, the metcon days. Part of the plan, so a new cycle can change them and the days before it
 * keep reading by the ones they had.
 */
export function PlanTargetsSection({ plan, setPlan, switcher, id }: PlanEdit) {
  return (
    <Section label="Targets & days" id={id}>
      {switcher}
      <div className="divide-y divide-white/[0.04]">
        <NumSetting
          label="Steps"
          value={plan.targets.steps}
          min={0}
          max={100_000}
          grouping
          onSave={(v) => v !== null && setPlan({ targets: { ...plan.targets, steps: v } })}
        />
        <NumSetting
          label="Zone 2"
          hint="Default duration when you check it off"
          value={plan.targets.zone2Minutes}
          unit="min"
          min={0}
          max={600}
          unitInMessage=" min"
          onSave={(v) => v !== null && setPlan({ targets: { ...plan.targets, zone2Minutes: v } })}
        />
      </div>
      <div className="mt-6">
        <DayPicker label="Metcon" value={plan.schedule.metcon} onChange={(metcon) => setPlan({ schedule: { ...plan.schedule, metcon } })} />
        <div className="h-6" />
        <DayPicker label="Zone 2" value={plan.schedule.zone2} onChange={(zone2) => setPlan({ schedule: { ...plan.schedule, zone2 } })} />
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Cycle weeks
// ---------------------------------------------------------------------------

function RepsInput({ value, onCommit, ariaLabel }: { value: number[]; onCommit: (v: number[]) => void; ariaLabel: string }) {
  const [text, setText] = useState(value.join(", "));
  const [error, setError] = useState<string | null>(null);
  const errId = useId();
  return (
    <div>
      <input
        aria-label={ariaLabel}
        aria-invalid={!!error || undefined}
        aria-describedby={error ? errId : undefined}
        value={text}
        inputMode="numeric"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const parts = text.split(/[\s,/]+/).filter(Boolean);
          const reps = parts.map(Number);
          const ok = reps.length > 0 && reps.length <= 12 && reps.every((n) => Number.isInteger(n) && n > 0 && n <= 50);
          if (!ok) {
            setError(
              reps.length > 12
                ? "Up to 12 sets."
                : reps.length === 0
                  ? "Enter the reps for each set, e.g. 5, 5, 5."
                  : "Reps are whole numbers from 1 to 50.",
            );
            return;
          }
          setError(null);
          if (reps.join() !== value.join()) onCommit(reps);
          setText(reps.join(", "));
        }}
        className="field num w-full rounded-xl bg-white/[0.05] px-3 py-2 text-base"
      />
      {error && (
        <div id={errId} role="alert" className="mt-1.5 text-xs text-warn">
          {error}
        </div>
      )}
    </div>
  );
}

export function CycleWeeks({ plan, setPlan, undoable, switcher, id }: PlanEdit) {
  const setWeek = (i: number, w: Partial<ProgramWeek>) =>
    setPlan({ weeks: plan.weeks.map((x, j) => (j === i ? { ...x, ...w } : x)) });
  return (
    <Section label="Cycle weeks" id={id} right={<span className="label">{plan.weeks.length}</span>}>
      {switcher}
      <div className="space-y-6">
        {plan.weeks.map((w, i) => (
          <div key={i}>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3">
              <div className="flex min-w-0 flex-[1_1_8rem] items-center gap-2">
                <span className="label w-5 shrink-0 text-accent" aria-hidden>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <InlineText
                  ariaLabel={`Week ${i + 1} name`}
                  value={w.label}
                  maxLength={40}
                  required
                  requiredMessage="Name the week."
                  onCommit={(label) => setWeek(i, { label })}
                  className="w-40 min-w-0 shrink"
                  inputClassName="text-sm"
                />
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-3">
                <span className="text-xs text-mute" aria-hidden>
                  Deload
                </span>
                <Toggle
                  label={`Week ${i + 1} deload`}
                  on={w.deload}
                  onChange={(v) => setWeek(i, { deload: v, basisReps: v ? (w.basisReps ?? 12) : null })}
                />
                {plan.weeks.length > 1 && (
                  <button
                    type="button"
                    aria-label={`Remove week ${i + 1}`}
                    className="tap -my-2 -mr-3 grid h-11 w-11 place-items-center text-mute"
                    onClick={() =>
                      undoable(
                        { weeks: plan.weeks.filter((_, j) => j !== i) },
                        {
                          message: `Week ${i + 1} removed`,
                          // Undo runs from a toast, later: the week goes back into the weeks as they are then.
                          undo: (now) => {
                            const weeks = [...now.weeks];
                            weeks.splice(Math.min(i, weeks.length), 0, w);
                            return { weeks };
                          },
                          focus: () => document.querySelector<HTMLElement>(`button[aria-label="Remove week ${i + 1}"]`),
                        },
                      )
                    }
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-start gap-3 pl-7">
              <div className="min-w-[7rem] flex-1">
                <RepsInput
                  key={w.reps.join()}
                  ariaLabel={`Week ${i + 1} reps per set`}
                  value={w.reps}
                  onCommit={(reps) => setWeek(i, { reps })}
                />
              </div>
              {w.deload && (
                <div className="flex shrink-0 items-center gap-2 pt-1 text-xs text-mute">
                  <span aria-hidden>@</span>
                  <BoxNumber
                    ariaLabel={`Week ${i + 1} load based on rep max`}
                    value={w.basisReps}
                    onCommit={(v) => v !== null && v >= 1 && v <= 50 && setWeek(i, { basisReps: Math.round(v) })}
                    min={1}
                    max={50}
                    unit="RM"
                  />
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="btn-ghost mt-6"
        disabled={plan.weeks.length >= 16}
        onClick={() =>
          setPlan({
            weeks: [...plan.weeks, { label: `Week ${plan.weeks.length + 1}`, deload: false, reps: [5, 5, 5, 5], basisReps: null }],
          })
        }
      >
        <Plus size={16} /> Week
      </button>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** How loads are calculated and progressed, and how long to rest: the program's rules plus the training preferences. */
export function ProgramRules({
  program,
  setProgram,
  training,
  setTraining,
  id,
}: ProgramEdit & { training: TrainingPrefs; setTraining: (t: Partial<TrainingPrefs>) => void }) {
  return (
    <Section label="Rules" id={id}>
      <div className="divide-y divide-white/[0.04]">
        <NumSetting
          label="Working weight"
          hint="% of the N-rep max"
          value={Math.round(program.intensity * 100)}
          unit="%"
          min={30}
          max={120}
          unitInMessage="%"
          onSave={(v) => v !== null && setProgram({ intensity: v / 100 })}
        />
        <NumSetting
          label="Round weights to"
          hint="Nearest plate increment"
          value={program.roundToLb}
          decimals={1}
          unit="lb"
          min={0.5}
          max={25}
          unitInMessage=" lb"
          onSave={(v) => v !== null && setProgram({ roundToLb: v })}
        />
        <Field label="AMRAP last set" hint="Main lift, non-deload weeks">
          <Toggle label="AMRAP last set" on={program.amrapLastSet} onChange={(v) => setProgram({ amrapLastSet: v })} />
        </Field>
        <Field label="Auto progression" hint="Suggest a max bump when you beat the AMRAP target">
          <Toggle
            label="Auto progression"
            on={program.progression.enabled}
            onChange={(v) => setProgram({ progression: { ...program.progression, enabled: v } })}
          />
        </Field>
        {program.progression.enabled && (
          <NumSetting
            label="Per extra rep"
            hint="Added to the max for each rep past the target"
            value={program.progression.lbPerExtraRep}
            decimals={1}
            unit="lb"
            min={0}
            max={25}
            unitInMessage=" lb"
            onSave={(v) => v !== null && setProgram({ progression: { ...program.progression, lbPerExtraRep: v } })}
          />
        )}
        <NumSetting
          label="Deload accessories"
          hint="% of normal load"
          value={Math.round(program.deloadAccessoryLoad * 100)}
          unit="%"
          min={30}
          max={100}
          unitInMessage="%"
          onSave={(v) => v !== null && setProgram({ deloadAccessoryLoad: v / 100 })}
        />
        <NumSetting
          label="Accessory increment"
          hint="Suggested jump on a weighted accessory after hitting every target. 0 turns hints off."
          value={training.accessoryIncrementLb}
          decimals={1}
          unit="lb"
          min={0}
          max={50}
          unitInMessage=" lb"
          onSave={(v) => v !== null && setTraining({ accessoryIncrementLb: v })}
        />
        <RestSetting
          label="Main lift rest"
          hint="Rest timer target after a main-lift set"
          value={training.restSecondsMain}
          min={10}
          max={900}
          onSave={(v) => setTraining({ restSecondsMain: v })}
        />
        <RestSetting
          label="Accessory rest"
          hint="After accessory and superset sets"
          value={training.restSecondsAccessory}
          min={10}
          max={900}
          onSave={(v) => setTraining({ restSecondsAccessory: v })}
        />
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Rep-max table
// ---------------------------------------------------------------------------

export function RepMaxTable({ program, setProgram, id }: ProgramEdit) {
  const toast = useToast();
  const tableReps = Object.keys(program.repMaxPct)
    .map(Number)
    .sort((a, b) => a - b);
  return (
    <Section label="Rep-max table" id={id}>
      <p className="mb-4 text-xs text-mute">The % of your max you could lift for N reps. Missing counts are interpolated.</p>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 min-[25rem]:grid-cols-3 min-[25rem]:gap-x-5">
        {tableReps.map((r) => (
          <div key={r} className="flex items-center justify-between gap-2">
            <span className="num text-xs text-mute" aria-hidden>
              {r} RM
            </span>
            <BoxNumber
              ariaLabel={`${r} RM percent of max`}
              value={Math.round(repMaxPct(program.repMaxPct, r) * 1000) / 10}
              decimals={1}
              className="px-2 py-1"
              onCommit={(v) => {
                if (v !== null && (v < 10 || v > 100)) {
                  toast.show({ message: `${r} RM: enter a percent between 10 and 100.`, tone: "warn" });
                  return;
                }
                const next = { ...program.repMaxPct };
                if (v === null) delete next[String(r)];
                else next[String(r)] = v / 100;
                setProgram({ repMaxPct: next });
              }}
            />
          </div>
        ))}
      </div>
    </Section>
  );
}
