/**
 * The Program screen's sections (see screens/Program.tsx): where the cycle is now, the weekly
 * layout, the cycle's weeks, the rules and the rep-max table. Each edits the program (or the
 * training preferences) through the setters of `useSettingsEditor`; nothing here calculates —
 * positions, shifts and percentages come from src/shared/program.ts.
 */
import clsx from "clsx";
import { useId, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { daysBetween, formatShortDate, isISODate, startOfWeek, weekdayName, WEEKDAY_SHORT, type ISODate } from "../../../shared/dates";
import { cyclePosition, previewCycleShift, repMaxPct, snapCycleStart, type CyclePosition } from "../../../shared/program";
import type { Program, ProgramWeek } from "../../../shared/schemas";
import { useData } from "../../lib/store";
import { InlineText } from "../InlineText";
import { NumSetting, RestSetting, WEEK_ORDER } from "../settings/fields";
import type { TrainingPrefs } from "../settings/useSettingsEditor";
import { useToast } from "../Toast";
import { BoxNumber, Field, Section, Toggle } from "../ui";

interface ProgramEdit {
  program: Program;
  setProgram: (p: Partial<Program>) => void;
  /** Section id (jump target). */
  id?: string;
}
type UndoableProgram = (p: Partial<Program>, message: string, undo: (now: Program) => Partial<Program>) => void;

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

/** The week's own name, with its cycle when that differs from the one today is in. */
const weekName = (pos: CyclePosition, nowCycle: number) => (pos.cycle === nowCycle ? pos.week.label : `${pos.week.label} (cycle ${pos.cycle})`);

/**
 * What moving the plan by `weeks` would do, in one line, before tapping:
 * "Pushes the whole plan back a week: next Monday becomes Week 1 · Push."
 */
export function shiftEffect(program: Program, weeks: number, today: ISODate): string {
  const lead = weeks > 0 ? "Pushes the whole plan back a week" : "Pulls the whole plan forward a week";
  const { program: shifted, position, next } = previewCycleShift(program, weeks, today);
  const nowCycle = cyclePosition(program, today)?.cycle ?? 1;
  // Today falls in the plan afterwards: say which week this one turns into.
  if (position) return `${lead}: this week becomes ${weekName(position, nowCycle)}.`;
  // It doesn't (the first cycle starts later): say when it starts, and with what.
  if (next) return `${lead}: ${dayFromToday(next.date, today)} becomes ${weekName(next.position, nowCycle)} · ${next.day.label}.`;
  return `${lead}: the first cycle starts ${dayFromToday(shifted.cycleStartDate, today)}.`;
}

function ShiftAction({
  label,
  weeks,
  program,
  today,
  undoable,
}: {
  label: string;
  weeks: 1 | -1;
  program: Program;
  today: ISODate;
  undoable: UndoableProgram;
}) {
  const effectId = useId();
  const shifted = previewCycleShift(program, weeks, today).program;
  const was = program.cycleStartDate;
  return (
    <div className="py-3">
      <button
        type="button"
        className="btn-ghost"
        aria-describedby={effectId}
        disabled={shifted.cycleStartDate === was}
        onClick={() =>
          undoable({ cycleStartDate: shifted.cycleStartDate }, `Plan moved a week ${weeks > 0 ? "later" : "earlier"}`, () => ({
            cycleStartDate: was,
          }))
        }
      >
        {label}
      </button>
      <p id={effectId} className="mt-2 text-xs text-mute">
        {shiftEffect(program, weeks, today)}
      </p>
    </div>
  );
}

/**
 * Where the plan is today — cycle, week, the week's dates — and the controls that move it: the
 * cycle start date, and a week later / earlier in one tap (with Undo).
 */
export function CycleNow({ program, setProgram, undoable, today, id }: ProgramEdit & { undoable: UndoableProgram; today: ISODate }) {
  const pos = cyclePosition(program, today);
  const n = program.weeks.length;
  const startsIn = daysBetween(today, program.cycleStartDate);
  // "Week 2" as a week's name adds nothing next to "Week 2 of 5"; a name of its own ("Heavy") does.
  const ownLabel = pos && pos.week.label.trim().toLowerCase() !== `week ${pos.weekIndex + 1}` ? pos.week.label : null;
  const deloadNote = pos?.week.deload && !/deload/i.test(ownLabel ?? "") ? "Deload week" : null;
  return (
    <Section label="Now" id={id}>
      <div data-cycle-now="">
        {pos ? (
          <>
            <p className="text-2xl leading-tight font-light tracking-tight">
              Cycle {pos.cycle} <span aria-hidden>·</span> Week {pos.weekIndex + 1} of {n}
            </p>
            <p className="mt-1.5 text-sm text-mute">
              {(ownLabel || deloadNote) && <span className="text-fg-2">{[ownLabel, deloadNote].filter(Boolean).join(" · ")} · </span>}
              {formatShortDate(pos.weekStart)} – {formatShortDate(pos.weekEnd)} · cycle ends {formatShortDate(pos.cycleEnd)}
            </p>
          </>
        ) : (
          <>
            <p className="text-2xl leading-tight font-light tracking-tight">Starts {dayFromToday(program.cycleStartDate, today)}</p>
            <p className="mt-1.5 text-sm text-mute">
              Cycle 1 · Week 1 of {n} begins {weekdayName(program.cycleStartDate, true)} {formatShortDate(program.cycleStartDate)}
              {startsIn > 1 && `, in ${startsIn} days`}
            </p>
          </>
        )}
      </div>
      <div className="mt-3 divide-y divide-white/[0.04]">
        <Field label="Cycle start date" hint="Snaps to that week's Monday">
          <input
            type="date"
            value={program.cycleStartDate}
            onChange={(e) => isISODate(e.target.value) && setProgram({ cycleStartDate: snapCycleStart(e.target.value) })}
            className="field num rounded-xl bg-white/[0.05] px-3 py-2 text-base [color-scheme:dark]"
          />
        </Field>
        <ShiftAction label="Start a week later" weeks={1} program={program} today={today} undoable={undoable} />
        <ShiftAction label="Start a week earlier" weeks={-1} program={program} today={today} undoable={undoable} />
        {/* Long names need the full width: label above, the name below. */}
        <div className="py-3">
          <div className="text-sm text-fg-2">Program name</div>
          <InlineText
            ariaLabel="Program name"
            value={program.name}
            maxLength={60}
            required
            requiredMessage="Give the program a name."
            onCommit={(name) => setProgram({ name })}
            className="mt-1"
            inputClassName="text-base"
          />
        </div>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Weekly layout
// ---------------------------------------------------------------------------

export function WeeklyLayout({ program, setProgram, id }: ProgramEdit) {
  const { data } = useData();
  const tracked = data.exercises.filter((e) => e.tracksMax && !e.archived);
  return (
    <Section label="Weekly layout" id={id}>
      <div className="space-y-1">
        {WEEK_ORDER.map((wd) => {
          const day = program.days[String(wd)];
          const name = WEEKDAY_SHORT[wd]!;
          const setDay = (patch: Partial<NonNullable<typeof day>> | null) => {
            const days = { ...program.days };
            if (patch === null) delete days[String(wd)];
            else days[String(wd)] = { label: "Training", primaryExerciseId: null, progression: true, ...day, ...patch };
            setProgram({ days });
          };
          return (
            <div key={wd} className="py-3">
              <div className="flex items-center justify-between gap-3">
                <span className={clsx("w-10 shrink-0 text-sm", day ? "text-fg" : "text-mute")}>{name}</span>
                {day ? (
                  <InlineText
                    ariaLabel={`${name} session name`}
                    value={day.label}
                    maxLength={40}
                    required
                    requiredMessage="Name the session."
                    onCommit={(label) => setDay({ label })}
                    className="flex-1"
                    inputClassName="text-sm text-fg-2"
                  />
                ) : (
                  <span className="flex-1 text-sm text-mute">No lifting</span>
                )}
                <Toggle label={`${name} lifting day`} on={!!day} onChange={(v) => setDay(v ? {} : null)} />
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

export function CycleWeeks({ program, setProgram, undoable, id }: ProgramEdit & { undoable: UndoableProgram }) {
  const setWeek = (i: number, w: Partial<ProgramWeek>) =>
    setProgram({ weeks: program.weeks.map((x, j) => (j === i ? { ...x, ...w } : x)) });
  return (
    <Section label="Cycle weeks" id={id} right={<span className="label">{program.weeks.length}</span>}>
      <div className="space-y-6">
        {program.weeks.map((w, i) => (
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
                {program.weeks.length > 1 && (
                  <button
                    type="button"
                    aria-label={`Remove week ${i + 1}`}
                    className="tap -my-2 -mr-3 grid h-11 w-11 place-items-center text-mute"
                    onClick={() =>
                      // Undo runs from a toast, later: the week goes back into the weeks as they are then.
                      undoable({ weeks: program.weeks.filter((_, j) => j !== i) }, `Week ${i + 1} removed`, (now) => {
                        const weeks = [...now.weeks];
                        weeks.splice(Math.min(i, weeks.length), 0, w);
                        return { weeks };
                      })
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
        disabled={program.weeks.length >= 16}
        onClick={() =>
          setProgram({
            weeks: [...program.weeks, { label: `Week ${program.weeks.length + 1}`, deload: false, reps: [5, 5, 5, 5], basisReps: null }],
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
