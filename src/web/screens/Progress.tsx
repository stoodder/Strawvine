import clsx from "clsx";
import { useMemo, useState } from "react";
import { addDays, formatShortDate } from "../../shared/dates";
import { CALIBRATION_DAYS, computeEnergySeries } from "../../shared/energy";
import { currentMax } from "../../shared/program";
import type { Exercise } from "../../shared/schemas";
import { LineChart, Sparkline } from "../components/charts";
import { MaxSheet } from "../components/MaxSheet";
import { Bar, Section, Stat } from "../components/ui";
import { Calibration } from "../components/Calibration";
import { fmt, minutesToHM, signed } from "../lib/format";
import { useData } from "../lib/store";

const RANGES = [
  ["30", 30],
  ["90", 90],
  ["All", 0],
] as const;

function firstLoggedOr(days: ReadonlyArray<{ date: string; weightLb: number | null; calories: number | null }>, fallback: string) {
  return days.find((d) => d.weightLb !== null && d.calories !== null)?.date ?? fallback;
}

export function ProgressScreen() {
  const { data, today, model } = useData();
  const [range, setRange] = useState<number>(30);
  const [maxFor, setMaxFor] = useState<Exercise | null>(null);
  const c = model.checkin;

  const first = data.days.find((d) => d.weightLb !== null || d.calories !== null)?.date ?? today;
  const series = useMemo(() => {
    const from = range ? addDays(today, -(range - 1)) : first < today ? first : addDays(today, -6);
    return computeEnergySeries(data.days, from, today, data.settings.nutrition.kcalPerLb);
  }, [data.days, data.settings.nutrition.kcalPerLb, range, today, first]);

  const loggedCount = model.todayEnergy?.loggedCount ?? 0;
  const tracked = data.exercises.filter((e) => e.tracksMax && !e.archived);
  const goal = data.settings.weightGoal;

  return (
    <div>
      <header className="pt-2">
        <div className="label text-fg-2">Progress</div>
        <h1 className="mt-6 text-[44px] leading-none font-light tracking-tight">The trend</h1>
      </header>

      {/* Weekly check-in */}
      <Section
        label="Weekly check-in"
        right={
          <span className="label text-faint">
            {formatShortDate(c.from)} – {formatShortDate(c.to)}
          </span>
        }
      >
        {c.daysLogged === 0 && c.tdee === null ? (
          <p className="text-sm leading-relaxed text-mute">
            Your first check-in builds itself from a week of mornings and meals. Log weight and calories daily and it lands here on{" "}
            <span className="text-fg-2">{formatShortDate(addDays(firstLoggedOr(data.days, today), 7))}</span>.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-x-6 gap-y-7">
              <Stat
                label="TDEE"
                value={fmt(c.tdee?.value)}
                unit="kcal"
                tone="accent"
                sub={!c.tdee ? "—" : c.tdee.provisional ? `provisional · ${Math.round(c.tdee.confidence * 100)}% measured` : "measured"}
              />
              <Stat
                label="Trend weight"
                value={fmt(c.trendWeight, 1)}
                unit="lb"
                sub={
                  c.weightChangeLb !== null ? (
                    <>
                      <span className="text-fg-2">{signed(c.weightChangeLb, 1)} lb</span> this week
                      {c.targetRateLbPerWeek ? <span className="text-faint"> · plan {signed(c.targetRateLbPerWeek, 1)}</span> : null}
                    </>
                  ) : (
                    "needs a week of data"
                  )
                }
              />
              <Stat
                label="Avg intake"
                value={fmt(c.avgCalories)}
                unit="kcal"
                size="sm"
                sub={
                  c.calorieAdherence !== null
                    ? `${Math.round(c.calorieAdherence * 100)}% of days on target`
                    : `${c.daysLogged}/7 days logged`
                }
              />
              <Stat
                label="Avg protein"
                value={fmt(c.avgProtein)}
                unit="g"
                size="sm"
                sub={c.next ? `target ${fmt(c.next.macros.proteinG)} g` : undefined}
              />
              <Stat label="Avg steps" value={fmt(c.avgSteps)} size="sm" sub={`target ${fmt(data.settings.targets.steps)}`} />
              <Stat
                label="Sleep · HRV"
                value={c.avgSleepMinutes !== null ? minutesToHM(c.avgSleepMinutes) : "—"}
                size="sm"
                sub={c.avgHrv !== null ? `HRV ${fmt(c.avgHrv)} ms` : undefined}
              />
            </div>

            <div className="mt-8 grid grid-cols-3 gap-5">
              {(
                [
                  ["Lifts", c.lifts],
                  ["Metcon", c.metcon],
                  ["Zone 2", c.zone2],
                ] as const
              ).map(([label, v]) => (
                <div key={label}>
                  <div className="label mb-1.5">{label}</div>
                  <div className="num text-lg font-light">
                    {v.done}
                    <span className="text-sm text-mute">/{v.planned}</span>
                  </div>
                  <Bar
                    className="mt-2"
                    value={v.planned ? v.done / v.planned : 0}
                    tone={v.planned && v.done >= v.planned ? "gold" : "accent"}
                  />
                </div>
              ))}
            </div>
          </>
        )}
        {c.next && c.daysLogged > 0 && (
          <div className="mt-8 rounded-3xl bg-gradient-to-br from-accent/[0.09] to-transparent p-5 ring-1 ring-accent/15">
            <div className="label text-accent">Next week</div>
            <div className="mt-3 flex items-end justify-between gap-4">
              <div className="num text-4xl font-light tracking-tight">
                {fmt(c.next.calories)}
                <span className="ml-1 text-sm text-mute">kcal/day</span>
              </div>
              <div className="num pb-1 text-right text-xs leading-relaxed text-fg-2">
                P {fmt(c.next.macros.proteinG)} · C {fmt(c.next.macros.carbsG)} · F {fmt(c.next.macros.fatG)}
              </div>
            </div>
            {c.projection?.range && goal && (
              <p className="mt-3 text-xs text-mute">
                {goal.targetLb} lb projected{" "}
                <span className="text-fg-2">
                  {c.projection.range[0] === c.projection.range[1]
                    ? formatShortDate(c.projection.range[0], true)
                    : `${formatShortDate(c.projection.range[0])} – ${formatShortDate(c.projection.range[1], true)}`}
                </span>
              </p>
            )}
          </div>
        )}
        {loggedCount < CALIBRATION_DAYS && (
          <div className="mt-8">
            <Calibration logged={loggedCount} />
          </div>
        )}
      </Section>

      {/* Charts */}
      <Section
        label="Bodyweight"
        right={
          <div className="flex gap-1">
            {RANGES.map(([l, v]) => (
              <button
                key={l}
                type="button"
                onClick={() => setRange(v)}
                className={clsx("chip px-2.5 py-0.5", range === v ? "bg-white/[0.08] text-fg" : "text-mute")}
              >
                {l}
              </button>
            ))}
          </div>
        }
      >
        <LineChart
          series={[
            {
              key: "raw",
              label: "Scale",
              kind: "dots",
              color: "var(--color-fg-2)",
              points: series.map((d) => ({ x: d.date, y: d.weightLb })),
              format: (v) => v.toFixed(1),
            },
            {
              key: "avg",
              label: "Trend",
              kind: "line",
              color: "var(--color-accent)",
              points: series.map((d) => ({ x: d.date, y: d.avgWeight })),
              format: (v) => v.toFixed(1),
            },
          ]}
          refLine={goal ? { y: goal.targetLb, label: `goal ${goal.targetLb}` } : undefined}
          emptyText="Weigh in a couple of mornings to see your trend."
        />
      </Section>

      <Section label="Energy balance">
        <LineChart
          series={[
            {
              key: "intake",
              label: "Intake",
              kind: "line",
              color: "var(--color-fg-2)",
              points: series.map((d) => ({ x: d.date, y: d.avgCalories })),
              format: (v) => fmt(v),
            },
            {
              key: "tdee",
              label: "TDEE",
              kind: "line",
              color: "var(--color-glow)",
              points: series.map((d) => ({ x: d.date, y: d.avgTdee })),
              format: (v) => fmt(v),
            },
          ]}
          emptyText="Two logged days and the burn estimate starts drawing."
        />
        <p className="mt-3 text-xs leading-relaxed text-faint">
          Weighted 7-day averages. The gap between the lines is the surplus or deficit your scale is actually responding to.
        </p>
      </Section>

      {/* Lifts */}
      <Section label="Maxes">
        <div className="-mx-1">
          {tracked.map((ex) => {
            const entries = data.maxEntries
              .filter((e) => e.exerciseId === ex.id)
              .sort((a, b) => (a.date === b.date ? (a.createdAt < b.createdAt ? -1 : 1) : a.date < b.date ? -1 : 1));
            const cur = currentMax(data.maxEntries, ex.id);
            const start = entries[0]?.valueLb;
            const target = data.settings.strengthTargets.find((t) => t.exerciseId === ex.id);
            return (
              <button
                key={ex.id}
                type="button"
                onClick={() => setMaxFor(ex)}
                className="tap flex w-full items-center gap-4 rounded-2xl px-1 py-3.5 text-left"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] text-fg-2">{ex.name}</div>
                  <div className="mt-0.5 text-xs text-mute">
                    {cur && start !== undefined && cur.valueLb !== start ? (
                      <span className="text-accent">{signed(cur.valueLb - start, 0)} lb</span>
                    ) : cur ? (
                      "since start"
                    ) : (
                      "no max yet"
                    )}
                    {target && <span className="text-faint"> · target {target.targetLb}</span>}
                  </div>
                </div>
                <Sparkline points={entries.map((e) => e.valueLb)} width={72} height={24} />
                <div className="num w-16 text-right text-2xl font-light">{cur ? fmt(cur.valueLb, cur.valueLb % 1 ? 1 : 0) : "—"}</div>
              </button>
            );
          })}
        </div>
      </Section>

      <MaxSheet exercise={maxFor} open={!!maxFor} onClose={() => setMaxFor(null)} />
    </div>
  );
}
