import clsx from "clsx";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { ChevronLeft, Download, LogOut, Plus, RefreshCw, Trash2, UserX } from "lucide-react";
import { isISODate, startOfWeek, WEEKDAY_SHORT } from "../../shared/dates";
import { displayPrefs, trainingPrefs } from "../../shared/defaults";
import { repMaxPct } from "../../shared/program";
import { settingsSchema, type Program, type ProgramWeek, type Settings } from "../../shared/schemas";
import { InlineText } from "../components/InlineText";
import { useToast } from "../components/Toast";
import { useFocusAfter } from "../components/useFocusAfter";
import { formatRest, parseRest } from "../components/settings/restTime";
import { BoxNumber, Field, Section, Toggle, useFieldIds } from "../components/ui";
import { useTitle } from "../components/useTitle";
import { fmt } from "../lib/format";
import { forgetDevice, signOut, useCreateExercise, useData, useSaveSettings, useSyncInfo, useUpdateExercise } from "../lib/store";
import { noteOfflineSignOut } from "./Login";

// Weekday order shown Monday-first; values are JS weekday indices.
const ORDER = [1, 2, 3, 4, 5, 6, 0];

/** Human names for settings paths, so a rejected save reads "Steps target …", not "targets.steps: …". */
const PATH_NAMES: Array<[RegExp, string]> = [
  [/^targets\.steps/, "Steps target"],
  [/^targets\.zone2Minutes/, "Zone 2 minutes"],
  [/^nutrition\.proteinGPerLb/, "Protein"],
  [/^nutrition\.fatGPerLb/, "Fat"],
  [/^nutrition\.initialTdee/, "Maintenance estimate"],
  [/^nutrition\.kcalPerLb/, "Calories per lb"],
  [/^limits\.maxLoss/, "Max loss"],
  [/^limits\.maxGain/, "Max gain"],
  [/^program\.name/, "Program name"],
  [/^program\.intensity/, "Working weight"],
  [/^program\.roundToLb/, "Rounding"],
  [/^program\.progression/, "Per extra rep"],
  [/^program\.deloadAccessoryLoad/, "Deload accessories"],
  [/^program\.repMaxPct/, "Rep-max table"],
  [/^program\.weeks\.(\d+)/, "Week $1"],
  [/^program\.weeks/, "Cycle weeks"],
  [/^program\.days/, "Weekly layout"],
  [/^program\.cycleStartDate/, "Cycle start date"],
  [/^training\.restSecondsMain/, "Main lift rest"],
  [/^training\.restSecondsAccessory/, "Accessory rest"],
  [/^training\.accessoryIncrementLb/, "Accessory increment"],
];

/** A readable sentence for a schema issue. */
function readableIssue(issue: { path: PropertyKey[]; code: string; message: string } & Record<string, unknown>): string {
  const path = issue.path.join(".");
  let name = "That value";
  for (const [re, label] of PATH_NAMES) {
    const m = path.match(re);
    if (m) {
      name = label.replace("$1", String(Number(m[1] ?? 0) + 1));
      break;
    }
  }
  if (issue.code === "too_big" && typeof issue.maximum === "number")
    return `${name} can be at most ${fmt(issue.maximum, 2).replace(/\.?0+$/, "")}.`;
  if (issue.code === "too_small" && typeof issue.minimum === "number")
    return `${name} must be at least ${fmt(issue.minimum, 2).replace(/\.?0+$/, "")}.`;
  if (issue.code === "invalid_type") return `${name} needs a number.`;
  return `${name}: ${issue.message.toLowerCase()}.`;
}

/** Inline range check for a number setting; returns a message or null. */
function rangeError(
  v: number | null,
  min: number,
  max: number,
  opts: { unit?: string; optional?: boolean; integer?: boolean } = {},
): string | null {
  if (v === null) return opts.optional ? null : "Enter a number.";
  const u = opts.unit ?? "";
  if (v < min || v > max) return `Between ${fmt(min, min % 1 ? 1 : 0)}${u} and ${fmt(max, max % 1 ? 1 : 0)}${u}.`;
  if (opts.integer && !Number.isInteger(v)) return "Whole numbers only.";
  return null;
}

/**
 * A Field with a BoxNumber that validates on commit: an out-of-range value stays visible with an
 * inline message (and isn't saved) until it's fixed.
 */
function NumSetting({
  label,
  hint,
  value,
  onSave,
  min,
  max,
  unit,
  decimals = 0,
  optional,
  integer,
  placeholder,
  grouping,
  unitInMessage,
}: {
  label: ReactNode;
  hint?: ReactNode;
  value: number | null;
  onSave: (v: number | null) => void;
  min: number;
  max: number;
  unit?: string;
  decimals?: number;
  optional?: boolean;
  integer?: boolean;
  placeholder?: string;
  grouping?: boolean;
  unitInMessage?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <Field label={label} hint={hint} error={error}>
      <BoxNumber
        ariaLabel={typeof label === "string" ? label : "Value"}
        value={value}
        unit={unit}
        decimals={decimals}
        placeholder={placeholder}
        grouping={grouping}
        onCommit={(v) => {
          const e = rangeError(v, min, max, { unit: unitInMessage, optional, integer });
          setError(e);
          if (!e) onSave(v);
        }}
      />
    </Field>
  );
}

/** A rest time, shown and typed as m:ss ("3:00"); plain seconds ("180") work too. */
function RestSetting({
  label,
  hint,
  value,
  onSave,
  min,
  max,
}: {
  label: string;
  hint?: ReactNode;
  value: number;
  onSave: (seconds: number) => void;
  min: number;
  max: number;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <Field label={label} hint={hint} error={error}>
      <RestInput
        label={label}
        value={value}
        onCommit={(text) => {
          const v = parseRest(text);
          const e =
            v === null
              ? "Enter a time like 3:00, or seconds."
              : v < min || v > max
                ? `Between ${formatRest(min)} and ${formatRest(max)}.`
                : null;
          setError(e);
          if (e || v === null) return false;
          if (v !== value) onSave(v);
          return true;
        }}
      />
    </Field>
  );
}

function RestInput({ label, value, onCommit }: { label: string; value: number; onCommit: (text: string) => boolean }) {
  const field = useFieldIds();
  const [text, setText] = useState(formatRest(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(formatRest(value));
  }, [value]);
  return (
    <span className="box-field inline-flex rounded-xl bg-white/[0.05] px-3 py-2">
      <input
        aria-label={label}
        aria-labelledby={field?.labelId}
        aria-describedby={field?.describedBy}
        aria-invalid={field?.invalid || undefined}
        value={text}
        placeholder="m:ss"
        autoComplete="off"
        enterKeyHint="done"
        onFocus={(e) => {
          focused.current = true;
          e.currentTarget.select();
        }}
        onBlur={() => {
          focused.current = false;
          // Valid: show it tidied ("180" → "3:00"); invalid: keep what was typed next to the message.
          if (onCommit(text)) setText(formatRest(parseRest(text)!));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        onChange={(e) => setText(e.target.value)}
        className="field num w-[5.5ch] min-w-0 text-right text-base"
      />
    </span>
  );
}

/** The long page's sections, as a jump list under the title. */
const JUMPS = [
  ["targets", "Targets"],
  ["training", "Training"],
  ["display", "Display"],
  ["program", "Program"],
  ["sync", "Sync"],
  ["data", "Data"],
] as const;

function JumpList() {
  return (
    <nav aria-label="Settings sections" className="mt-4 -ml-1.5">
      <ul className="flex flex-wrap items-center gap-x-3">
        {JUMPS.map(([id, name]) => (
          <li key={id}>
            <a
              href={`#${id}`}
              className="label inline-flex min-h-11 items-center px-1.5 text-fg-2"
              onClick={(e) => {
                const section = document.getElementById(id);
                if (!section) return;
                e.preventDefault();
                const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
                section.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
                // Keyboard and screen-reader users continue from the section's heading.
                section.querySelector<HTMLElement>("[data-section-heading]")?.focus({ preventScroll: true });
                history.replaceState(history.state, "", `#${id}`);
              }}
            >
              {name}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function SettingsScreen() {
  const { data } = useData();
  const saveSettings = useSaveSettings();
  const s = data.settings;
  const [error, setError] = useState<string | null>(null);
  useTitle("Settings");

  const save = (next: Settings) => {
    // Validate here with the server's own schema, so a bad value never leaves the device.
    const r = settingsSchema.safeParse(next);
    if (!r.success) {
      setError(readableIssue(r.error.issues[0] as unknown as Parameters<typeof readableIssue>[0]));
      return;
    }
    setError(null);
    saveSettings(next).catch((e: unknown) => setError(e instanceof Error ? e.message : "Couldn't save."));
  };
  const setProgram = (p: Partial<Program>) => save({ ...s, program: { ...s.program, ...p } });
  const training = trainingPrefs(s);
  const setTraining = (t: Partial<typeof training>) => save({ ...s, training: { ...training, ...t } });
  const display = displayPrefs(s);

  return (
    <div>
      <header className="flex items-center gap-2 pt-2">
        <Link to="/" aria-label="Back" className="tap -my-2 -ml-3 grid h-11 w-11 place-items-center text-mute">
          <ChevronLeft size={18} />
        </Link>
        <div className="label text-fg-2">Settings</div>
      </header>
      <h1 className="mt-6 text-[2.75rem] leading-none font-light tracking-tight">The rules</h1>
      <p className="mt-3 text-sm text-mute">Nothing here is set in stone. Change it and everything recalculates.</p>
      <JumpList />
      {error && (
        <p role="alert" className="mt-4 text-sm text-warn">
          {error}
        </p>
      )}

      <Section label="Daily targets" id="targets">
        <div className="divide-y divide-white/[0.04]">
          <NumSetting
            label="Steps"
            value={s.targets.steps}
            min={0}
            max={100_000}
            integer
            grouping
            onSave={(v) => v !== null && save({ ...s, targets: { ...s.targets, steps: v } })}
          />
          <NumSetting
            label="Zone 2"
            hint="Default duration when you check it off"
            value={s.targets.zone2Minutes}
            unit="min"
            min={0}
            max={600}
            unitInMessage=" min"
            onSave={(v) => v !== null && save({ ...s, targets: { ...s.targets, zone2Minutes: v } })}
          />
        </div>
      </Section>

      <Section label="Schedule">
        <DayPicker label="Metcon" value={s.schedule.metcon} onChange={(metcon) => save({ ...s, schedule: { ...s.schedule, metcon } })} />
        <div className="h-6" />
        <DayPicker label="Zone 2" value={s.schedule.zone2} onChange={(zone2) => save({ ...s, schedule: { ...s.schedule, zone2 } })} />
      </Section>

      <Section label="Nutrition">
        <div className="divide-y divide-white/[0.04]">
          <NumSetting
            label="Protein"
            hint="Grams per lb of trend bodyweight"
            value={s.nutrition.proteinGPerLb}
            decimals={2}
            unit="g/lb"
            min={0}
            max={3}
            unitInMessage=" g"
            onSave={(v) => v !== null && save({ ...s, nutrition: { ...s.nutrition, proteinGPerLb: v } })}
          />
          <NumSetting
            label="Fat"
            hint="Grams per lb; carbs fill the rest"
            value={s.nutrition.fatGPerLb}
            decimals={2}
            unit="g/lb"
            min={0}
            max={2}
            unitInMessage=" g"
            onSave={(v) => v !== null && save({ ...s, nutrition: { ...s.nutrition, fatGPerLb: v } })}
          />
          <NumSetting
            label="Maintenance estimate"
            hint="Blended in while the TDEE calibrates. Leave empty for auto."
            value={s.nutrition.initialTdee}
            unit="kcal"
            placeholder="auto"
            optional
            grouping
            min={800}
            max={10_000}
            onSave={(v) => save({ ...s, nutrition: { ...s.nutrition, initialTdee: v } })}
          />
          <NumSetting
            label="Calories per lb"
            hint="Energy in a pound of bodyweight change"
            value={s.nutrition.kcalPerLb}
            unit="kcal"
            grouping
            min={1000}
            max={6000}
            onSave={(v) => v !== null && save({ ...s, nutrition: { ...s.nutrition, kcalPerLb: v } })}
          />
          <NumSetting
            label="Max loss"
            hint="% bodyweight per week"
            value={s.limits.maxLossPctPerWeek}
            decimals={2}
            unit="%"
            min={0}
            max={3}
            unitInMessage="%"
            onSave={(v) => v !== null && save({ ...s, limits: { ...s.limits, maxLossPctPerWeek: v } })}
          />
          <NumSetting
            label="Max gain"
            hint="% bodyweight per week"
            value={s.limits.maxGainPctPerWeek}
            decimals={2}
            unit="%"
            min={0}
            max={3}
            unitInMessage="%"
            onSave={(v) => v !== null && save({ ...s, limits: { ...s.limits, maxGainPctPerWeek: v } })}
          />
        </div>
      </Section>

      <Section label="Training" id="training">
        <div className="divide-y divide-white/[0.04]">
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
          <NumSetting
            label="Accessory increment"
            hint="Suggested jump after hitting every rep. 0 turns hints off."
            value={training.accessoryIncrementLb}
            decimals={1}
            unit="lb"
            min={0}
            max={50}
            unitInMessage=" lb"
            onSave={(v) => v !== null && setTraining({ accessoryIncrementLb: v })}
          />
        </div>
      </Section>

      <Section label="Display" id="display">
        <Field label="High contrast" hint="Brighter text and stronger edges for gym glare and sunlight">
          <Toggle
            label="High contrast"
            on={display.highContrast}
            onChange={(v) => save({ ...s, display: { ...display, highContrast: v } })}
          />
        </Field>
      </Section>

      <ProgramEditor program={s.program} setProgram={setProgram} />

      <LiftsEditor />

      <SyncSection />

      <Section label="Data" id="data">
        <div className="flex flex-wrap gap-3">
          <a href="/api/export" className="btn-ghost" download>
            <Download size={16} /> Export JSON
          </a>
          <SignOut />
        </div>
        <ForgetDevice />
      </Section>
      {/* decor: a sign-off, not information */}
      <p className="mt-12 text-center text-[0.6875rem] text-faint">Strawvine · built for pushing boundaries</p>
    </div>
  );
}

function DayPicker({ label, value, onChange }: { label: string; value: boolean[]; onChange: (v: boolean[]) => void }) {
  return (
    <div role="group" aria-label={`${label} days`}>
      <div className="mb-1 text-sm text-fg-2">{label}</div>
      {/* Seven equal cells: each is a full 44px-tall target around a small round day. */}
      <div className="grid max-w-sm grid-cols-7">
        {ORDER.map((d) => (
          <button
            key={d}
            type="button"
            aria-pressed={value[d]}
            aria-label={WEEKDAY_SHORT[d]}
            onClick={() => onChange(value.map((x, i) => (i === d ? !x : x)))}
            className="tap grid h-11 place-items-center"
          >
            <span
              className={clsx(
                // 32px round; shrinks (never overlaps its neighbour) when seven don't fit.
                "grid aspect-square w-full max-w-8 place-items-center rounded-full text-[0.6875rem] font-medium",
                value[d] ? "bg-accent text-accent-ink" : "bg-white/[0.04] text-mute",
              )}
            >
              {WEEKDAY_SHORT[d]![0]}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

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

function ProgramEditor({ program, setProgram }: { program: Program; setProgram: (p: Partial<Program>) => void }) {
  const { data } = useData();
  const toast = useToast();
  const tracked = data.exercises.filter((e) => e.tracksMax && !e.archived);
  const setWeek = (i: number, w: Partial<ProgramWeek>) =>
    setProgram({ weeks: program.weeks.map((x, j) => (j === i ? { ...x, ...w } : x)) });
  const tableReps = Object.keys(program.repMaxPct)
    .map(Number)
    .sort((a, b) => a - b);
  // Undo runs from a toast, later: restore into the program as it is then.
  const latest = useRef(program);
  latest.current = program;

  return (
    <>
      <Section label="Program" id="program">
        <div className="divide-y divide-white/[0.04]">
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
          <Field label="Cycle start date" hint="Snaps to that week's Monday">
            <input
              type="date"
              value={program.cycleStartDate}
              onChange={(e) => isISODate(e.target.value) && setProgram({ cycleStartDate: startOfWeek(e.target.value) })}
              className="field num rounded-xl bg-white/[0.05] px-3 py-2 text-base [color-scheme:dark]"
            />
          </Field>
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
        </div>
      </Section>

      <Section label="Cycle weeks" right={<span className="label">{program.weeks.length}</span>}>
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
                      onClick={() => {
                        setProgram({ weeks: program.weeks.filter((_, j) => j !== i) });
                        toast.show({
                          message: `Week ${i + 1} removed`,
                          action: {
                            label: "Undo",
                            onAction: () => {
                              const weeks = [...latest.current.weeks];
                              weeks.splice(Math.min(i, weeks.length), 0, w);
                              setProgram({ weeks });
                            },
                          },
                        });
                      }}
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

      <Section label="Weekly layout">
        <div className="space-y-1">
          {ORDER.map((wd) => {
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

      <Section label="Rep-max table">
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
    </>
  );
}

function LiftsEditor() {
  const { data } = useData();
  const toast = useToast();
  const updateExercise = useUpdateExercise();
  const createExercise = useCreateExercise();
  const [name, setName] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const list = data.exercises.filter((e) => showArchived || !e.archived);
  return (
    <Section
      label="Exercise library"
      right={
        <button
          type="button"
          aria-pressed={showArchived}
          className="label hit -my-2 py-2 text-mute"
          onClick={() => setShowArchived(!showArchived)}
        >
          {showArchived ? "hide archived" : "show archived"}
        </button>
      }
    >
      <div className="divide-y divide-white/[0.04]">
        {list.map((e) => (
          <div key={e.id} className={clsx("flex items-center gap-3 py-2", e.archived && "opacity-50")}>
            <InlineText
              ariaLabel={`Rename ${e.name}`}
              value={e.name}
              maxLength={80}
              required
              requiredMessage="A lift needs a name."
              onCommit={(name) => void updateExercise(e.id, { name })}
              className="flex-1"
              inputClassName="text-sm"
            />
            <button
              type="button"
              aria-pressed={e.tracksMax}
              aria-label={`${e.name}: track max`}
              onClick={() => void updateExercise(e.id, { tracksMax: !e.tracksMax })}
              className={clsx("chip", e.tracksMax ? "bg-accent/15 text-accent" : "bg-white/[0.04] text-mute")}
            >
              max
            </button>
            <button
              type="button"
              aria-label={`${e.name}: ${e.archived ? "restore" : "archive"}`}
              onClick={() => {
                const archived = !e.archived;
                void updateExercise(e.id, { archived });
                if (archived && !showArchived)
                  toast.show({
                    message: `${e.name} archived`,
                    action: { label: "Undo", onAction: () => void updateExercise(e.id, { archived: false }) },
                  });
              }}
              className="chip bg-white/[0.04] text-mute"
            >
              {e.archived ? "restore" : "archive"}
            </button>
          </div>
        ))}
      </div>
      <div className="mt-4 flex gap-3">
        <input
          aria-label="New lift name"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          placeholder="New lift…"
          className="field min-w-0 flex-1 rounded-xl bg-white/[0.05] px-3 py-2 text-base"
        />
        <button
          type="button"
          disabled={!name.trim()}
          className="btn-ghost shrink-0"
          onClick={async () => {
            await createExercise({ name: name.trim(), category: "primary", measure: "reps", tracksMax: true });
            setName("");
          }}
        >
          <Plus size={16} /> Tracked lift
        </button>
      </div>
    </Section>
  );
}

/**
 * Sign out. Edits that haven't reached the server yet are the one thing a sign-out can lose, so
 * with any pending it first asks whether to keep them on this device (they sync after the next
 * sign-in) or discard them. Offline, the device signs out at once and the server side is
 * finished on the next contact — the sign-in screen says so (see `noteOfflineSignOut`).
 */
function SignOut() {
  const info = useSyncInfo();
  const navigate = useNavigate();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const focusAfter = useFocusAfter();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstChoiceRef = useRef<HTMLButtonElement>(null);
  const questionId = useId();

  const run = async (keepUnsynced: boolean) => {
    setBusy(true);
    setFailed(false);
    // signOut switches the app to the sign-in screen at once (the server call finishes after);
    // land on Today when signing back in, not here.
    const pending = signOut({ keepUnsynced });
    navigate("/", { replace: true });
    let r: Awaited<ReturnType<typeof signOut>>;
    try {
      r = await pending;
    } catch {
      setBusy(false);
      setFailed(true);
      return;
    }
    // Offline, this device is signed out and the server side finishes on the next contact.
    if (!r.ok && r.reason === "offline") noteOfflineSignOut();
  };

  // Count rejected-but-unsaved edits too: discarding them at sign-out loses them just the same.
  const unsynced = info.unsynced ?? info.pending;
  if (asking && unsynced > 0)
    return (
      <div role="group" aria-labelledby={questionId} className="w-full rounded-2xl bg-white/[0.03] p-4">
        <p id={questionId} className="text-sm text-fg-2">
          {unsynced} {unsynced === 1 ? "change hasn't" : "changes haven't"} synced.
        </p>
        <p className="mt-1 text-xs text-mute">Keep them on this device to sync after you sign back in, or discard them.</p>
        <div className="mt-4 flex flex-wrap gap-3">
          <button ref={firstChoiceRef} type="button" className="btn-ghost" disabled={busy} onClick={() => void run(true)}>
            Keep on this device
          </button>
          <button type="button" className="btn-ghost text-warn" disabled={busy} onClick={() => void run(false)}>
            Discard
          </button>
          <button
            type="button"
            className="btn text-mute"
            disabled={busy}
            onClick={() => {
              setAsking(false);
              focusAfter(() => triggerRef.current);
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="btn-ghost"
        disabled={busy}
        onClick={() => {
          if (unsynced > 0) {
            setAsking(true);
            focusAfter(() => firstChoiceRef.current);
          } else void run(false);
        }}
      >
        <LogOut size={16} /> {busy ? "Signing out…" : "Sign out"}
      </button>
      {failed && (
        <p role="alert" className="w-full text-xs text-warn">
          Couldn't sign out. Try again.
        </p>
      )}
    </>
  );
}

/** "just now" / "2 min ago" / "3 h ago" / a date — for "synced …". */
function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Sync status, what's waiting to reach the server, and what the server rejected. */
function SyncSection() {
  const info = useSyncInfo();
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => setNow(Date.now()), [info.lastSyncedAt]);

  const synced = info.lastSyncedAt !== null ? `synced ${ago(info.lastSyncedAt, now)}` : "not synced yet";
  const parts: string[] = [];
  if (info.pending) parts.push(`${info.pending} pending`);
  if (info.failed) parts.push(`${info.failed} not saved`);
  if (!info.online) parts.push("offline");
  const status = parts.length ? parts.join(" · ") : `All changes saved · ${synced}`;
  const tone = info.failed ? "text-warn" : "text-fg-2";

  return (
    <Section label="Sync" id="sync">
      <p className={clsx("flex items-center gap-2 text-sm", tone)} role="status" aria-live="polite">
        <span
          aria-hidden
          className={clsx(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            info.failed ? "bg-warn" : !info.online ? "bg-faint" : info.pending ? "animate-pulse bg-accent" : "bg-accent",
          )}
        />
        {status}
      </p>
      {parts.length > 0 && <p className="mt-1 pl-3.5 text-xs text-mute">Last {synced}.</p>}
      {info.items.length > 0 && (
        <ul className="mt-4 divide-y divide-white/[0.04]" aria-label="Unsynced changes">
          {info.items.map((it) => (
            <li key={it.id} className="flex items-baseline justify-between gap-3 py-2.5">
              <span className="min-w-0 text-sm text-fg-2">
                {it.label}
                {it.failed && it.error && <span className="mt-0.5 block text-xs text-mute">{it.error}</span>}
              </span>
              <span className={clsx("label shrink-0", it.failed && "text-warn")}>{it.failed ? "not saved" : "pending"}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          className="btn-ghost"
          disabled={!info.online || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await info.syncNow();
            } finally {
              setBusy(false);
            }
          }}
        >
          <RefreshCw size={16} className={clsx(busy && "animate-spin")} aria-hidden /> {busy ? "Syncing…" : "Sync now"}
        </button>
        {info.failed > 0 && (
          <>
            <button type="button" className="btn-ghost text-accent" onClick={info.retryFailed}>
              Retry failed
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                if (window.confirm(`Discard ${info.failed} change${info.failed === 1 ? "" : "s"} the server rejected?`))
                  info.discardFailed();
              }}
            >
              Discard failed
            </button>
          </>
        )}
      </div>
      {!info.online && <p className="mt-2 text-xs text-mute">Changes are kept on this device and sync when you're back online.</p>}
      <RefusedEdits now={now} />
    </Section>
  );
}

/**
 * Edits this device refused before queuing them (they would have been rejected by the server,
 * e.g. a value out of range from an old screen): what, why and when — the toast that said so is
 * long gone. Clear empties the list.
 */
function RefusedEdits({ now }: { now: number }) {
  const info = useSyncInfo();
  const focusAfter = useFocusAfter();
  const refused = info.refused;
  if (!refused.length) return null;
  return (
    <div className="mt-8" role="group" aria-labelledby="refused-heading" data-refused="">
      <div className="flex items-center justify-between gap-3">
        <h3 id="refused-heading" className="text-sm text-warn">
          Couldn't save
        </h3>
        <button
          type="button"
          className="label -my-3 -mr-2 inline-flex min-h-11 items-center px-2 text-mute"
          onClick={() => {
            info.clearRefused();
            // The list (and this button) go away: continue from the Sync section's heading.
            focusAfter(() => document.querySelector<HTMLElement>("#sync [data-section-heading]"));
          }}
        >
          Clear
        </button>
      </div>
      <p className="mt-1 text-xs text-mute">
        These edits weren't saved: the values weren't allowed. Enter them again if you still need them.
      </p>
      <ul className="mt-3 divide-y divide-white/[0.04]" aria-label="Edits that couldn't be saved">
        {[...refused].reverse().map((r) => (
          <li key={r.id} className="flex items-baseline justify-between gap-3 py-2.5">
            <span className="min-w-0 text-sm text-fg-2">
              {r.label}
              <span className="mt-0.5 block text-xs text-mute">{r.reason}</span>
            </span>
            <span className="label shrink-0">{ago(r.at, now)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * "Forget this device": the server signs this browser out and drops its known-device mark, so
 * the next sign-in is treated like a new device's; this device's copy (and anything not yet
 * synced) is wiped. Asks first, inline, saying how many unsynced edits would be lost. On
 * success the app is at the sign-in screen (landing on Today afterwards); offline or refused,
 * nothing changes and it says so.
 */
function ForgetDevice() {
  const info = useSyncInfo();
  const navigate = useNavigate();
  const [asking, setAsking] = useState(false);
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");
  const focusAfter = useFocusAfter();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const questionId = useId();
  const unsynced = info.unsynced ?? info.pending;

  if (asking)
    return (
      <div role="group" aria-labelledby={questionId} className="mt-4 w-full rounded-2xl bg-white/[0.03] p-4">
        <p id={questionId} className="text-sm text-fg-2">
          Forget this device?
        </p>
        <p className="mt-1 text-xs leading-relaxed text-mute">
          This signs this device out and removes its copy of your data. It will be treated as a new device at the next sign-in. Everything
          stays on the server, and your other devices stay signed in.
        </p>
        {unsynced > 0 && (
          <p className="mt-2 text-xs text-warn">
            {unsynced} {unsynced === 1 ? "change hasn't synced and will be discarded" : "changes haven't synced and will be discarded"}{" "}
            (unless {unsynced === 1 ? "it goes" : "they go"} through first).
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            ref={confirmRef}
            type="button"
            className="btn-ghost text-warn"
            disabled={state === "busy"}
            onClick={async () => {
              setState("busy");
              try {
                await forgetDevice();
              } catch {
                setState("failed");
                return;
              }
              // Signed out: land on Today after the next sign-in, not here.
              navigate("/", { replace: true });
            }}
          >
            {state === "busy" ? "Forgetting…" : "Forget"}
          </button>
          <button
            type="button"
            className="btn text-mute"
            disabled={state === "busy"}
            onClick={() => {
              setAsking(false);
              setState("idle");
              focusAfter(() => triggerRef.current);
            }}
          >
            Cancel
          </button>
        </div>
        {state === "failed" && (
          <p role="alert" className="mt-3 text-xs text-warn">
            Couldn't reach Strawvine — try again when online. Nothing changed.
          </p>
        )}
      </div>
    );

  return (
    <div className="mt-4">
      <button
        ref={triggerRef}
        type="button"
        className="btn-ghost"
        onClick={() => {
          setAsking(true);
          setState("idle");
          focusAfter(() => confirmRef.current);
        }}
      >
        <UserX size={16} aria-hidden /> Forget this device
      </button>
    </div>
  );
}
