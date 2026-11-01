import clsx from "clsx";
import { motion, useReducedMotion } from "motion/react";
import { useMemo } from "react";
import { addDays, dateRange, formatShortDate, weekdayName } from "../../../shared/dates";
import type { EnergyDay } from "../../../shared/energy";
import type { AppData } from "../../../shared/gamify";
import { targetsFor } from "../../../shared/insights";
import { fmt } from "../../lib/format";

/** A day over target by more than this reads as over (matches Today's Fuel bar). */
const OVER = 0.05;
/** Where the target sits in each column; above it is room for overs (up to 1/TARGET_AT × target). */
const TARGET_AT = 0.7;

interface StripDay {
  date: string;
  eaten: number | null;
  target: number | null;
}

/**
 * The last seven days of calories eaten against each day's own target (from `targetsFor`, i.e.
 * the engine as of the day before). Under or on target in lime, over in warn; a day without
 * calories or a target is a dim stub. Today is still in progress and says so.
 */
export function IntakeStrip({ data, series, today }: { data: AppData; series: ReadonlyArray<EnergyDay>; today: string }) {
  const reduce = useReducedMotion();
  const days = useMemo<StripDay[]>(
    () =>
      dateRange(addDays(today, -6), today).map((date) => ({
        date,
        eaten: data.days.find((d) => d.date === date)?.calories ?? null,
        target: targetsFor(date, series, data).recommendation?.calories ?? null,
      })),
    [data, series, today],
  );
  if (days.every((d) => d.eaten === null)) return null;

  const describe = (d: StripDay) => {
    const when = d.date === today ? "Today so far" : `${weekdayName(d.date)} ${formatShortDate(d.date)}`;
    if (d.eaten === null) return `${when}: no calories logged`;
    if (d.target === null) return `${when}: ${fmt(d.eaten)} kcal, no target yet`;
    const diff = d.eaten - d.target;
    return `${when}: ${fmt(d.eaten)} of ${fmt(d.target)} kcal, ${diff > d.target * OVER ? `${fmt(diff)} over` : diff >= 0 ? "on target" : `${fmt(-diff)} under`}`;
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
          const over = ratio !== null && ratio > 1 + OVER;
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
                      // Over: the part up to the target stays quiet, the excess above it carries the warn tone.
                      over ? "bg-warn/25" : "bg-accent",
                      isToday && "opacity-60",
                    )}
                    initial={reduce ? false : { height: 0 }}
                    animate={{ height: `${fill * 100}%` }}
                    transition={{ duration: 0.6, delay: reduce ? 0 : i * 0.04, ease: [0.22, 1, 0.36, 1] }}
                    style={{ boxShadow: over ? undefined : "0 0 10px -2px rgb(183 243 106 / 0.45)" }}
                  >
                    {over && (
                      <div
                        className="absolute inset-x-0 top-0 rounded-t-[4px] bg-warn"
                        style={{ height: `${((fill - TARGET_AT) / fill) * 100}%` }}
                      />
                    )}
                  </motion.div>
                ) : (
                  d.eaten !== null && <div className="absolute inset-x-0 bottom-0 h-1 rounded-[4px] bg-fg-2/30" />
                )}
                {d.target !== null && <div className="absolute inset-x-0 h-px bg-fg-2/60" style={{ bottom: `${TARGET_AT * 100}%` }} />}
              </div>
              <div aria-hidden className="mt-1.5 text-center">
                <div className={clsx("label", isToday ? "text-fg-2" : undefined)}>{weekdayName(d.date, true)}</div>
                <div className={clsx("num mt-0.5 truncate text-[0.625rem]", over ? "text-warn" : "text-mute")}>
                  {diff === null ? "—" : compactDiff(diff)}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** "+340", "−85", "+1.2k": fits a narrow column at 320px. */
function compactDiff(diff: number): string {
  const n = Math.round(Math.abs(diff));
  if (n === 0) return "0";
  const body = n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n);
  return `${diff > 0 ? "+" : "−"}${body}`;
}
