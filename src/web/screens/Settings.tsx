import clsx from "clsx";
import { useState } from "react";
import { Link } from "react-router";
import { ChevronLeft, Download, LogOut, Plus, Trash2 } from "lucide-react";
import { isISODate, startOfWeek, WEEKDAY_SHORT } from "../../shared/dates";
import { repMaxPct } from "../../shared/program";
import type { Program, ProgramWeek, Settings } from "../../shared/schemas";
import { BoxNumber, Field, Section, Toggle } from "../components/ui";
import { api } from "../lib/api";
import { clearCache, useCreateExercise, useData, useSaveSettings, useUpdateExercise } from "../lib/store";

// Weekday order shown Monday-first; values are JS weekday indices.
const ORDER = [1, 2, 3, 4, 5, 6, 0];

export function SettingsScreen() {
  const { data } = useData();
  const saveSettings = useSaveSettings();
  const s = data.settings;
  const [error, setError] = useState<string | null>(null);

  const save = (next: Settings) => {
    setError(null);
    saveSettings(next).catch((e: unknown) => setError(e instanceof Error ? e.message : "Couldn't save."));
  };
  const setProgram = (p: Partial<Program>) => save({ ...s, program: { ...s.program, ...p } });

  return (
    <div>
      <header className="flex items-center gap-2 pt-2">
        <Link to="/" aria-label="Back" className="tap -ml-2 p-2 text-mute">
          <ChevronLeft size={18} />
        </Link>
        <div className="label text-fg-2">Settings</div>
      </header>
      <h1 className="mt-6 text-[44px] leading-none font-light tracking-tight">The rules</h1>
      <p className="mt-3 text-sm text-mute">Nothing here is set in stone. Change it and everything recalculates.</p>
      {error && <p className="mt-4 text-sm text-warn">{error}</p>}

      <Section label="Daily targets">
        <div className="divide-y divide-white/[0.04]">
          <Field label="Steps">
            <BoxNumber
              ariaLabel="Steps target"
              value={s.targets.steps}
              onCommit={(v) => v !== null && save({ ...s, targets: { ...s.targets, steps: v } })}
            />
          </Field>
          <Field label="Zone 2" hint="Default duration when you check it off">
            <BoxNumber
              ariaLabel="Zone 2 minutes"
              value={s.targets.zone2Minutes}
              unit="min"
              onCommit={(v) => v !== null && save({ ...s, targets: { ...s.targets, zone2Minutes: v } })}
            />
          </Field>
        </div>
      </Section>

      <Section label="Schedule">
        <DayPicker label="Metcon" value={s.schedule.metcon} onChange={(metcon) => save({ ...s, schedule: { ...s.schedule, metcon } })} />
        <div className="h-5" />
        <DayPicker label="Zone 2" value={s.schedule.zone2} onChange={(zone2) => save({ ...s, schedule: { ...s.schedule, zone2 } })} />
      </Section>

      <Section label="Nutrition">
        <div className="divide-y divide-white/[0.04]">
          <Field label="Protein" hint="Grams per lb of trend bodyweight">
            <BoxNumber
              ariaLabel="Protein per lb"
              value={s.nutrition.proteinGPerLb}
              decimals={2}
              unit="g/lb"
              onCommit={(v) => v !== null && save({ ...s, nutrition: { ...s.nutrition, proteinGPerLb: v } })}
            />
          </Field>
          <Field label="Fat" hint="Grams per lb; carbs fill the rest">
            <BoxNumber
              ariaLabel="Fat per lb"
              value={s.nutrition.fatGPerLb}
              decimals={2}
              unit="g/lb"
              onCommit={(v) => v !== null && save({ ...s, nutrition: { ...s.nutrition, fatGPerLb: v } })}
            />
          </Field>
          <Field label="Maintenance estimate" hint="Blended in while the TDEE calibrates">
            <BoxNumber
              ariaLabel="Maintenance estimate"
              value={s.nutrition.initialTdee}
              unit="kcal"
              placeholder="auto"
              onCommit={(v) => save({ ...s, nutrition: { ...s.nutrition, initialTdee: v } })}
            />
          </Field>
          <Field label="Energy per lb">
            <BoxNumber
              ariaLabel="Calories per pound"
              value={s.nutrition.kcalPerLb}
              unit="kcal"
              onCommit={(v) => v !== null && save({ ...s, nutrition: { ...s.nutrition, kcalPerLb: v } })}
            />
          </Field>
          <Field label="Max loss" hint="% bodyweight per week">
            <BoxNumber
              ariaLabel="Max loss per week"
              value={s.limits.maxLossPctPerWeek}
              decimals={2}
              unit="%"
              onCommit={(v) => v !== null && save({ ...s, limits: { ...s.limits, maxLossPctPerWeek: v } })}
            />
          </Field>
          <Field label="Max gain" hint="% bodyweight per week">
            <BoxNumber
              ariaLabel="Max gain per week"
              value={s.limits.maxGainPctPerWeek}
              decimals={2}
              unit="%"
              onCommit={(v) => v !== null && save({ ...s, limits: { ...s.limits, maxGainPctPerWeek: v } })}
            />
          </Field>
        </div>
      </Section>

      <ProgramEditor program={s.program} setProgram={setProgram} />

      <LiftsEditor />

      <Section label="Data">
        <div className="flex flex-wrap gap-3">
          <a href="/api/export" className="btn-ghost" download>
            <Download size={16} /> Export JSON
          </a>
          <button
            type="button"
            className="btn-ghost"
            onClick={async () => {
              await api("/auth/logout", { method: "POST" }).catch(() => {});
              clearCache();
              window.location.href = "/";
            }}
          >
            <LogOut size={16} /> Sign out
          </button>
        </div>
      </Section>
      <p className="mt-12 text-center text-[11px] text-faint">Strawvine · built for pushing boundaries</p>
    </div>
  );
}

function DayPicker({ label, value, onChange }: { label: string; value: boolean[]; onChange: (v: boolean[]) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-fg-2">{label}</span>
      <div className="flex gap-1">
        {ORDER.map((d) => (
          <button
            key={d}
            type="button"
            aria-pressed={value[d]}
            aria-label={`${label} on ${WEEKDAY_SHORT[d]}`}
            onClick={() => onChange(value.map((x, i) => (i === d ? !x : x)))}
            className={clsx(
              "tap grid h-8 w-8 place-items-center rounded-full text-[11px] font-medium",
              value[d] ? "bg-accent text-accent-ink" : "bg-white/[0.04] text-mute",
            )}
          >
            {WEEKDAY_SHORT[d]![0]}
          </button>
        ))}
      </div>
    </div>
  );
}

function RepsInput({ value, onCommit, ariaLabel }: { value: number[]; onCommit: (v: number[]) => void; ariaLabel: string }) {
  const [text, setText] = useState(value.join(", "));
  return (
    <input
      aria-label={ariaLabel}
      value={text}
      inputMode="numeric"
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const reps = text
          .split(/[\s,/]+/)
          .map(Number)
          .filter((n) => Number.isInteger(n) && n > 0 && n <= 50);
        if (reps.length) onCommit(reps);
        setText((reps.length ? reps : value).join(", "));
      }}
      className="field num w-full rounded-xl bg-white/[0.05] px-3 py-2 text-sm"
    />
  );
}

function ProgramEditor({ program, setProgram }: { program: Program; setProgram: (p: Partial<Program>) => void }) {
  const { data } = useData();
  const tracked = data.exercises.filter((e) => e.tracksMax && !e.archived);
  const setWeek = (i: number, w: Partial<ProgramWeek>) =>
    setProgram({ weeks: program.weeks.map((x, j) => (j === i ? { ...x, ...w } : x)) });
  const tableReps = Object.keys(program.repMaxPct)
    .map(Number)
    .sort((a, b) => a - b);

  return (
    <>
      <Section label="Program">
        <div className="divide-y divide-white/[0.04]">
          <Field label="Name">
            <input
              aria-label="Program name"
              defaultValue={program.name}
              onBlur={(e) => e.target.value.trim() && e.target.value !== program.name && setProgram({ name: e.target.value.trim() })}
              className="field w-44 rounded-xl bg-white/[0.05] px-3 py-2 text-right text-sm"
            />
          </Field>
          <Field label="Cycle 1 starts" hint="Snaps to that week's Monday">
            <input
              type="date"
              aria-label="Cycle start date"
              value={program.cycleStartDate}
              onChange={(e) => isISODate(e.target.value) && setProgram({ cycleStartDate: startOfWeek(e.target.value) })}
              className="field num rounded-xl bg-white/[0.05] px-3 py-2 text-sm [color-scheme:dark]"
            />
          </Field>
          <Field label="Working weight" hint="% of the N-rep max">
            <BoxNumber
              ariaLabel="Working weight percent"
              value={Math.round(program.intensity * 100)}
              unit="%"
              onCommit={(v) => v !== null && setProgram({ intensity: v / 100 })}
            />
          </Field>
          <Field label="Round to">
            <BoxNumber
              ariaLabel="Rounding increment"
              value={program.roundToLb}
              decimals={1}
              unit="lb"
              onCommit={(v) => v !== null && v > 0 && setProgram({ roundToLb: v })}
            />
          </Field>
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
            <Field label="Per extra rep">
              <BoxNumber
                ariaLabel="Pounds per extra rep"
                value={program.progression.lbPerExtraRep}
                decimals={1}
                unit="lb"
                onCommit={(v) => v !== null && setProgram({ progression: { ...program.progression, lbPerExtraRep: v } })}
              />
            </Field>
          )}
          <Field label="Deload accessories" hint="% of normal load">
            <BoxNumber
              ariaLabel="Deload accessory load"
              value={Math.round(program.deloadAccessoryLoad * 100)}
              unit="%"
              onCommit={(v) => v !== null && setProgram({ deloadAccessoryLoad: v / 100 })}
            />
          </Field>
        </div>
      </Section>

      <Section label="Cycle weeks" right={<span className="label text-faint">{program.weeks.length}</span>}>
        <div className="space-y-5">
          {program.weeks.map((w, i) => (
            <div key={i}>
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="label w-5 text-accent">{String(i + 1).padStart(2, "0")}</span>
                  <input
                    aria-label={`Week ${i + 1} label`}
                    defaultValue={w.label}
                    onBlur={(e) => e.target.value !== w.label && setWeek(i, { label: e.target.value })}
                    className="field w-28 text-sm"
                  />
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-mute">Deload</span>
                  <Toggle
                    label={`Week ${i + 1} deload`}
                    on={w.deload}
                    onChange={(v) => setWeek(i, { deload: v, basisReps: v ? (w.basisReps ?? 12) : null })}
                  />
                  {program.weeks.length > 1 && (
                    <button
                      type="button"
                      aria-label={`Remove week ${i + 1}`}
                      className="tap p-1 text-faint"
                      onClick={() => setProgram({ weeks: program.weeks.filter((_, j) => j !== i) })}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3 pl-7">
                <div className="flex-1">
                  <RepsInput
                    key={w.reps.join()}
                    ariaLabel={`Week ${i + 1} reps`}
                    value={w.reps}
                    onCommit={(reps) => setWeek(i, { reps })}
                  />
                </div>
                {w.deload && (
                  <div className="flex items-center gap-2 text-xs text-mute">
                    @{" "}
                    <BoxNumber
                      ariaLabel={`Week ${i + 1} basis reps`}
                      value={w.basisReps}
                      onCommit={(v) => setWeek(i, { basisReps: v })}
                      unit="RM"
                      inputClassName="w-8 text-right text-sm"
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
            const setDay = (patch: Partial<NonNullable<typeof day>> | null) => {
              const days = { ...program.days };
              if (patch === null) delete days[String(wd)];
              else days[String(wd)] = { label: "Training", primaryExerciseId: null, progression: true, ...day, ...patch };
              setProgram({ days });
            };
            return (
              <div key={wd} className="py-3">
                <div className="flex items-center justify-between">
                  <span className={clsx("w-10 text-sm", day ? "text-fg" : "text-faint")}>{WEEKDAY_SHORT[wd]}</span>
                  {day ? (
                    <input
                      aria-label={`${WEEKDAY_SHORT[wd]} label`}
                      defaultValue={day.label}
                      onBlur={(e) => e.target.value !== day.label && setDay({ label: e.target.value || "Training" })}
                      className="field min-w-0 flex-1 text-sm text-fg-2"
                    />
                  ) : (
                    <span className="flex-1 text-sm text-faint">No lifting</span>
                  )}
                  <Toggle label={`${WEEKDAY_SHORT[wd]} lifting day`} on={!!day} onChange={(v) => setDay(v ? {} : null)} />
                </div>
                {day && (
                  <div className="mt-2 flex items-center gap-3 pl-10">
                    <select
                      aria-label={`${WEEKDAY_SHORT[wd]} main lift`}
                      value={day.primaryExerciseId ?? ""}
                      onChange={(e) => setDay({ primaryExerciseId: e.target.value ? Number(e.target.value) : null })}
                      className="field flex-1 rounded-xl bg-white/[0.05] px-3 py-2 text-sm [color-scheme:dark]"
                    >
                      <option value="">No main lift</option>
                      {tracked.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.name}
                        </option>
                      ))}
                    </select>
                    <span className="text-xs text-mute">AMRAP</span>
                    <Toggle label={`${WEEKDAY_SHORT[wd]} progression`} on={day.progression} onChange={(v) => setDay({ progression: v })} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Section>

      <Section label="Rep-max table">
        <p className="mb-4 text-xs text-mute">The % of your max you could lift for N reps. Missing counts are interpolated.</p>
        <div className="grid grid-cols-3 gap-x-5 gap-y-3">
          {tableReps.map((r) => (
            <div key={r} className="flex items-center justify-between">
              <span className="num text-xs text-mute">{r} RM</span>
              <BoxNumber
                ariaLabel={`${r} rep max percent`}
                value={Math.round(repMaxPct(program.repMaxPct, r) * 1000) / 10}
                decimals={1}
                inputClassName="w-10 text-right text-sm"
                className="px-2 py-1"
                onCommit={(v) => {
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
  const updateExercise = useUpdateExercise();
  const createExercise = useCreateExercise();
  const [name, setName] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const list = data.exercises.filter((e) => showArchived || !e.archived);
  return (
    <Section
      label="Exercise library"
      right={
        <button type="button" className="label text-faint" onClick={() => setShowArchived(!showArchived)}>
          {showArchived ? "hide archived" : "show archived"}
        </button>
      }
    >
      <div className="divide-y divide-white/[0.04]">
        {list.map((e) => (
          <div key={e.id} className={clsx("flex items-center gap-3 py-2.5", e.archived && "opacity-40")}>
            <input
              aria-label="Exercise name"
              defaultValue={e.name}
              onBlur={(ev) =>
                ev.target.value.trim() && ev.target.value !== e.name && void updateExercise(e.id, { name: ev.target.value.trim() })
              }
              className="field min-w-0 flex-1 text-sm"
            />
            <button
              type="button"
              onClick={() => void updateExercise(e.id, { tracksMax: !e.tracksMax })}
              className={clsx("chip", e.tracksMax ? "bg-accent/15 text-accent" : "bg-white/[0.04] text-faint")}
            >
              max
            </button>
            <button
              type="button"
              onClick={() => void updateExercise(e.id, { archived: !e.archived })}
              className="chip bg-white/[0.04] text-faint"
            >
              {e.archived ? "restore" : "archive"}
            </button>
          </div>
        ))}
      </div>
      <div className="mt-4 flex gap-3">
        <input
          aria-label="New exercise name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New lift…"
          className="field min-w-0 flex-1 rounded-xl bg-white/[0.05] px-3 py-2 text-sm"
        />
        <button
          type="button"
          disabled={!name.trim()}
          className="btn-ghost disabled:opacity-30"
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
