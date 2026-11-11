import clsx from "clsx";
import { useCallback, useMemo, useRef } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ChevronLeft, ChevronRight, Flame, Settings2 } from "lucide-react";
import { addDays, isISODate, weekdayName } from "../../shared/dates";
import { CALIBRATION_DAYS } from "../../shared/energy";
import { dayChecklist, isClosed } from "../../shared/gamify";
import { targetsFor } from "../../shared/insights";
import { isOnHold, overTarget, PROTEIN_OVER_TARGET_SCALE, remainingKcal, type OverTargetScale } from "../../shared/nutrition";
import { cycleLabel, cyclePosition, programDayFor, type CyclePosition } from "../../shared/program";
import { emptyDayLog } from "../../shared/empty";
import type { DayLog, DayLogPatch } from "../../shared/schemas";
import { buildSession, nextSession, sessionCounts, sessionDoneEarly } from "../../shared/session";
import { Bar, Section, severityClass, severityColor, Stat } from "../components/ui";
import { Calibration } from "../components/Calibration";
import { FloorNote } from "../components/FloorNote";
import { JournalText } from "../components/TextArea";
import { DayChecklist } from "../components/today/Checklist";
import { DateJump } from "../components/today/DateJump";
import { DayRing } from "../components/today/DayRing";
import { NextSession } from "../components/today/NextSession";
import { PendingSyncChip } from "../components/today/PendingSyncChip";
import { SavedTick, useSavedFlash } from "../components/today/saved";
import { Signals } from "../components/today/Signals";
import { fmt, signed } from "../lib/format";
import { success } from "../lib/haptics";
import { useData, usePendingDates, useSaveDay } from "../lib/store";
import { useTitle } from "../components/useTitle";

/** Shown only where the header's text column has room for the long form (about 168 px at the default text size). */
const WIDE_ONLY = "@max-[10.5rem]:hidden";

/**
 * Where the day sits in the program, as the short label (`cycleLabel(…, { short: true })`: "Week 2",
 * "Deload", "Cycle 2 · Week 1") and the rest of the full one (" of 5", " week") — the tail a narrow
 * header leaves out.
 */
export function cycleParts(pos: CyclePosition, weeksCount: number): { short: string; rest: string } {
  const full = cycleLabel(pos, weeksCount);
  const short = cycleLabel(pos, weeksCount, { short: true });
  // The short label is the full one's start; were that ever not so, the full label is shown everywhere.
  return full.startsWith(short) ? { short, rest: full.slice(short.length) } : { short: full, rest: "" };
}

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
  const headerRef = useRef<HTMLElement>(null);
  // When the sync chip goes away while focused, focus lands on the date control beside it.
  const dateControl = useCallback(() => headerRef.current?.querySelector<HTMLElement>('input[type="date"]'), []);

  const day: DayLog = data.days.find((d) => d.date === date) ?? emptyDayLog(date);
  const session = data.sessions.find((s) => s.date === date);
  // With moved sessions: a day whose plan was done early is credited, and a day a session was
  // moved to gets a Lift item even when it isn't a program day.
  const items = dayChecklist(date, data);
  const doneCount = items.filter((i) => i.done).length;
  const liftItem = items.find((i) => i.key === "lift");
  const closed = isClosed(items);
  const targets = isToday ? model.targets : targetsFor(date, model.series, data);
  const energy = model.series.find((d) => d.date === date) ?? null;
  const prevEnergy = model.series.find((d) => d.date === addDays(date, -1)) ?? null;
  const rec = targets.recommendation;

  const patch = (p: DayLogPatch) => {
    const before = isClosed(items);
    save(date, p);
    const after = isClosed(dayChecklist(date, { ...data, days: [...data.days.filter((d) => d.date !== date), { ...day, ...p }] }));
    if (!before && after) success();
  };

  const go = (d: string) => navigate(d === today ? "/" : `/day/${d}`);

  const programDay = programDayFor(data.settings.program, date);
  const pos = cyclePosition(data.settings.program, date);
  const cycle = pos ? cycleParts(pos, data.settings.program.weeks.length) : null;
  // This day's plan, moved to (and maybe done on) another day ("Do this session today").
  const doneEarly = session ? null : sessionDoneEarly(date, data.sessions);
  const draft = programDay && !session && !doneEarly ? buildSession(date, data) : null;
  const sess = session ?? doneEarly ?? draft;
  const primaryBlock = sess?.blocks.find((b) => b.kind === "primary");
  const primaryEx = primaryBlock?.exercises[0];
  const primaryName = primaryEx ? data.exercises.find((e) => e.id === primaryEx.exerciseId)?.name : null;
  // Same count as Train's header: skipped exercises don't count.
  const { done: setsDone, total: setsTotal } = sess ? sessionCounts(sess) : { done: 0, total: 0 };
  // Only on today: what's coming up next on the program (links to its preview on Train).
  const upcoming = useMemo(() => (isToday ? nextSession(today, data) : null), [isToday, today, data]);

  const loggedCount = energy?.loggedCount ?? 0;
  const calibrating = loggedCount < CALIBRATION_DAYS;
  // A day only counts once it has both a weight and calories; say which half is missing.
  const missing =
    day.weightLb !== null && day.calories === null ? "calories" : day.calories !== null && day.weightLb === null ? "weight" : null;
  const trendDelta = energy?.avgWeight != null && prevEnergy?.avgWeight != null ? energy.avgWeight - prevEnergy.avgWeight : null;
  // 0 within 5 % of the target, then lime → caution yellow → warn as the day runs further over (SPEC §3.1).
  // Today counts down what's left; `over` and `severity` are `overTarget`'s, so a past day reads them the same.
  const { left: leftKcal, severity: kcalSeverity, over: overKcal } = remainingKcal(day.calories, rec?.calories);
  const overStyle = { className: severityClass(kcalSeverity, "text"), style: { color: severityColor(kcalSeverity) } };

  return (
    <div>
      {/* Header */}
      <header ref={headerRef} className="flex flex-wrap items-center justify-between pt-2">
        <div className="flex items-center">
          <button
            type="button"
            aria-label="Previous day"
            onClick={() => go(addDays(date, -1))}
            className="tap -ml-3 grid h-11 w-11 place-items-center text-mute"
          >
            <ChevronLeft size={18} />
          </button>
          <DateJump date={date} today={today} onPick={go} />
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
        {/* Wraps under the date when there's no room (very narrow / zoomed in), right-aligned. */}
        <div className="ml-auto flex items-center gap-1">
          <PendingSyncChip pending={pending} focusFallback={dateControl} />
          <Link to="/settings" aria-label="Settings" className="tap -mr-3 grid h-11 w-11 place-items-center text-mute">
            <Settings2 size={18} />
          </Link>
        </div>
      </header>

      {/* Hero */}
      {/* At 200% zoom the streak and ring wrap under the title instead of squeezing it. */}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-x-5 gap-y-4">
        {/* A container: the lines under the title shorten to the room this column really has (beside the streak and ring). */}
        <div className="@container min-w-32 flex-1">
          <h1 className="text-[clamp(1.75rem,11vw,2.75rem)] leading-none font-light tracking-tight">
            {isToday ? "Today" : weekdayName(date)}
          </h1>
          {/* Two lines, each its own: what is left of the day, then where the day sits in the program. Where the
              column is narrow (a 320 px phone) each drops its tail — "6 left to close" / "Cycle 2 · Week 1" —
              rather than wrap into a third line or break mid-phrase. */}
          <p className="mt-3 text-sm text-mute" data-day-sub="">
            <span className="block">
              {closed ? (
                <span className="text-accent">
                  Day closed.<span className={WIDE_ONLY}> Nicely done.</span>
                </span>
              ) : (
                <>
                  <span className="num text-fg-2">{items.length - doneCount}</span> left to close
                  <span className={WIDE_ONLY}> the day</span>
                </>
              )}
            </span>
            {cycle && (
              <span className="block" data-cycle="">
                {/* One paragraph to a screen reader (and to `textContent`): "… the day · Week 2 of 5". */}
                <span className="sr-only"> · </span>
                {cycle.short}
                {cycle.rest && <span className={WIDE_ONLY}>{cycle.rest}</span>}
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

      {/* What the app makes of the last days: first, where it can still change today. */}
      {isToday && <Signals insights={model.insights} />}

      {/* Fuel */}
      <Section label="Fuel" right={targets.tdee?.provisional ? <span className="label text-mute">provisional</span> : null}>
        {rec ? (
          <>
            {/* Wraps (the right-hand number under the target) when zoomed in or very narrow. */}
            <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
              <Stat
                label="Target"
                value={fmt(rec.calories)}
                unit="kcal"
                tone="accent"
                size="lg"
                sub={
                  <>
                    {/* The rate is the one the target is built for: slower than the pace while the
                        minimum holds a cut's target up, and "on hold" when that leaves no deficit.
                        "(capped)" is about the pace: not said beside a target the minimum set. */}
                    {rec.direction === "maintain"
                      ? "Maintenance"
                      : isOnHold(rec)
                        ? "Cut · on hold"
                        : `${rec.direction === "lose" ? "Cut" : "Build"} · ${signed(rec.rateLbPerWeek, 1)} lb/wk${rec.paceCapped && !rec.floored ? " (capped)" : ""}`}
                    <FloorNote rec={rec} className="mt-0.5" />
                  </>
                }
              />
              {/* Today: what's left to eat (the overage once past the tolerance, in the bar's colour and
                  in words). A past day: what was eaten — "left" means nothing in hindsight. */}
              <div className="pb-1 text-right" data-fuel-side={!isToday ? "eaten" : overKcal > 0 ? "over" : "left"}>
                {!isToday ? (
                  <>
                    <div className="num text-2xl font-light">{day.calories !== null ? fmt(day.calories) : "—"}</div>
                    <div className="label mt-1">eaten</div>
                  </>
                ) : overKcal > 0 ? (
                  <>
                    <div className={clsx("num text-2xl font-light", overStyle.className)} style={overStyle.style}>
                      +{fmt(overKcal)}
                      <span className="sr-only"> kcal</span>
                    </div>
                    <div className="label mt-1">over</div>
                  </>
                ) : (
                  <>
                    <div className="num text-2xl font-light">
                      {fmt(leftKcal)}
                      <span className="sr-only"> kcal</span>
                    </div>
                    <div className="label mt-1">left</div>
                  </>
                )}
              </div>
            </div>
            <Bar className="mt-4" value={day.calories ? day.calories / rec.calories : 0} severity={kcalSeverity} />
            {isToday ? (
              <div className="num mt-1.5 text-xs text-mute" data-fuel-eaten="">
                {day.calories !== null ? (
                  <>
                    <span className="text-fg-2">{fmt(day.calories)}</span> eaten
                  </>
                ) : (
                  "Nothing logged yet"
                )}
              </div>
            ) : (
              // The line is there (empty) when the day isn't over, as Today's "eaten" line always is: editing the
              // day's calories must not move what is under the bar — the field being typed in included.
              <div className="num mt-1.5 min-h-4 text-right text-xs" data-fuel-over="">
                {kcalSeverity > 0 && (
                  <span className={overStyle.className} style={overStyle.style}>
                    +{fmt(overKcal)} <span className="text-mute">kcal over</span>
                  </span>
                )}
              </div>
            )}
            <div className="mt-5 grid grid-cols-[repeat(auto-fit,minmax(5rem,1fr))] gap-5">
              <Macro label="Protein" eaten={day.proteinG} target={rec.macros.proteinG} scale={PROTEIN_OVER_TARGET_SCALE} />
              <Macro label="Carbs" eaten={day.carbsG} target={rec.macros.carbsG} />
              <Macro label="Fat" eaten={day.fatG} target={rec.macros.fatG} />
            </div>
            {/* mt-3 after the macros' note line (always there): about the gap there was under the bars. */}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-mute">
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
            // The checklist's own reading: the plan this day holds (movedFrom), or where this day's plan went.
            plannedFor: liftItem?.movedFrom ?? null,
            completed: !!sess?.completedAt,
            mainSkipped: !!(primaryBlock?.skipped || primaryEx?.skipped),
            elsewhere: liftItem?.doneOn ?? doneEarly?.date ?? null,
            date,
            today,
          }}
          saved={saved}
        />
        {upcoming && <NextSession next={upcoming} today={today} />}
      </Section>

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
    </div>
  );
}

export function Macro({
  label,
  eaten,
  target,
  scale,
}: {
  label: string;
  eaten: number | null;
  target: number;
  /** How far over counts as over (protein is lenient); see `overTargetSeverity`. */
  scale?: OverTargetScale;
}) {
  // A zero target (e.g. carbs on an aggressive cut) has no meaningful bar.
  const hasTarget = target > 0;
  // `over` (whole grams) is 0 exactly when `severity` is: no "+0g over" on a tiny target.
  const { severity, over } = overTarget(eaten, target, scale);
  return (
    <div className="min-w-0">
      <div className="label mb-1.5">{label}</div>
      <div className="num text-lg font-light">
        {eaten !== null ? fmt(eaten) : <span className="text-mute">—</span>}
        <span className="text-xs text-mute"> / {hasTarget ? `${fmt(target)}g` : "—"}</span>
      </div>
      <Bar className="mt-2" value={hasTarget && eaten ? eaten / target : 0} severity={severity} />
      {/* Not colour alone: the text says "over". Its line is always there: a macro saved from the editor below
          (the field left for the next one, the keyboard still up) must not push that editor down a line. */}
      <div className="mt-1 min-h-4" data-macro-over="">
        {over > 0 && (
          <div
            className={clsx("num text-[0.6875rem] leading-4", severityClass(severity, "text"))}
            style={{ color: severityColor(severity) }}
          >
            +{fmt(over)}g over
          </div>
        )}
      </div>
    </div>
  );
}
