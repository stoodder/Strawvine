import clsx from "clsx";
import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import { addDays, formatShortDate } from "../../shared/dates";
import { displayPrefs } from "../../shared/defaults";
import { CALIBRATION_DAYS, computeEnergySeries } from "../../shared/energy";
import { currentMax } from "../../shared/program";
import type { Exercise } from "../../shared/schemas";
import { LineChart, Sparkline } from "../components/charts";
import { MaxSheet } from "../components/MaxSheet";
import { Bar, Section, Stat } from "../components/ui";
import { Calibration } from "../components/Calibration";
import { IntakeStrip } from "../components/progress/IntakeStrip";
import { formatProjectedRange } from "../components/projection";
import { useTitle } from "../components/useTitle";
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
  useTitle("Progress");

  const first = data.days.find((d) => d.weightLb !== null || d.calories !== null)?.date ?? today;
  const series = useMemo(() => {
    const from = range ? addDays(today, -(range - 1)) : first < today ? first : addDays(today, -6);
    return computeEnergySeries(data.days, from, today, data.settings.nutrition.kcalPerLb);
  }, [data.days, data.settings.nutrition.kcalPerLb, range, today, first]);

  const loggedCount = model.todayEnergy?.loggedCount ?? 0;
  const tracked = data.exercises.filter((e) => e.tracksMax && !e.archived);
  const goal = data.settings.weightGoal;
  const strong = displayPrefs(data.settings).highContrast;

  return (
    <div>
      <header className="pt-2">
        <div className="label text-fg-2">Progress</div>
        <h1 className="mt-6 text-[2.75rem] leading-none font-light tracking-tight">The trend</h1>
      </header>

      {/* Weekly check-in */}
      <Section
        label="Weekly check-in"
        right={
          <span className="label">
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
                sub={
                  !c.tdee
                    ? "—"
                    : !c.tdee.provisional
                      ? "learned from your logs"
                      : c.tdee.confidence > 0
                        ? `still learning · ${Math.round(c.tdee.confidence * 100)}% from your logs`
                        : "starting estimate"
                }
              />
              <Stat
                label="Trend weight"
                value={fmt(c.trendWeight, 1)}
                unit="lb"
                sub={
                  c.weightChangeLb !== null ? (
                    <>
                      <span className="text-fg-2">{signed(c.weightChangeLb, 1)} lb</span> this week
                      {c.targetRateLbPerWeek ? <span> · plan {signed(c.targetRateLbPerWeek, 1)}</span> : null}
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
              ).map(([label, v]) => {
                const met = v.planned > 0 && v.done >= v.planned;
                return (
                  <div key={label}>
                    <div className="label mb-1.5">{label}</div>
                    <div className="num flex items-center gap-1.5 text-lg font-light">
                      <span>
                        {v.done}
                        <span className="text-sm text-mute">/{v.planned}</span>
                      </span>
                      {/* Not colour alone: a met week also gets a check. */}
                      {met && (
                        <>
                          <Check size={14} strokeWidth={2.5} className="text-gold" aria-hidden />
                          <span className="sr-only">all done</span>
                        </>
                      )}
                    </div>
                    <Bar className="mt-2" value={v.planned ? v.done / v.planned : 0} tone={met ? "gold" : "accent"} />
                  </div>
                );
              })}
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
                {goal.targetLb} lb projected <span className="text-fg-2">{formatProjectedRange(c.projection.range, today)}</span>
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
          <div className="flex" role="group" aria-label="Chart range">
            {RANGES.map(([l, v]) => (
              <button
                key={l}
                type="button"
                aria-pressed={range === v}
                aria-label={v ? `${l} days` : "All time"}
                onClick={() => setRange(v)}
                className={clsx(
                  // Small pill, 44px-wide and (invisibly) 44px-tall target.
                  "tap relative inline-flex min-w-11 justify-center rounded-full px-2.5 py-0.5 text-xs font-medium after:absolute after:-inset-y-3 after:inset-x-0 after:content-['']",
                  range === v ? "bg-white/[0.08] text-fg" : "text-mute",
                )}
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
          title="Bodyweight"
          strong={strong}
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
              color: "var(--color-accent)",
              points: series.map((d) => ({ x: d.date, y: d.avgTdee })),
              format: (v) => fmt(v),
            },
          ]}
          emptyText="Two logged days and the burn estimate starts drawing."
          title="Energy balance"
          strong={strong}
        />
        <p className="mt-3 text-xs leading-relaxed text-mute">
          Weighted 7-day averages. The gap between the lines is the surplus or deficit your scale is actually responding to.
        </p>
        <IntakeStrip data={data} series={model.series} today={today} />
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
                  <div className="text-[0.9375rem] text-fg-2">{ex.name}</div>
                  <div className="mt-0.5 text-xs text-mute">
                    {cur && start !== undefined && cur.valueLb !== start ? (
                      <>
                        <span className="text-accent">{signed(cur.valueLb - start, 0)} lb</span> since start
                      </>
                    ) : cur ? (
                      "no change yet"
                    ) : (
                      "no max yet"
                    )}
                    {target && <span> · target {fmt(target.targetLb)}</span>}
                  </div>
                </div>
                <Sparkline points={entries.map((e) => e.valueLb)} width={72} height={24} strong={strong} />
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
