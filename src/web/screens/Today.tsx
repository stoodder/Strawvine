import clsx from "clsx";
import { Link, useNavigate, useParams } from "react-router";
import { ChevronLeft, ChevronRight, Flame, Settings2, Sparkles, TriangleAlert, Info } from "lucide-react";
import { addDays, isISODate, weekdayName } from "../../shared/dates";
import { CALIBRATION_DAYS } from "../../shared/energy";
import { checklist, isClosed } from "../../shared/gamify";
import { targetsFor } from "../../shared/insights";
import { cyclePosition, programDayFor } from "../../shared/program";
import { emptyDayLog } from "../../shared/empty";
import type { DayLog, DayLogPatch } from "../../shared/schemas";
import { buildSession, sessionCounts } from "../../shared/session";
import { Bar, Section, Stat } from "../components/ui";
import { Calibration } from "../components/Calibration";
import { JournalText } from "../components/TextArea";
import { DayChecklist } from "../components/today/Checklist";
import { DateJump } from "../components/today/DateJump";
import { DayRing } from "../components/today/DayRing";
import { SavedTick, useSavedFlash } from "../components/today/saved";
import { fmt, minutesToHM, signed } from "../lib/format";
import { success } from "../lib/haptics";
import { useData, usePendingDates, useSaveDay } from "../lib/store";
import { useTitle } from "../components/useTitle";

export function TodayScreen() {
  const params = useParams();
  const { data, today, model, streak } = useData();
  useTitle("Today");
  const date = params.date && isISODate(params.date) && params.date <= today ? params.date : today;
  const isToday = date === today;
  const navigate = useNavigate();
  const save = useSaveDay();
  const saved = useSavedFlash(date);
  const pending = usePendingDates().has(date);

  const day: DayLog = data.days.find((d) => d.date === date) ?? emptyDayLog(date);
  const session = data.sessions.find((s) => s.date === date);
  const items = checklist(date, day, session, data.settings);
  const doneCount = items.filter((i) => i.done).length;
  const closed = isClosed(items);
  const targets = isToday ? model.targets : targetsFor(date, model.series, data);
  const energy = model.series.find((d) => d.date === date) ?? null;
  const prevEnergy = model.series.find((d) => d.date === addDays(date, -1)) ?? null;
  const rec = targets.recommendation;

  const patch = (p: DayLogPatch) => {
    const before = isClosed(items);
    save(date, p);
    const after = isClosed(checklist(date, { ...day, ...p }, session, data.settings));
    if (!before && after) success();
  };

  const go = (d: string) => navigate(d === today ? "/" : `/day/${d}`);

  const programDay = programDayFor(data.settings.program, date);
  const pos = cyclePosition(data.settings.program, date);
  const draft = programDay && !session ? buildSession(date, data) : null;
  const sess = session ?? draft;
  const primaryEx = sess?.blocks.find((b) => b.kind === "primary")?.exercises[0];
  const primaryName = primaryEx ? data.exercises.find((e) => e.id === primaryEx.exerciseId)?.name : null;
  // Same count as Train's header: skipped exercises don't count.
  const { done: setsDone, total: setsTotal } = sess ? sessionCounts(sess) : { done: 0, total: 0 };

  const loggedCount = energy?.loggedCount ?? 0;
  const calibrating = loggedCount < CALIBRATION_DAYS;
  // A day only counts once it has both a weight and calories; say which half is missing.
  const missing =
    day.weightLb !== null && day.calories === null ? "calories" : day.calories !== null && day.weightLb === null ? "weight" : null;
  const trendDelta = energy?.avgWeight != null && prevEnergy?.avgWeight != null ? energy.avgWeight - prevEnergy.avgWeight : null;
  const overKcal = rec && day.calories !== null ? day.calories - rec.calories : 0;
  const overEating = overKcal > (rec?.calories ?? 0) * 0.05;

  return (
    <div>
      {/* Header */}
      <header className="flex items-center justify-between pt-2">
        <div className="flex items-center">
          <button
            type="button"
            aria-label="Previous day"
            onClick={() => go(addDays(date, -1))}
            className="tap -ml-3 grid h-11 w-11 place-items-center text-mute"
          >
            <ChevronLeft size={18} />
          </button>
          <DateJump date={date} today={today} pending={pending} onPick={go} />
          <button
            type="button"
            aria-label="Next day"
            disabled={isToday}
            onClick={() => go(addDays(date, 1))}
            className="tap grid h-11 w-11 place-items-center text-mute disabled:opacity-20"
          >
            <ChevronRight size={18} />
          </button>
        </div>
        <Link to="/settings" aria-label="Settings" className="tap -mr-3 grid h-11 w-11 place-items-center text-mute">
          <Settings2 size={18} />
        </Link>
      </header>

      {/* Hero */}
      {/* At 200% zoom the streak and ring wrap under the title instead of squeezing it. */}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-x-5 gap-y-4">
        <div className="min-w-32 flex-1">
          <h1 className="text-[clamp(2.125rem,11vw,2.75rem)] leading-none font-light tracking-tight">
            {isToday ? "Today" : weekdayName(date)}
          </h1>
          <p className="mt-3 text-sm text-mute">
            {closed ? (
              <span className="text-accent">Day closed. Nicely done.</span>
            ) : (
              <>
                <span className="num text-fg-2">{items.length - doneCount}</span> left to close the day
              </>
            )}
            {pos && (
              <span className="whitespace-nowrap">
                {" "}
                · C{pos.cycle} {pos.week.deload ? "Deload" : `W${pos.weekIndex + 1}`}
              </span>
            )}
          </p>
          {!isToday && (
            // Same as Train's: 44px tall, without pushing the hero down.
            <Link to="/" className="label mt-0.5 -mb-3.5 inline-flex min-h-11 items-center text-accent">
              ← Today
            </Link>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-4">
          {isToday && (
            <div className="text-right">
              <div className="flex items-center justify-end gap-1 text-gold">
                <Flame size={14} aria-hidden="true" />
                <span className="num text-2xl font-light">{streak.current}</span>
              </div>
              <div className="label mt-0.5">streak</div>
            </div>
          )}
          <DayRing date={date} closed={closed} value={items.length ? doneCount / items.length : 0} size={60} stroke={3.5}>
            <span className="num text-sm text-fg-2">
              {doneCount}/{items.length}
            </span>
          </DayRing>
        </div>
      </div>

      {/* Fuel */}
      <Section label="Fuel" right={targets.tdee?.provisional ? <span className="label text-mute">provisional</span> : null}>
        {rec ? (
          <>
            {/* Wraps (eaten under the target) when zoomed in or very narrow. */}
            <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
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
            <Bar className="mt-4" value={day.calories ? day.calories / rec.calories : 0} tone={overEating ? "warn" : "accent"} />
            {overEating && (
              <div className="num mt-1.5 text-right text-xs text-warn">
                +{fmt(overKcal)} <span className="text-mute">kcal over</span>
              </div>
            )}
            <div className="mt-5 grid grid-cols-[repeat(auto-fit,minmax(5rem,1fr))] gap-5">
              <Macro label="Protein" eaten={day.proteinG} target={rec.macros.proteinG} />
              <Macro label="Carbs" eaten={day.carbsG} target={rec.macros.carbsG} />
              <Macro label="Fat" eaten={day.fatG} target={rec.macros.fatG} />
            </div>
            <div className="mt-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-mute">
              <span className="whitespace-nowrap">
                TDEE <span className="num text-fg-2">{fmt(targets.tdee?.value)}</span>
                {targets.tdee?.measured != null && targets.tdee.provisional && (
                  <span className="text-mute"> · measured {fmt(targets.tdee.measured)}</span>
                )}
              </span>
              {energy?.avgWeight != null && (
                <span className="whitespace-nowrap">
                  Trend <span className="num text-fg-2">{fmt(energy.avgWeight, 1)}</span> lb
                  {trendDelta !== null && Math.abs(trendDelta) >= 0.05 && <span className="num text-mute"> {signed(trendDelta, 1)}</span>}
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
            <Calibration logged={loggedCount} missing={missing} />
          </div>
        )}
      </Section>

      {/* Checklist */}
      <Section label={isToday ? "Close the day" : "The day"}>
        <DayChecklist
          key={date}
          items={items}
          day={day}
          patch={patch}
          stepTarget={data.settings.targets.steps}
          zone2Minutes={data.settings.targets.zone2Minutes}
          lift={{
            href: isToday ? "/train" : `/train/${date}`,
            label: sess?.label,
            primaryName,
            setsDone,
            setsTotal,
          }}
          saved={saved}
        />
      </Section>

      {/* Recovery snapshot */}
      {(day.sleepMinutes !== null || day.sleepScore !== null || day.hrvMs !== null || day.energy !== null || day.soreness !== null) && (
        <Section label="Recovery">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(5rem,1fr))] gap-5">
            <Stat label="Sleep" value={day.sleepMinutes !== null ? minutesToHM(day.sleepMinutes) : "—"} size="sm" />
            <Stat label="Score" value={fmt(day.sleepScore)} size="sm" />
            <Stat label="HRV" value={fmt(day.hrvMs)} unit={day.hrvMs !== null ? "ms" : undefined} size="sm" />
          </div>
        </Section>
      )}

      {/* Journal */}
      <Section label="Journal" right={<SavedTick show={saved.shown === "journal"} />}>
        <JournalText
          key={date}
          ariaLabel="Journal"
          value={day.journal}
          onSave={(v) => {
            saved.mark("journal");
            patch({ journal: v });
          }}
          placeholder="How did it feel? What moved, what didn't…"
          className="text-base"
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
                <span className="text-fg-2">{trueMinus(i.text)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

/** Typographic minus for negative numbers in copy ("-0.8 lb" → "−0.8 lb"), matching `signed()`. */
function trueMinus(text: string): string {
  return text.replace(/(^|[\s(])-(?=\d)/g, "$1\u2212");
}

function Macro({ label, eaten, target }: { label: string; eaten: number | null; target: number }) {
  // A zero target (e.g. carbs on an aggressive cut) has no meaningful bar.
  const hasTarget = target > 0;
  const over = hasTarget && eaten !== null && eaten > target * 1.1 ? eaten - target : 0;
  return (
    <div className="min-w-0">
      <div className="label mb-1.5">{label}</div>
      <div className="num text-lg font-light">
        {eaten !== null ? fmt(eaten) : <span className="text-mute">—</span>}
        <span className="text-xs text-mute"> / {hasTarget ? `${fmt(target)}g` : "—"}</span>
      </div>
      <Bar className="mt-2" value={hasTarget && eaten ? eaten / target : 0} tone={over ? "mute" : "accent"} />
      {over > 0 && <div className="num mt-1 text-[0.6875rem] text-mute">+{fmt(over)}g over</div>}
    </div>
  );
}
