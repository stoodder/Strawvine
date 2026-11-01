import clsx from "clsx";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ChevronLeft, ChevronRight, Flame, Settings2, Sparkles, TriangleAlert, Info } from "lucide-react";
import { addDays, formatShortDate, isISODate, weekdayName } from "../../shared/dates";
import { CALIBRATION_DAYS } from "../../shared/energy";
import { checklist, isClosed, streaks, type ChecklistItem } from "../../shared/gamify";
import { targetsFor } from "../../shared/insights";
import { cyclePosition, programDayFor } from "../../shared/program";
import { emptyDayLog, type DayLog, type DayLogPatch } from "../../shared/schemas";
import { buildSession } from "../../shared/session";
import { Bar, BoxNumber, CheckDot, DotScale, NumberInput, Ring, Section, Stat } from "../components/ui";
import { Calibration } from "../components/Calibration";
import { JournalText } from "../components/TextArea";
import { compactSteps, fmt, minutesToHM, parseDuration, signed } from "../lib/format";
import { success } from "../lib/haptics";
import { useData, useSaveDay } from "../lib/store";

export function TodayScreen() {
  const params = useParams();
  const { data, today, model } = useData();
  const date = params.date && isISODate(params.date) && params.date <= today ? params.date : today;
  const isToday = date === today;
  const navigate = useNavigate();
  const save = useSaveDay();

  const day: DayLog = data.days.find((d) => d.date === date) ?? emptyDayLog(date);
  const session = data.sessions.find((s) => s.date === date);
  const items = checklist(date, day, session, data.settings);
  const doneCount = items.filter((i) => i.done).length;
  const closed = isClosed(items);
  const streak = useMemo(() => streaks(data, today), [data, today]);
  const targets = isToday ? model.targets : targetsFor(date, model.series, data);
  const energy = model.series.find((d) => d.date === date) ?? null;
  const prevEnergy = model.series.find((d) => d.date === addDays(date, -1)) ?? null;
  const rec = targets.recommendation;
  const [open, setOpen] = useState<string | null>(null);

  const patch = (p: DayLogPatch) => {
    const before = isClosed(items);
    save(date, p);
    const after = isClosed(checklist(date, { ...day, ...p }, session, data.settings));
    if (!before && after) success();
  };

  const go = (d: string) => navigate(d === today ? "/" : `/day/${d}`);
  const toggle = (k: string) => setOpen((o) => (o === k ? null : k));

  const programDay = programDayFor(data.settings.program, date);
  const pos = cyclePosition(data.settings.program, date);
  const draft = programDay && !session ? buildSession(date, data) : null;
  const sess = session ?? draft;
  const primaryEx = sess?.blocks.find((b) => b.kind === "primary")?.exercises[0];
  const primaryName = primaryEx ? data.exercises.find((e) => e.id === primaryEx.exerciseId)?.name : null;
  const setsDone = sess?.blocks.reduce((n, b) => n + b.exercises.reduce((m, e) => m + e.sets.filter((s) => s.done).length, 0), 0) ?? 0;
  const setsTotal = sess?.blocks.reduce((n, b) => n + b.exercises.reduce((m, e) => m + e.sets.length, 0), 0) ?? 0;

  const loggedCount = energy?.loggedCount ?? 0;
  const calibrating = loggedCount < CALIBRATION_DAYS;

  return (
    <div>
      {/* Header */}
      <header className="flex items-center justify-between pt-2">
        <div className="flex items-center gap-1">
          <button type="button" aria-label="Previous day" onClick={() => go(addDays(date, -1))} className="tap -ml-2 p-2 text-mute">
            <ChevronLeft size={18} />
          </button>
          <div className="label text-fg-2">
            {weekdayName(date, true)} · {formatShortDate(date)}
          </div>
          <button
            type="button"
            aria-label="Next day"
            disabled={isToday}
            onClick={() => go(addDays(date, 1))}
            className="tap p-2 text-mute disabled:opacity-20"
          >
            <ChevronRight size={18} />
          </button>
        </div>
        <Link to="/settings" aria-label="Settings" className="tap -mr-2 p-2 text-mute">
          <Settings2 size={18} />
        </Link>
      </header>

      {/* Hero */}
      <div className="mt-6 flex items-center justify-between gap-6">
        <div>
          <h1 className="text-[44px] leading-none font-light tracking-tight">{isToday ? "Today" : weekdayName(date)}</h1>
          <p className="mt-3 text-sm text-mute">
            {closed ? (
              <span className="text-accent">Day closed. Nicely done.</span>
            ) : (
              <>
                <span className="num text-fg-2">{items.length - doneCount}</span> left to close the day
              </>
            )}
            {pos && (
              <span className="text-faint">
                {" "}
                · C{pos.cycle} {pos.week.deload ? "Deload" : `W${pos.weekIndex + 1}`}
              </span>
            )}
          </p>
          {!isToday && (
            <Link to="/" className="label mt-3 inline-block text-accent">
              Back to today →
            </Link>
          )}
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="flex items-center justify-end gap-1 text-gold">
              <Flame size={14} />
              <span className="num text-2xl font-light">{streak.current}</span>
            </div>
            <div className="label mt-0.5">streak</div>
          </div>
          <Ring value={items.length ? doneCount / items.length : 0} size={60} stroke={3.5}>
            <span className="num text-sm text-fg-2">
              {doneCount}/{items.length}
            </span>
          </Ring>
        </div>
      </div>

      {/* Fuel */}
      <Section label="Fuel" right={targets.tdee?.provisional ? <span className="label text-faint">provisional</span> : null}>
        {rec ? (
          <>
            <div className="flex items-end justify-between gap-4">
              <Stat
                label="Target"
                value={fmt(rec.calories)}
                unit="kcal"
                tone="accent"
                size="lg"
                sub={
                  rec.direction === "maintain"
                    ? "Maintenance"
                    : `${rec.direction === "lose" ? "Cut" : "Build"} · ${signed(rec.rateLbPerWeek, 1)} lb/wk${rec.paceCapped ? " (capped)" : ""}`
                }
              />
              <div className="pb-1 text-right">
                <div className="num text-2xl font-light">{day.calories !== null ? fmt(day.calories) : "—"}</div>
                <div className="label mt-1">{isToday ? "so far" : "eaten"}</div>
              </div>
            </div>
            <Bar
              className="mt-4"
              value={day.calories ? day.calories / rec.calories : 0}
              tone={day.calories && day.calories > rec.calories * 1.05 ? "gold" : "accent"}
            />
            <div className="mt-5 grid grid-cols-3 gap-5">
              <Macro label="Protein" eaten={day.proteinG} target={rec.macros.proteinG} />
              <Macro label="Carbs" eaten={day.carbsG} target={rec.macros.carbsG} />
              <Macro label="Fat" eaten={day.fatG} target={rec.macros.fatG} />
            </div>
            <div className="mt-6 flex items-center justify-between text-xs text-mute">
              <span>
                TDEE <span className="num text-fg-2">{fmt(targets.tdee?.value)}</span>
                {targets.tdee?.measured != null && targets.tdee.provisional && (
                  <span className="text-faint"> · measured {fmt(targets.tdee.measured)}</span>
                )}
              </span>
              {energy?.avgWeight != null && (
                <span>
                  Trend <span className="num text-fg-2">{fmt(energy.avgWeight, 1)}</span> lb
                  {prevEnergy?.avgWeight != null && (
                    <span className="num text-faint"> {signed(energy.avgWeight - prevEnergy.avgWeight, 2)}</span>
                  )}
                </span>
              )}
            </div>
          </>
        ) : (
          <p className="text-sm leading-relaxed text-mute">
            Log a morning weight and your targets appear here. They sharpen every day you log both weight and calories.
          </p>
        )}
        {calibrating && (
          <div className="mt-6">
            <Calibration logged={loggedCount} />
          </div>
        )}
      </Section>

      {/* Checklist */}
      <Section label={isToday ? "Close the day" : "The day"}>
        <div className="-mx-1">
          {items.map((item) => (
            <ChecklistRow
              key={item.key}
              item={item}
              open={open === item.key}
              onToggleOpen={() => toggle(item.key)}
              onCheck={
                item.key === "metcon"
                  ? () => patch({ metconDone: !day.metconDone })
                  : item.key === "zone2"
                    ? () =>
                        patch({
                          zone2Done: !day.zone2Done,
                          zone2Minutes: !day.zone2Done && day.zone2Minutes === null ? data.settings.targets.zone2Minutes : day.zone2Minutes,
                        })
                    : item.key === "lift"
                      ? () => navigate(isToday ? "/train" : `/train/${date}`)
                      : () => toggle(item.key)
              }
              summary={summaryFor(item, day, data.settings.targets.steps, primaryName, sess?.label, setsDone, setsTotal)}
            >
              {item.key === "morning" && <MorningEditor day={day} patch={patch} />}
              {item.key === "fuel" && <FuelEditor day={day} patch={patch} />}
              {item.key === "steps" && <StepsEditor day={day} patch={patch} target={data.settings.targets.steps} />}
              {item.key === "zone2" && <Zone2Editor day={day} patch={patch} />}
              {item.key === "metcon" && <MetconEditor day={day} patch={patch} />}
              {item.key === "lift" && (
                <div className="flex items-center justify-between pb-2">
                  <span className="text-sm text-mute">
                    {sess?.completedAt ? "Session complete." : setsDone ? "In progress." : "Ready when you are."}
                  </span>
                  <Link to={isToday ? "/train" : `/train/${date}`} className="btn-ghost">
                    Open session <ChevronRight size={14} />
                  </Link>
                </div>
              )}
            </ChecklistRow>
          ))}
        </div>
      </Section>

      {/* Recovery snapshot */}
      {(day.sleepMinutes !== null || day.sleepScore !== null || day.hrvMs !== null || day.energy !== null || day.soreness !== null) && (
        <Section label="Recovery">
          <div className="grid grid-cols-3 gap-5">
            <Stat label="Sleep" value={day.sleepMinutes !== null ? minutesToHM(day.sleepMinutes) : "—"} size="sm" />
            <Stat label="Score" value={fmt(day.sleepScore)} size="sm" />
            <Stat label="HRV" value={fmt(day.hrvMs)} unit={day.hrvMs !== null ? "ms" : undefined} size="sm" />
          </div>
        </Section>
      )}

      {/* Journal */}
      <Section label="Journal">
        <JournalText
          key={date}
          ariaLabel="Journal"
          value={day.journal}
          onSave={(v) => patch({ journal: v })}
          placeholder="How did it feel? What moved, what didn't…"
          className="text-[15px]"
          minRows={4}
        />
      </Section>

      {/* Insights */}
      {isToday && model.insights.length > 0 && (
        <Section label="Signals">
          <ul className="space-y-4">
            {model.insights.map((i) => (
              <li key={i.key} className="flex gap-3 text-sm leading-relaxed">
                <span
                  className={clsx("mt-0.5 shrink-0", i.tone === "good" ? "text-accent" : i.tone === "warn" ? "text-warn" : "text-mute")}
                >
                  {i.tone === "good" ? <Sparkles size={15} /> : i.tone === "warn" ? <TriangleAlert size={15} /> : <Info size={15} />}
                </span>
                <span className="text-fg-2">{i.text}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function summaryFor(
  item: ChecklistItem,
  day: DayLog,
  stepTarget: number,
  primaryName: string | null | undefined,
  label: string | undefined,
  setsDone: number,
  setsTotal: number,
): { value: ReactNode; sub?: ReactNode } {
  switch (item.key) {
    case "morning":
      return {
        value:
          day.weightLb !== null ? (
            <>
              {fmt(day.weightLb, 1)}
              <span className="text-mute"> lb</span>
            </>
          ) : null,
        sub:
          [day.sleepMinutes !== null && minutesToHM(day.sleepMinutes), day.hrvMs !== null && `HRV ${fmt(day.hrvMs)}`]
            .filter(Boolean)
            .join(" · ") || "Weight · sleep · HRV",
      };
    case "fuel":
      return {
        value:
          day.calories !== null ? (
            <>
              {fmt(day.calories)}
              <span className="text-mute"> kcal</span>
            </>
          ) : null,
        sub: day.proteinG !== null ? `P ${fmt(day.proteinG)} · C ${fmt(day.carbsG)} · F ${fmt(day.fatG)}` : "Daily totals",
      };
    case "steps":
      return {
        value: day.steps !== null ? <>{fmt(day.steps)}</> : null,
        sub: `Target ${compactSteps(stepTarget)}`,
      };
    case "zone2":
      return {
        value: day.zone2Done ? (
          <>
            {fmt(day.zone2Minutes)}
            <span className="text-mute"> min</span>
          </>
        ) : null,
        sub: "Cycling",
      };
    case "metcon":
      return {
        value: day.metconScore ? <span className="text-sm">{day.metconScore}</span> : null,
        sub: day.metconBenchmark ?? (day.metconNotes ? day.metconNotes.slice(0, 40) : "CrossFit"),
      };
    case "lift":
      return {
        value: setsTotal ? (
          <span className="text-sm text-fg-2">
            {setsDone}/{setsTotal} sets
          </span>
        ) : null,
        sub: [label, primaryName].filter(Boolean).join(" · ") || "Session",
      };
  }
}

function ChecklistRow({
  item,
  open,
  onToggleOpen,
  onCheck,
  summary,
  children,
}: {
  item: ChecklistItem;
  open: boolean;
  onToggleOpen: () => void;
  onCheck: () => void;
  summary: { value: ReactNode; sub?: ReactNode };
  children: ReactNode;
}) {
  return (
    <div className="rounded-2xl transition-colors" style={{ background: open ? "rgba(255,255,255,0.025)" : undefined }}>
      <div
        className="flex items-center gap-4 px-1 py-3.5"
        onClick={onToggleOpen}
        role="button"
        aria-expanded={open}
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && onToggleOpen()}
      >
        <CheckDot done={item.done} onClick={onCheck} label={`${item.label}${item.done ? " done" : ""}`} />
        <div className="min-w-0 flex-1">
          <div className={clsx("text-[15px]", item.done ? "text-fg" : "text-fg-2")}>{item.label}</div>
          {summary.sub && <div className="mt-0.5 truncate text-xs text-mute">{summary.sub}</div>}
          {item.key === "steps" && !item.done && item.progress > 0 && <Bar className="mt-2 w-32" value={item.progress} />}
        </div>
        <div className="num shrink-0 text-right text-lg font-light">{summary.value}</div>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="px-1 pt-1 pb-4 pl-[46px]">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Macro({ label, eaten, target }: { label: string; eaten: number | null; target: number }) {
  return (
    <div>
      <div className="label mb-1.5">{label}</div>
      <div className="num text-lg font-light">
        {eaten !== null ? fmt(eaten) : <span className="text-faint">—</span>}
        <span className="text-xs text-mute"> / {fmt(target)}g</span>
      </div>
      <Bar className="mt-2" value={eaten ? eaten / Math.max(1, target) : 0} tone={eaten && eaten > target * 1.1 ? "gold" : "accent"} />
    </div>
  );
}

type EditorProps = { day: DayLog; patch: (p: DayLogPatch) => void };

function MorningEditor({ day, patch }: EditorProps) {
  const hm = (m: number | null) => (m !== null ? `${Math.floor(m / 60)}:${String(Math.round(m % 60)).padStart(2, "0")}` : "");
  const [sleepText, setSleepText] = useState(hm(day.sleepMinutes));
  return (
    <div className="space-y-6">
      <div className="flex items-baseline gap-2">
        <NumberInput
          ariaLabel="Morning weight"
          value={day.weightLb}
          onCommit={(v) => patch({ weightLb: v })}
          decimals={1}
          placeholder="000.0"
          inputClassName="text-5xl font-light tracking-tight"
          autoFocus={day.weightLb === null}
          min={50}
          max={1000}
        />
        <span className="text-sm text-mute">lb</span>
      </div>
      <div className="grid grid-cols-3 gap-4">
        <div>
          <div className="label mb-2">Sleep</div>
          <input
            aria-label="Sleep duration"
            inputMode="decimal"
            placeholder="7:30"
            value={sleepText}
            onChange={(e) => setSleepText(e.target.value)}
            onBlur={() => {
              const m = parseDuration(sleepText);
              patch({ sleepMinutes: m });
              setSleepText(hm(m));
            }}
            className="field num w-full rounded-xl bg-white/[0.05] px-3 py-2"
          />
        </div>
        <div>
          <div className="label mb-2">Score</div>
          <BoxNumber
            ariaLabel="Sleep score"
            value={day.sleepScore}
            onCommit={(v) => patch({ sleepScore: v })}
            min={0}
            max={100}
            className="w-full"
            inputClassName="w-full text-left"
          />
        </div>
        <div>
          <div className="label mb-2">HRV</div>
          <BoxNumber
            ariaLabel="HRV"
            value={day.hrvMs}
            onCommit={(v) => patch({ hrvMs: v })}
            min={0}
            max={500}
            className="w-full"
            inputClassName="w-full text-left"
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-x-8 gap-y-4">
        <DotScale label="Energy" value={day.energy} onChange={(v) => patch({ energy: v })} />
        <DotScale label="Soreness" value={day.soreness} onChange={(v) => patch({ soreness: v })} />
      </div>
    </div>
  );
}

function FuelEditor({ day, patch }: EditorProps) {
  const fromMacros =
    day.proteinG !== null && day.carbsG !== null && day.fatG !== null ? Math.round(day.proteinG * 4 + day.carbsG * 4 + day.fatG * 9) : null;
  const [showMicros, setShowMicros] = useState(!!day.micros && Object.keys(day.micros).length > 0);
  return (
    <div className="space-y-5">
      <div className="flex items-baseline gap-2">
        <NumberInput
          ariaLabel="Calories"
          value={day.calories}
          onCommit={(v) => patch({ calories: v })}
          placeholder="0"
          inputClassName="text-5xl font-light tracking-tight"
          min={0}
          max={20000}
        />
        <span className="text-sm text-mute">kcal</span>
      </div>
      {fromMacros !== null && fromMacros !== day.calories && (
        <button type="button" className="chip bg-white/[0.05] text-fg-2" onClick={() => patch({ calories: fromMacros })}>
          Use {fmt(fromMacros)} from macros
        </button>
      )}
      <div className="grid grid-cols-3 gap-4">
        {(
          [
            ["proteinG", "Protein"],
            ["carbsG", "Carbs"],
            ["fatG", "Fat"],
          ] as const
        ).map(([k, label]) => (
          <div key={k}>
            <div className="label mb-2">{label}</div>
            <BoxNumber
              ariaLabel={label}
              value={day[k]}
              onCommit={(v) => patch({ [k]: v })}
              unit="g"
              className="w-full"
              inputClassName="w-full text-left"
              min={0}
            />
          </div>
        ))}
      </div>
      {showMicros ? (
        <Micros micros={day.micros} onChange={(m) => patch({ micros: m })} />
      ) : (
        <button type="button" className="label text-mute" onClick={() => setShowMicros(true)}>
          + Micronutrients
        </button>
      )}
    </div>
  );
}

const COMMON_MICROS = ["Fiber g", "Sugar g", "Sodium mg", "Potassium mg", "Magnesium mg", "Calcium mg", "Iron mg", "Vitamin D IU"];

function Micros({ micros, onChange }: { micros: Record<string, number> | null; onChange: (m: Record<string, number> | null) => void }) {
  const m = micros ?? {};
  const keys = [...new Set([...COMMON_MICROS, ...Object.keys(m)])];
  return (
    <div>
      <div className="label mb-2">Micronutrients</div>
      <div className="grid grid-cols-2 gap-x-5">
        {keys.map((k) => (
          <div key={k} className="flex items-center justify-between py-1.5">
            <span className="text-xs text-fg-2">{k}</span>
            <NumberInput
              ariaLabel={k}
              value={m[k] ?? null}
              onCommit={(v) => {
                const next = { ...m };
                if (v === null) delete next[k];
                else next[k] = v;
                onChange(Object.keys(next).length ? next : null);
              }}
              inputClassName="w-14 text-right text-sm"
              decimals={1}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function StepsEditor({ day, patch, target }: EditorProps & { target: number }) {
  return (
    <div className="flex items-baseline gap-2">
      <NumberInput
        ariaLabel="Steps"
        value={day.steps}
        onCommit={(v) => patch({ steps: v })}
        placeholder="0"
        inputClassName="text-5xl font-light tracking-tight"
        min={0}
        max={200000}
      />
      <span className="text-sm whitespace-nowrap text-mute">/ {fmt(target)}</span>
    </div>
  );
}

function Zone2Editor({ day, patch }: EditorProps) {
  return (
    <div className="flex items-baseline gap-2">
      <NumberInput
        ariaLabel="Zone 2 minutes"
        value={day.zone2Minutes}
        onCommit={(v) => patch({ zone2Minutes: v, zone2Done: v !== null && v > 0 ? true : day.zone2Done })}
        placeholder="30"
        inputClassName="text-5xl font-light tracking-tight"
        min={0}
        max={600}
      />
      <span className="text-sm text-mute">min</span>
    </div>
  );
}

function MetconEditor({ day, patch }: EditorProps) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="label mb-2">Benchmark</div>
          <input
            aria-label="Benchmark name"
            defaultValue={day.metconBenchmark ?? ""}
            placeholder="e.g. Fran"
            onBlur={(e) => {
              const v = e.target.value.trim() || null;
              if (v !== day.metconBenchmark) patch({ metconBenchmark: v });
            }}
            className="field w-full rounded-xl bg-white/[0.05] px-3 py-2 text-sm"
          />
        </div>
        <div>
          <div className="label mb-2">Score</div>
          <input
            aria-label="Benchmark score"
            defaultValue={day.metconScore ?? ""}
            placeholder="3:45 · 12+4 · 225"
            onBlur={(e) => {
              const v = e.target.value.trim() || null;
              if (v !== day.metconScore) patch({ metconScore: v });
            }}
            className="field num w-full rounded-xl bg-white/[0.05] px-3 py-2 text-sm"
          />
        </div>
      </div>
      <JournalText
        ariaLabel="Metcon notes"
        value={day.metconNotes}
        onSave={(v) => patch({ metconNotes: v })}
        placeholder="The workout, how it went…"
        className="text-sm"
        minRows={2}
      />
    </div>
  );
}
