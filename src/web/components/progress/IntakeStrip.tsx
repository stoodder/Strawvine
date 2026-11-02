import clsx from "clsx";
import { motion, useReducedMotion } from "motion/react";
import { memo, useMemo } from "react";
import { addDays, dateRange, formatShortDate, weekdayName } from "../../../shared/dates";
import type { EnergyDay } from "../../../shared/energy";
import type { AppData } from "../../../shared/gamify";
import { targetsFor } from "../../../shared/insights";
import { overTargetSeverity } from "../../../shared/nutrition";
import { fmt } from "../../lib/format";
import { severityClass, severityColor } from "../ui";

/** Where the target sits in each column; above it is room for overs (up to 1/TARGET_AT × target). */
const TARGET_AT = 0.7;

interface StripDay {
  date: string;
  eaten: number | null;
  target: number | null;
}

/**
 * The last seven days of calories eaten against each day's own target (from `targetsFor`, i.e.
 * the engine as of the day before). Under or on target in lime; over (past the same tolerance as
 * Today's calorie bar, `overTargetSeverity`) is neutral up to the target with the excess in the
 * same over-target colour as that bar (`severityColor`: caution yellow → warn red), so a day 6 %
 * over looks alike on both screens. A day without calories or a target is a dim stub. Today is
 * still in progress and says so.
 */
export const IntakeStrip = memo(function IntakeStrip({
  data,
  series,
  today,
}: {
  data: AppData;
  series: ReadonlyArray<EnergyDay>;
  today: string;
}) {
  const reduce = useReducedMotion();
  // Memoised on the data itself (not every Progress render: the range toggle, the chart's
  // table…). Calories come from one pass over the days instead of a scan per column.
  const days = useMemo<StripDay[]>(() => stripDays(data, series, today), [data, series, today]);
  if (days.every((d) => d.eaten === null)) return null;

  const describe = (d: StripDay) => {
    const when = d.date === today ? "Today so far" : `${weekdayName(d.date)} ${formatShortDate(d.date)}`;
    if (d.eaten === null) return `${when}: no calories logged`;
    if (d.target === null) return `${when}: ${fmt(d.eaten)} kcal, no target yet`;
    const diff = d.eaten - d.target;
    const over = overTargetSeverity(d.eaten, d.target) > 0;
    return `${when}: ${fmt(d.eaten)} of ${fmt(d.target)} kcal, ${over ? `${fmt(diff)} over` : diff >= 0 ? "on target" : `${fmt(-diff)} under`}`;
  };

  return (
    <div className="mt-7">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <span className="label">Intake vs target · 7 days</span>
        <span className="flex items-center gap-1.5 text-[0.6875rem] text-mute">
          <span aria-hidden className="h-px w-3 bg-fg-2/60" />
          target
        </span>
      </div>
      <ul className="grid grid-cols-7 gap-2" aria-label="Calories eaten against each day's target, last 7 days">
        {days.map((d, i) => {
          const ratio = d.eaten !== null && d.target ? d.eaten / d.target : null;
          const severity = overTargetSeverity(d.eaten, d.target);
          const over = severity > 0;
          const fill = ratio !== null ? Math.min(ratio * TARGET_AT, 1) : 0;
          const isToday = d.date === today;
          const diff = d.eaten !== null && d.target ? d.eaten - d.target : null;
          return (
            <li key={d.date} className="min-w-0">
              <span className="sr-only">{describe(d)}</span>
              <div aria-hidden className="relative h-14 overflow-hidden rounded-[4px] bg-white/[0.035]">
                {ratio !== null ? (
                  <motion.div
                    className={clsx(
                      "absolute inset-x-0 bottom-0 rounded-[4px]",
                      // Over: the part up to the target stays neutral, the excess above it carries the over-target colour.
                      over ? "bg-fg-2/20" : "bg-accent",
                      isToday && "opacity-60",
                    )}
                    initial={reduce ? false : { height: 0 }}
                    animate={{ height: `${fill * 100}%` }}
                    transition={{ duration: 0.6, delay: reduce ? 0 : i * 0.04, ease: [0.22, 1, 0.36, 1] }}
                    style={{ boxShadow: over ? undefined : "0 0 10px -2px rgb(183 243 106 / 0.45)" }}
                  >
                    {over && (
                      <div
                        className={clsx("absolute inset-x-0 top-0 rounded-t-[4px]", severityClass(severity, "bg"))}
                        data-severity={Math.round(severity * 100) / 100}
                        style={{ height: `${((fill - TARGET_AT) / fill) * 100}%`, backgroundColor: severityColor(severity) }}
                      />
                    )}
                  </motion.div>
                ) : (
                  d.eaten !== null && <div className="absolute inset-x-0 bottom-0 h-1 rounded-[4px] bg-fg-2/30" />
                )}
                {d.target !== null && <div className="absolute inset-x-0 h-px bg-fg-2/60" style={{ bottom: `${TARGET_AT * 100}%` }} />}
              </div>
              <div aria-hidden className="mt-1.5 text-center">
                <div className={clsx("label", isToday ? "text-fg-2" : undefined)}>
                  {/* One letter when the columns get too narrow for three. */}
                  <span className="max-[16rem]:hidden">{weekdayName(d.date, true)}</span>
                  <span className="hidden max-[16rem]:inline">{weekdayName(d.date, true).slice(0, 1)}</span>
                </div>
                <div
                  className={clsx("num mt-0.5 truncate text-2xs", over ? severityClass(severity, "text") : "text-mute")}
                  style={over ? { color: severityColor(severity) } : undefined}
                >
                  {diff === null ? "—" : compactDiff(diff)}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
});

/** The last seven days: calories eaten and each day's own target. */
export function stripDays(data: AppData, series: ReadonlyArray<EnergyDay>, today: string): StripDay[] {
  const from = addDays(today, -6);
  const eaten = new Map<string, number | null>();
  for (const d of data.days) if (d.date >= from && d.date <= today) eaten.set(d.date, d.calories);
  return dateRange(from, today).map((date) => ({
    date,
    eaten: eaten.get(date) ?? null,
    target: targetsFor(date, series, data).recommendation?.calories ?? null,
  }));
}

/** "+340", "−85", "+1.2k": fits a narrow column at 320px. */
function compactDiff(diff: number): string {
  const n = Math.round(Math.abs(diff));
  if (n === 0) return "0";
  const body = n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n);
  return `${diff > 0 ? "+" : "−"}${body}`;
}
