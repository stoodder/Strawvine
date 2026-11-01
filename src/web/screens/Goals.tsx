import clsx from "clsx";
import { motion } from "motion/react";
import { useMemo, useState } from "react";
import { Award, Flame, Plus, Trash2, Trophy } from "lucide-react";
import { addDays, formatShortDate, startOfWeek } from "../../shared/dates";
import { achievements, checklist, streaks, type Achievement } from "../../shared/gamify";
import { goalDirection, project } from "../../shared/nutrition";
import { currentMax } from "../../shared/program";
import { newId } from "../../shared/session";
import type { Settings } from "../../shared/schemas";
import { PaceSlider } from "../components/PaceSlider";
import { Bar, BoxNumber, Empty, Section, Sheet } from "../components/ui";
import { fmt, signed } from "../lib/format";
import { useData, useSaveSettings } from "../lib/store";

export function GoalsScreen() {
  const { data, today, model } = useData();
  const saveSettings = useSaveSettings();
  const settings = data.settings;
  const goal = settings.weightGoal;
  const trend = model.todayEnergy?.avgWeight ?? null;
  const weekAgo = model.series.find((d) => d.date === addDays(today, -7))?.avgWeight ?? null;
  const projection = goal && trend !== null ? project(settings, today, trend, weekAgo) : null;
  const direction = goal && trend !== null ? goalDirection(trend, goal.targetLb, goal.startLb) : "maintain";
  const streak = useMemo(() => streaks(data, today), [data, today]);
  const earned = useMemo(() => achievements(data, today), [data, today]);
  const [goalInput, setGoalInput] = useState<number | null>(null);
  const [addingTarget, setAddingTarget] = useState(false);

  const save = (patch: Partial<Settings>) => void saveSettings({ ...settings, ...patch });

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
      <header className="pt-2">
        <div className="label text-fg-2">Goals</div>
        <h1 className="mt-6 text-[44px] leading-none font-light tracking-tight">The why</h1>
      </header>

      {/* Weight goal */}
      <Section label="Goal weight">
        {goal ? (
          <>
            <div className="flex items-end justify-between">
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
                  <div className="text-sm text-fg-2">
                    {projection.range[0] === projection.range[1]
                      ? formatShortDate(projection.range[0], true)
                      : `${formatShortDate(projection.range[0])} – ${formatShortDate(projection.range[1])}`}
                  </div>
                  {projection.observedRateLbPerWeek !== null && (
                    <div className="num mt-0.5 text-[11px] text-faint">actual {signed(projection.observedRateLbPerWeek, 1)} lb/wk</div>
                  )}
                </div>
              )}
              {direction === "maintain" && trend !== null && <div className="label text-gold">At goal · maintaining</div>}
            </div>
            <Bar className="mt-5" value={Math.max(0, progress)} tone={progress >= 1 ? "gold" : "accent"} />
            {startWeight !== null && (
              <div className="mt-2 flex justify-between text-[11px] text-faint">
                <span className="num">{fmt(startWeight, 1)} start</span>
                <span className="num">{Math.round(Math.max(0, progress) * 100)}%</span>
              </div>
            )}
            {direction !== "maintain" && (
              <div className="mt-7">
                <PaceSlider
                  value={goal.pacePctPerWeek}
                  onChange={(v) => save({ weightGoal: { ...goal, pacePctPerWeek: v } })}
                  limit={direction === "gain" ? settings.limits.maxGainPctPerWeek : settings.limits.maxLossPctPerWeek}
                  bodyweight={trend}
                  direction={direction}
                />
              </div>
            )}
            <button type="button" className="label mt-6 text-faint" onClick={() => save({ weightGoal: null })}>
              Clear goal
            </button>
          </>
        ) : (
          <div className="flex items-center gap-3">
            <BoxNumber ariaLabel="Goal weight" value={goalInput} onCommit={setGoalInput} unit="lb" decimals={1} />
            <button
              type="button"
              disabled={!goalInput}
              className="btn-primary disabled:opacity-30"
              onClick={() => {
                if (!goalInput) return;
                // Bodyweight now fixes the goal's direction (cut vs build).
                const startLb = trend ?? latestWeighIn(today);
                const dir = startLb !== null ? goalDirection(startLb, goalInput) : "lose";
                save({
                  weightGoal: {
                    targetLb: goalInput,
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
          <button type="button" aria-label="Add strength target" className="tap -mr-1 p-1 text-mute" onClick={() => setAddingTarget(true)}>
            <Plus size={16} />
          </button>
        }
      >
        {settings.strengthTargets.length === 0 && <Empty>Pick a number worth chasing — a 600 deadlift, a 315 bench.</Empty>}
        <div className="space-y-6">
          {settings.strengthTargets.map((t) => {
            const ex = data.exercises.find((e) => e.id === t.exerciseId);
            const cur = currentMax(data.maxEntries, t.exerciseId)?.valueLb ?? 0;
            const done = cur >= t.targetLb;
            return (
              <div key={t.id}>
                <div className="flex items-baseline justify-between">
                  <div className="text-[15px] text-fg-2">{ex?.name}</div>
                  <div className="num text-sm">
                    <span className={done ? "text-gold" : "text-fg"}>{fmt(cur)}</span>
                    <span className="text-mute"> / {fmt(t.targetLb)}</span>
                    <button
                      type="button"
                      aria-label="Remove target"
                      className="tap ml-3 align-middle text-faint"
                      onClick={() => save({ strengthTargets: settings.strengthTargets.filter((x) => x.id !== t.id) })}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
                <Bar className="mt-2" value={t.targetLb ? cur / t.targetLb : 0} tone={done ? "gold" : "accent"} />
                {!done && cur > 0 && <div className="mt-1.5 text-[11px] text-faint">{fmt(t.targetLb - cur)} lb to go</div>}
              </div>
            );
          })}
        </div>
      </Section>

      {/* Consistency */}
      <Section label="Consistency">
        <div className="flex items-end gap-10">
          <div>
            <div className="flex items-center gap-2 text-gold">
              <Flame size={18} />
              <span className="num glow-gold text-5xl font-light">{streak.current}</span>
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
      <Section label="Achievements" right={<span className="label text-faint">{earned.length}</span>}>
        {earned.length === 0 ? (
          <Empty>Your first one unlocks the moment you log a morning weight and a day of calories.</Empty>
        ) : (
          <ul className="space-y-4">
            {earned.map((a) => (
              <AchievementRow key={a.key} a={a} />
            ))}
          </ul>
        )}
        <NextUp current={streak.current} />
      </Section>

      <AddTargetSheet open={addingTarget} onClose={() => setAddingTarget(false)} />
    </div>
  );
}

function AchievementRow({ a }: { a: Achievement }) {
  const gold = a.tier === "pr" || a.tier === "goal";
  const Icon = a.tier === "pr" ? Trophy : a.tier === "streak" ? Flame : Award;
  return (
    <li className="flex items-center gap-4">
      <div
        className={clsx(
          "grid h-9 w-9 shrink-0 place-items-center rounded-full",
          gold ? "bg-gold/10 text-gold" : "bg-accent/10 text-accent",
        )}
      >
        <Icon size={15} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px]">{a.title}</div>
        <div className="truncate text-xs text-mute">{a.detail}</div>
      </div>
      <div className="label shrink-0">{formatShortDate(a.date)}</div>
    </li>
  );
}

function NextUp({ current }: { current: number }) {
  const next = [3, 7, 14, 30, 60, 100, 180, 365].find((t) => t > current);
  if (!next) return null;
  return (
    <div className="mt-6 flex items-center gap-4 opacity-60">
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full ring-1 ring-white/10 ring-dashed text-faint">
        <Flame size={15} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[15px] text-fg-2">{next}-day streak</div>
        <div className="text-xs text-mute">
          {next - current} more closed {next - current === 1 ? "day" : "days"}
        </div>
      </div>
    </div>
  );
}

/** 16 weeks of days, Monday-first columns. Closed days glow; partial days fade in by progress. */
function Heatmap() {
  const { data, today } = useData();
  const weeks = 16;
  const start = addDays(startOfWeek(today), -(weeks - 1) * 7);
  const byDate = useMemo(() => new Map(data.days.map((d) => [d.date, d])), [data.days]);
  const sessions = useMemo(() => new Map(data.sessions.map((s) => [s.date, s])), [data.sessions]);
  const cols = Array.from({ length: weeks }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => {
      const date = addDays(start, w * 7 + d);
      if (date > today) return { date, v: -1 };
      const day = byDate.get(date);
      if (!day && !sessions.get(date)) return { date, v: 0 };
      const items = checklist(date, day, sessions.get(date), data.settings);
      return { date, v: items.filter((i) => i.done).length / items.length };
    }),
  );
  return (
    <div className="mt-8 flex justify-between gap-[3px]" aria-label="Closed days, last 16 weeks">
      {cols.map((col, i) => (
        <div key={i} className="flex flex-1 flex-col gap-[3px]">
          {col.map((c) => (
            <motion.div
              key={c.date}
              title={c.date}
              className="aspect-square w-full rounded-[3px]"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: i * 0.02 }}
              style={{
                background:
                  c.v < 0
                    ? "transparent"
                    : c.v >= 1
                      ? "var(--color-accent)"
                      : c.v > 0
                        ? `rgb(183 243 106 / ${0.08 + c.v * 0.3})`
                        : "rgba(255,255,255,0.04)",
                boxShadow: c.v >= 1 ? "0 0 8px -1px rgb(183 243 106 / 0.6)" : undefined,
                outline: c.date === today ? "1px solid rgba(255,255,255,0.35)" : undefined,
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function AddTargetSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, today } = useData();
  const saveSettings = useSaveSettings();
  const tracked = data.exercises.filter((e) => e.tracksMax && !e.archived);
  const [exerciseId, setExerciseId] = useState<number | null>(null);
  const [target, setTarget] = useState<number | null>(null);
  const sel = exerciseId ?? tracked[0]?.id ?? null;
  const cur = sel !== null ? currentMax(data.maxEntries, sel)?.valueLb : undefined;
  return (
    <Sheet open={open} onClose={onClose} title="New strength target">
      <div className="flex flex-wrap gap-2">
        {tracked.map((e) => (
          <button
            key={e.id}
            type="button"
            onClick={() => setExerciseId(e.id)}
            className={clsx("chip", sel === e.id ? "bg-accent text-accent-ink" : "bg-white/[0.05] text-fg-2")}
          >
            {e.name}
          </button>
        ))}
      </div>
      <div className="mt-6 flex items-center justify-between">
        <span className="text-sm text-mute">{cur ? `Current max ${fmt(cur)}` : "No max yet"}</span>
        <BoxNumber ariaLabel="Target" value={target} onCommit={setTarget} unit="lb" />
      </div>
      <button
        type="button"
        disabled={!sel || !target}
        className="btn-primary mt-6 w-full disabled:opacity-30"
        onClick={async () => {
          if (!sel || !target) return;
          await saveSettings({
            ...data.settings,
            strengthTargets: [...data.settings.strengthTargets, { id: newId(), exerciseId: sel, targetLb: target, setOn: today }],
          });
          setTarget(null);
          onClose();
        }}
      >
        Add target
      </button>
    </Sheet>
  );
}
