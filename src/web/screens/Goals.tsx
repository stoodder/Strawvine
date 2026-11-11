import clsx from "clsx";
import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type Ref } from "react";
import { useNavigate } from "react-router";
import { Award, Flame, Plus, Trash2, Trophy } from "lucide-react";
import { addDays, formatShortDate, startOfWeek, weekdayName } from "../../shared/dates";
import { dayChecklist, type Achievement } from "../../shared/gamify";
import { goalDirection } from "../../shared/nutrition";
import { currentMax } from "../../shared/program";
import { newId } from "../../shared/session";
import type { Settings } from "../../shared/schemas";
import { FloorNote } from "../components/FloorNote";
import { PaceSlider } from "../components/PaceSlider";
import { formatProjectedRange } from "../components/projection";
import { ScreenHeader } from "../components/ScreenHeader";
import { useSettingsUndo } from "../components/settings/undo";
import { Bar, BoxNumber, Empty, Section, Sheet } from "../components/ui";
import { useTitle } from "../components/useTitle";
import { fmt, signed } from "../lib/format";
import { useData, useSaveSettings } from "../lib/store";

export function GoalsScreen() {
  const { data, today, model } = useData();
  const saveSettings = useSaveSettings();
  const settings = data.settings;
  const goal = settings.weightGoal;
  const trend = model.todayEnergy?.avgWeight ?? null;
  // One source for the projected date: the weekly check-in's (same as Progress).
  const projection = goal ? model.checkin.projection : null;
  const direction = goal && trend !== null ? goalDirection(trend, goal.targetLb, goal.startLb) : "maintain";
  const { streak, achievements: earned } = useData();
  const [goalInput, setGoalInput] = useState<number | null>(null);
  const [goalDraft, setGoalDraft] = useState<number | null>(null);
  const [addingTarget, setAddingTarget] = useState(false);
  useTitle("Goals");
  const save = (patch: Partial<Settings>) => void saveSettings({ ...settings, ...patch });
  // Undo runs later, from a toast — perhaps after this screen is gone: it changes only its own
  // fields, on the settings as they are then (components/settings/undo.ts).
  const rendered = useRef(settings);
  rendered.current = settings;
  const raiseUndo = useSettingsUndo(
    (next) => void saveSettings(next),
    () => rendered.current,
  );
  /** `undo` gets the settings as they are when Undo is tapped; null: it can't be undone any more. */
  const undoable = (patch: Partial<Settings>, message: string, undo: (s: Settings) => Partial<Settings> | null) => {
    save(patch);
    raiseUndo({
      message,
      undo: (now) => {
        const back = undo(now);
        return back && { ...now, ...back };
      },
    });
  };
  // The pace sets the calorie targets, so a change is announced and can be taken back. One toast per
  // gesture (the slider commits on release); nudging again while that toast is still up replaces it,
  // and its Undo goes back to the pace from before the first nudge — then focus returns to the slider.
  const commitPace = (pace: number) => {
    if (!goal) return;
    save({ weightGoal: { ...goal, pacePctPerWeek: pace } });
    const sign = direction === "gain" ? "+" : direction === "lose" ? "−" : "";
    raiseUndo<number>({
      fold: { key: "pace", before: goal.pacePctPerWeek, after: pace },
      message: `Pace set to ${sign}${pace.toFixed(2)}%/wk`,
      undo: (now, from) => now.weightGoal && { ...now, weightGoal: { ...now.weightGoal, pacePctPerWeek: from } },
      cantUndo: "Can't undo: the goal was cleared since.",
      focus: () => document.querySelector<HTMLElement>('input[type="range"][aria-label^="Pace"]'),
    });
  };
  const goalValue = goalDraft ?? goalInput;
  const goalValid = goalValue !== null && goalValue >= 50 && goalValue <= 1000;

  const latestWeighIn = (onOrBefore: string) =>
    [...data.days].filter((d) => d.weightLb !== null && d.date <= onOrBefore).sort((a, b) => (a.date < b.date ? 1 : -1))[0]?.weightLb ??
    null;
  const startWeight = goal
    ? (goal.startLb ?? latestWeighIn(goal.setOn) ?? data.days.find((d) => d.weightLb !== null)?.weightLb ?? null)
    : null;
  const progress =
    goal && startWeight !== null && trend !== null && startWeight !== goal.targetLb
      ? (startWeight - trend) / (startWeight - goal.targetLb)
      : 0;

  return (
    <div>
      {/* The title matches the tab; the tagline is the eyebrow. */}
      <ScreenHeader eyebrow="The why" title="Goals" />
      {/* Weight goal */}
      <Section label="Goal weight">
        {goal ? (
          <>
            <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
              <div>
                <div className="num text-5xl font-light tracking-tight">
                  {fmt(goal.targetLb, goal.targetLb % 1 ? 1 : 0)}
                  <span className="ml-1 text-base text-mute">lb</span>
                </div>
                <div className="mt-2 text-xs text-mute">
                  {trend !== null ? (
                    <>
                      Trend <span className="num text-fg-2">{fmt(trend, 1)}</span> ·{" "}
                      <span className="num text-fg-2">{fmt(Math.abs(goal.targetLb - trend), 1)}</span> lb to go
                    </>
                  ) : (
                    "Weigh in to start tracking."
                  )}
                </div>
              </div>
              {projection?.range && (
                <div className="text-right">
                  <div className="label mb-1">Projected</div>
                  <div className="text-sm text-fg-2">{formatProjectedRange(projection.range, today)}</div>
                  {projection.observedRateLbPerWeek !== null && (
                    <div className="num mt-0.5 text-[0.6875rem] text-mute">actual {signed(projection.observedRateLbPerWeek, 1)} lb/wk</div>
                  )}
                </div>
              )}
              {direction === "maintain" && trend !== null && <div className="label text-gold">At goal · maintaining</div>}
            </div>
            <Bar className="mt-5" value={Math.max(0, progress)} tone={progress >= 1 ? "gold" : "accent"} />
            {startWeight !== null && (
              <div className="mt-2 flex justify-between text-[0.6875rem] text-mute">
                <span className="num">{fmt(startWeight, 1)} start</span>
                <span className="num">{Math.round(Math.max(0, progress) * 100)}%</span>
              </div>
            )}
            {direction !== "maintain" && (
              <div className="mt-7">
                <PaceSlider
                  value={goal.pacePctPerWeek}
                  onCommit={commitPace}
                  limit={direction === "gain" ? settings.limits.maxGainPctPerWeek : settings.limits.maxLossPctPerWeek}
                  bodyweight={trend}
                  direction={direction}
                />
                {/* The slider is the pace that was chosen; while the minimum holds today's target up,
                    say what the target is built for instead (the projected date above already does). */}
                <FloorNote rec={model.targets.recommendation} pace className="mt-3" />
              </div>
            )}
            <button
              type="button"
              // 44px tall; the text sits where it did (mt-6 minus the extra height above it).
              className="label mt-3 -mb-3 inline-flex min-h-11 items-center text-mute"
              onClick={() => undoable({ weightGoal: null }, "Goal cleared", (now) => (now.weightGoal ? null : { weightGoal: goal }))}
            >
              Clear goal
            </button>
          </>
        ) : (
          <div className="flex items-center gap-3">
            <BoxNumber
              ariaLabel="Goal weight"
              value={goalInput}
              onCommit={(v) => {
                setGoalInput(v);
                setGoalDraft(null);
              }}
              onDraft={setGoalDraft}
              unit="lb"
              decimals={1}
            />
            <button
              type="button"
              disabled={!goalValid}
              className="btn-primary"
              onClick={() => {
                if (!goalValid || goalValue === null) return;
                const targetLb = Math.round(goalValue * 10) / 10;
                // Bodyweight now fixes the goal's direction (cut vs build).
                const startLb = trend ?? latestWeighIn(today);
                const dir = startLb !== null ? goalDirection(startLb, targetLb) : "lose";
                setGoalDraft(null);
                save({
                  weightGoal: {
                    targetLb,
                    pacePctPerWeek: dir === "gain" ? settings.limits.maxGainPctPerWeek : settings.limits.maxLossPctPerWeek,
                    setOn: today,
                    startLb,
                  },
                });
              }}
            >
              Set goal
            </button>
          </div>
        )}
      </Section>

      {/* Strength targets */}
      <Section
        label="Strength targets"
        right={
          <button
            type="button"
            aria-label="Add strength target"
            className="tap -my-3.5 -mr-3 grid h-11 w-11 place-items-center text-mute"
            onClick={() => setAddingTarget(true)}
          >
            <Plus size={16} />
          </button>
        }
      >
        {settings.strengthTargets.length === 0 && <Empty>Pick a number worth chasing — a 600 deadlift, a 315 bench.</Empty>}
        <div className="space-y-6">
          {settings.strengthTargets.map((t, i) => {
            const ex = data.exercises.find((e) => e.id === t.exerciseId);
            const cur = currentMax(data.maxEntries, t.exerciseId)?.valueLb ?? 0;
            const done = cur >= t.targetLb;
            const name = ex?.name ?? "Lift";
            return (
              <div key={t.id}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 text-[0.9375rem] text-fg-2 wrap-anywhere">{name}</div>
                  <div className="num flex shrink-0 items-center text-sm">
                    {done && (
                      <>
                        <Trophy size={13} className="mr-1.5 text-gold" aria-hidden />
                        <span className="sr-only">Reached: </span>
                      </>
                    )}
                    <span className={done ? "text-gold" : "text-fg"}>{fmt(cur)}</span>
                    <span className="text-mute">&nbsp;/ {fmt(t.targetLb)}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${name} target`}
                      className="tap -my-3 -mr-3 ml-0.5 grid h-11 w-11 place-items-center text-mute"
                      onClick={() =>
                        undoable(
                          { strengthTargets: settings.strengthTargets.filter((x) => x.id !== t.id) },
                          `${name} target removed`,
                          (now) => {
                            if (now.strengthTargets.some((x) => x.id === t.id)) return {};
                            const list = [...now.strengthTargets];
                            list.splice(Math.min(i, list.length), 0, t);
                            return { strengthTargets: list };
                          },
                        )
                      }
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
                <Bar className="mt-2" value={t.targetLb ? cur / t.targetLb : 0} tone={done ? "gold" : "accent"} />
                {!done && cur > 0 && <div className="mt-1.5 text-[0.6875rem] text-mute">{fmt(t.targetLb - cur)} lb to go</div>}
              </div>
            );
          })}
        </div>
      </Section>

      {/* Consistency */}
      <Section label="Consistency">
        <div className="flex items-end gap-10">
          <div>
            {/* Gold is earned: a zero streak stays neutral. */}
            <div className={clsx("flex items-center gap-2", streak.current > 0 ? "text-gold" : "text-fg-2")}>
              <Flame size={18} aria-hidden />
              <span className={clsx("num text-5xl font-light", streak.current > 0 && "glow-gold")}>{streak.current}</span>
            </div>
            <div className="label mt-2">current streak</div>
          </div>
          <div>
            <div className="num text-2xl font-light text-fg-2">{streak.best}</div>
            <div className="label mt-2">best</div>
          </div>
        </div>
        <Heatmap />
      </Section>

      {/* Achievements */}
      <Section label="Achievements" right={<span className="label">{earned.length}</span>}>
        {/* What's next leads, so a long list never buries it. */}
        <NextUp current={streak.current} />
        {earned.length === 0 ? (
          <Empty>Your first one unlocks the moment you log a morning weight and a day of calories.</Empty>
        ) : (
          <AchievementList earned={earned} />
        )}
      </Section>

      <AddTargetSheet open={addingTarget} onClose={() => setAddingTarget(false)} />
    </div>
  );
}

/** Achievements shown before "Show all": years of training earn hundreds, and the newest matter most. */
const ACHIEVEMENTS_SHOWN = 12;

/** Newest first; the latest dozen, then "Show all (N)" (focus moves to the first newly shown row). */
function AchievementList({ earned }: { earned: Achievement[] }) {
  const [all, setAll] = useState(false);
  const firstHidden = useRef<HTMLLIElement>(null);
  const shown = all ? earned : earned.slice(0, ACHIEVEMENTS_SHOWN);
  const more = earned.length - shown.length;
  return (
    <>
      <ul className="space-y-4">
        {shown.map((a, i) => (
          <AchievementRow key={a.key} a={a} ref={i === ACHIEVEMENTS_SHOWN ? firstHidden : undefined} />
        ))}
      </ul>
      {more > 0 && (
        <button
          type="button"
          className="label mt-2 -mb-2 inline-flex min-h-11 items-center text-fg-2"
          onClick={() => {
            setAll(true);
            requestAnimationFrame(() => firstHidden.current?.focus());
          }}
        >
          Show all ({earned.length})
        </button>
      )}
    </>
  );
}

function AchievementRow({ a, ref }: { a: Achievement; ref?: Ref<HTMLLIElement> }) {
  const gold = a.tier === "pr" || a.tier === "goal";
  const Icon = a.tier === "pr" ? Trophy : a.tier === "streak" ? Flame : Award;
  return (
    <li ref={ref} tabIndex={ref ? -1 : undefined} className="flex items-center gap-4 rounded-lg">
      <div
        className={clsx(
          "grid h-9 w-9 shrink-0 place-items-center rounded-full",
          gold ? "bg-gold/10 text-gold" : "bg-accent/10 text-accent",
        )}
      >
        <Icon size={15} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[0.9375rem]">{a.title}</div>
        <div className="line-clamp-2 text-xs text-mute">{a.detail}</div>
      </div>
      <div className="label shrink-0">{formatShortDate(a.date)}</div>
    </li>
  );
}

function NextUp({ current }: { current: number }) {
  const next = [3, 7, 14, 30, 60, 100, 180, 365].find((t) => t > current);
  if (!next) return null;
  return (
    <div className="mb-6 flex items-center gap-4">
      <div aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-dashed border-white/20 text-faint">
        <Flame size={15} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[0.9375rem] text-mute">
          <span className="label mr-2">next</span>
          {next}-day streak
        </div>
        <div className="text-xs text-mute">
          {next - current} more closed {next - current === 1 ? "day" : "days"}
        </div>
      </div>
    </div>
  );
}

/** Heatmap cell gap and the smallest cell worth showing (WCAG 2.5.8: targets ≥ 24px). */
const HEAT_GAP = 3;
const HEAT_MIN_CELL = 25;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * Up to 16 weeks of days, Monday-first columns — as many weeks as fit with cells of at least
 * 25px (12 on a phone, 16 on a wide screen, fewer when zoomed). Closed days glow; partial days
 * fade in by progress.
 * Each past day is a button that opens it on Today; the grid is one tab stop (arrow keys move by
 * day / week, Home / End jump), named by the overall summary.
 */
function Heatmap() {
  const { data, today } = useData();
  const navigate = useNavigate();
  // Fit the number of weeks to the width. The ResizeObserver's first callback comes after layout
  // and before paint (so it never flashes) without forcing a synchronous layout on navigation.
  const gridRef = useRef<HTMLDivElement>(null);
  const [weeks, setWeeks] = useState(12);
  useEffect(() => {
    const el = gridRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry?.contentRect.width ?? 0;
      if (w > 0) setWeeks(Math.max(4, Math.min(16, Math.floor((w + HEAT_GAP) / (HEAT_MIN_CELL + HEAT_GAP)))));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const start = addDays(startOfWeek(today), -(weeks - 1) * 7);
  const byDate = useMemo(() => new Map(data.days.map((d) => [d.date, d])), [data.days]);
  const sessions = useMemo(() => new Map(data.sessions.map((s) => [s.date, s])), [data.sessions]);
  const cols = Array.from({ length: weeks }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => {
      const date = addDays(start, w * 7 + d);
      if (date > today) return { date, v: -1, done: 0, total: 0 };
      const day = byDate.get(date);
      // The same rule as streaks and Today (a plan done early credits its own day).
      const items = dayChecklist(date, data);
      const done = !day && !sessions.get(date) && !items.some((i) => i.done) ? 0 : items.filter((i) => i.done).length;
      return { date, v: items.length ? done / items.length : 0, done, total: items.length };
    }),
  );
  const flat = cols.flat();
  const past = flat.filter((c) => c.v >= 0);
  const closed = past.filter((c) => c.v >= 1).length;
  const partial = past.filter((c) => c.v > 0 && c.v < 1).length;
  const todayCell = past.find((c) => c.date === today);
  const summary =
    `Closed days, last ${weeks} weeks: ${closed} closed, ${partial} partly done, ${past.length - closed - partial} empty.` +
    (todayCell ? ` Today is ${todayCell.v >= 1 ? "closed" : `${Math.round(todayCell.v * 100)}% done`}.` : "");

  // Roving focus: one cell is tabbable (today, until the person moves).
  const lastPast = flat.findLastIndex((c) => c.v >= 0);
  const [focus, setFocus] = useState<number | null>(null);
  const active = focus !== null && focus <= lastPast ? focus : lastPast;
  const cells = useRef<Array<HTMLButtonElement | null>>([]);
  const moveTo = (i: number) => {
    const n = Math.max(0, Math.min(lastPast, i));
    setFocus(n);
    cells.current[n]?.focus();
  };
  const onKey = (e: ReactKeyboardEvent, i: number) => {
    const step: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 };
    if (e.key in step) moveTo(i + step[e.key]!);
    else if (e.key === "Home") moveTo(0);
    else if (e.key === "End") moveTo(lastPast);
    else return;
    e.preventDefault();
  };
  const describe = (c: (typeof flat)[number]) =>
    `${weekdayName(c.date)}, ${formatShortDate(c.date, c.date.slice(0, 4) !== today.slice(0, 4))}: ` +
    (c.v >= 1 ? `closed, all ${c.total} done` : c.done ? `${c.done} of ${c.total} done` : "nothing logged") +
    (c.date === today ? " (today)" : "");

  // Month names over the first column and where a new month starts (by the week's Monday). The
  // first column's name is dropped when the next month starts one column later (they'd collide).
  const months = cols.map((col, i) => {
    const m = col[0]!.date.slice(5, 7);
    const starts = i === 0 || m !== cols[i - 1]![0]!.date.slice(5, 7);
    const crowded = i === 0 && cols.length > 1 && cols[1]![0]!.date.slice(5, 7) !== m;
    return starts && !crowded ? MONTHS[Number(m) - 1]! : null;
  });

  return (
    <div className="mt-8">
      <div aria-hidden data-heat-months="" className="mb-1.5 flex" style={{ gap: HEAT_GAP }}>
        {months.map((m, i) => (
          <div key={i} className="relative h-3.5 min-w-0 flex-1">
            {m && (
              <span
                className={clsx(
                  "absolute bottom-0 font-mono text-2xs leading-none tracking-[0.08em] whitespace-nowrap text-mute uppercase",
                  // The last column's name hangs inwards so it never runs past the edge.
                  i === months.length - 1 ? "right-0" : "left-0",
                )}
              >
                {m}
              </span>
            )}
          </div>
        ))}
      </div>
      <div
        ref={gridRef}
        className="flex justify-between"
        style={{ gap: HEAT_GAP }}
        role="group"
        aria-label={`${summary} Choose a day to open it.`}
      >
        {cols.map((col, i) => (
          <div key={i} className="flex min-w-0 flex-1 flex-col" style={{ gap: HEAT_GAP }}>
            {col.map((c, d) => {
              const idx = i * 7 + d;
              const style = heatStyle(c.v);
              const motionProps = { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { delay: i * 0.02 } };
              // Today's ring is drawn by ::after, so the focus outline (:focus-visible) still shows on it.
              const cls = clsx(
                "relative grid aspect-square w-full place-items-center rounded-[3px]",
                c.date === today &&
                  "after:pointer-events-none after:absolute after:-inset-[2px] after:rounded-[5px] after:border after:border-white/60 after:content-['']",
              );
              // Today is marked by shape too, not just the outline colour.
              const dot = c.date === today && <span className={clsx("h-1 w-1 rounded-full", c.v >= 1 ? "bg-accent-ink" : "bg-fg")} />;
              if (c.v < 0) return <motion.div key={c.date} aria-hidden className={cls} style={style} {...motionProps} />;
              return (
                <motion.button
                  key={c.date}
                  ref={(el: HTMLButtonElement | null) => {
                    cells.current[idx] = el;
                  }}
                  type="button"
                  tabIndex={idx === active ? 0 : -1}
                  aria-label={describe(c)}
                  title={describe(c)}
                  className={clsx(cls, "cursor-pointer")}
                  style={style}
                  {...motionProps}
                  onFocus={() => setFocus(idx)}
                  onKeyDown={(e) => onKey(e, idx)}
                  onClick={() => navigate(c.date === today ? "/" : `/day/${c.date}`)}
                >
                  {dot}
                </motion.button>
              );
            })}
          </div>
        ))}
      </div>
      <HeatLegend />
    </div>
  );
}

/** A heatmap cell's fill for a day `v` done (0…1; below 0: a day still to come). */
function heatStyle(v: number): { background: string; boxShadow?: string } {
  return {
    background:
      v < 0
        ? "transparent"
        : v >= 1
          ? "var(--color-accent)"
          : v > 0
            ? // Partial days start a clear step above empty ones (1.4.11) and fade in by progress.
              `rgb(183 243 106 / ${0.16 + v * 0.26})`
            : "rgba(255,255,255,0.06)",
    boxShadow: v >= 1 ? "0 0 8px -1px rgb(183 243 106 / 0.6)" : undefined,
  };
}

/**
 * What the cells' shades mean, in words beside a sample of each (drawn by the same `heatStyle`):
 * nothing logged, partly done (brighter the more of the day's list is done), closed, and today's ring.
 */
function HeatLegend() {
  const swatch = "relative grid h-2.5 w-2.5 shrink-0 place-items-center rounded-[2px]";
  return (
    <ul data-heat-legend="" aria-label="Legend" className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[0.6875rem] leading-none text-mute">
      <li className="flex items-center gap-1.5">
        <span aria-hidden className={swatch} style={heatStyle(0)} />
        Nothing logged
      </li>
      <li className="flex items-center gap-1.5">
        {/* Two steps of the fade, so "partly" doesn't read as one fixed shade. */}
        <span aria-hidden className={swatch} style={heatStyle(0.25)} />
        <span aria-hidden className={clsx(swatch, "-ml-0.5")} style={heatStyle(0.75)} />
        Partly done
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden className={swatch} style={heatStyle(1)} />
        Closed
      </li>
      <li className="flex items-center gap-1.5">
        <span
          aria-hidden
          className={clsx(
            swatch,
            "mx-0.5",
            "after:pointer-events-none after:absolute after:-inset-[2px] after:rounded-[4px] after:border after:border-white/60 after:content-['']",
          )}
          style={heatStyle(0)}
        >
          <span className="h-0.5 w-0.5 rounded-full bg-fg" />
        </span>
        Today
      </li>
    </ul>
  );
}

function AddTargetSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, today } = useData();
  const saveSettings = useSaveSettings();
  const tracked = data.exercises.filter((e) => e.tracksMax && !e.archived);
  const [exerciseId, setExerciseId] = useState<number | null>(null);
  const [target, setTarget] = useState<number | null>(null);
  const [draft, setDraft] = useState<number | null>(null);
  const value = draft ?? target;
  const valid = value !== null && value >= 1 && value <= 2000;
  const sel = exerciseId ?? tracked[0]?.id ?? null;
  const cur = sel !== null ? currentMax(data.maxEntries, sel)?.valueLb : undefined;
  return (
    <Sheet open={open} onClose={onClose} title="New strength target">
      <div className="flex flex-wrap gap-2">
        {tracked.map((e) => (
          <button
            key={e.id}
            type="button"
            aria-pressed={sel === e.id}
            onClick={() => setExerciseId(e.id)}
            className={clsx("chip max-w-full wrap-anywhere", sel === e.id ? "bg-accent text-accent-ink" : "bg-white/[0.05] text-fg-2")}
          >
            {e.name}
          </button>
        ))}
      </div>
      <div className="mt-6 flex items-center justify-between">
        <span className="text-sm text-mute">{cur ? `Current max ${fmt(cur)}` : "No max yet"}</span>
        <BoxNumber
          ariaLabel="Target"
          value={target}
          onCommit={(v) => {
            setTarget(v);
            setDraft(null);
          }}
          onDraft={setDraft}
          unit="lb"
          min={1}
          max={2000}
        />
      </div>
      <button
        type="button"
        disabled={!sel || !valid}
        className="btn-primary mt-6 w-full"
        onClick={async () => {
          if (!sel || !valid || value === null) return;
          await saveSettings({
            ...data.settings,
            strengthTargets: [
              ...data.settings.strengthTargets,
              { id: newId(), exerciseId: sel, targetLb: Math.round(value), setOn: today },
            ],
          });
          setTarget(null);
          setDraft(null);
          onClose();
        }}
      >
        Add target
      </button>
    </Sheet>
  );
}
