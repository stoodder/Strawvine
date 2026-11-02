/**
 * Lightweight SVG charts: sparklines that sit inline with text, and a scrubbable line chart.
 */
import clsx from "clsx";
import { ChevronDown } from "lucide-react";
import { useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { formatShortDate, startOfWeek } from "../../shared/dates";

export interface Point {
  x: string; // ISO date
  y: number | null;
}

export function Sparkline({
  points,
  width = 88,
  height = 26,
  color = "var(--color-accent)",
  strong = false,
}: {
  points: Array<number | null>;
  width?: number;
  height?: number;
  color?: string;
  /** High-contrast display: a heavier line. */
  strong?: boolean;
}) {
  const vals = points.filter((p): p is number => p !== null);
  if (vals.length < 2) return <svg width={width} height={height} aria-hidden />;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const step = width / (points.length - 1);
  let d = "";
  points.forEach((p, i) => {
    if (p === null) return;
    const x = i * step;
    const y = height - 3 - ((p - min) / span) * (height - 6);
    d += `${d ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = vals[vals.length - 1]!;
  const lastIdx = points.lastIndexOf(last);
  return (
    <svg width={width} height={height} aria-hidden className="overflow-visible">
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={strong ? 2.25 : 1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={strong ? 1 : 0.9}
      />
      <circle cx={lastIdx * step} cy={height - 3 - ((last - min) / span) * (height - 6)} r={2.5} fill={color} />
    </svg>
  );
}

export interface Series {
  key: string;
  label: string;
  points: Point[];
  color: string;
  kind: "line" | "dots";
  format?: (v: number) => string;
  /**
   * Dots only: when the chart spans more than this many days, draw one dot per week (the mean
   * of that week's values, at the middle of its points) instead of one per day. Reading the
   * chart (scrubbing, the table) still shows each day's own value.
   */
  weeklyOver?: number;
}

/**
 * Weekly means of `points` (Monday-start weeks), each placed at the mean index of the points
 * it summarises. `index` maps a date to its x index.
 */
export function weeklyMeans(points: ReadonlyArray<Point>, index: (date: string) => number): Array<{ i: number; y: number }> {
  const out: Array<{ i: number; y: number }> = [];
  let week: string | null = null;
  let n = 0;
  let sumI = 0;
  let sumY = 0;
  const flush = () => {
    if (n) out.push({ i: sumI / n, y: sumY / n });
    n = sumI = sumY = 0;
  };
  for (const p of points) {
    if (p.y === null) continue;
    const w = startOfWeek(p.x);
    if (w !== week) {
      flush();
      week = w;
    }
    n++;
    sumI += index(p.x);
    sumY += p.y;
  }
  flush();
  return out;
}

export function LineChart({
  series,
  height = 180,
  refLine,
  formatY = (v) => v.toFixed(0),
  emptyText = "Not enough data yet.",
  title = "Chart",
  strong = false,
}: {
  series: Series[];
  height?: number;
  refLine?: { y: number; label: string };
  formatY?: (v: number) => string;
  emptyText?: ReactNode;
  /** Names the chart for screen readers ("Bodyweight"); the summary is generated. */
  title?: string;
  /** High-contrast display: heavier lines and dots, brighter grid. */
  strong?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const tableId = useId();
  const width = 360;
  const pad = { t: 12, r: 8, b: 8, l: 8 };
  const plotW = width - pad.l - pad.r;

  // Everything that depends only on the data is computed once per series change, not per
  // hover frame: a long range (years of days) would otherwise rescan every point on each move.
  const geo = useMemo(() => {
    const set = new Set<string>();
    for (const s of series) for (const p of s.points) set.add(p.x);
    const dates = [...set].sort();
    // Per series: date → value, for O(1) reads on hover and in the table.
    const byDate = series.map((s) => {
      const m = new Map<string, number>();
      for (const p of s.points) if (p.y !== null) m.set(p.x, p.y);
      return m;
    });
    let dataMin = Infinity;
    let dataMax = -Infinity;
    let count = 0;
    for (const m of byDate)
      for (const v of m.values()) {
        count++;
        if (v < dataMin) dataMin = v;
        if (v > dataMax) dataMax = v;
      }
    if (count < 2 || dates.length < 2) return null;

    // The y-domain hugs the data. A reference line close to the data joins the domain; one far
    // outside it is pinned to the edge as a marker instead of squashing the lines flat.
    let min = dataMin;
    let max = dataMax;
    const span = max - min || Math.abs(max) * 0.05 || 1;
    let pinned: "above" | "below" | null = null;
    if (refLine) {
      const near = span * 0.75;
      if (refLine.y >= min - near && refLine.y <= max + near) {
        min = Math.min(min, refLine.y);
        max = Math.max(max, refLine.y);
      } else pinned = refLine.y < min ? "below" : "above";
    }
    const padY = (max - min || span) * 0.15;
    min -= padY;
    max += padY;

    const xOf = (i: number) => pad.l + (i / (dates.length - 1)) * plotW;
    const yOf = (v: number) => pad.t + (1 - (v - min) / (max - min)) * (height - pad.t - pad.b);
    const idx = new Map(dates.map((d, i) => [d, i]));
    // One path per series. Dots are zero-length segments drawn with round caps, so a decade of
    // daily weigh-ins is one element instead of thousands of <circle>s.
    const weekly = series.map((s) => s.kind === "dots" && s.weeklyOver !== undefined && dates.length > s.weeklyOver);
    const paths = series.map((s, si) => {
      let d = "";
      if (weekly[si]) {
        for (const p of weeklyMeans(s.points, (x) => idx.get(x)!)) d += `M${xOf(p.i).toFixed(1)},${yOf(p.y).toFixed(1)}h0`;
        return d;
      }
      for (const p of s.points) {
        if (p.y === null) continue;
        const x = xOf(idx.get(p.x)!).toFixed(1);
        const y = yOf(p.y).toFixed(1);
        d += s.kind === "dots" ? `M${x},${y}h0` : `${d ? "L" : "M"}${x},${y}`;
      }
      return d;
    });
    return { dates, byDate, dataMin, dataMax, pinned, xOf, yOf, paths, weekly };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pad / plotW are constants
  }, [series, height, refLine?.y]);

  // The table: the most recent 14 days with any value, newest first — built only while open.
  const rows = useMemo(() => {
    if (!table || !geo) return [];
    const out: string[] = [];
    for (let i = geo.dates.length - 1; i >= 0 && out.length < 14; i--) {
      const d = geo.dates[i]!;
      if (geo.byDate.some((m) => m.has(d))) out.push(d);
    }
    return out;
  }, [table, geo]);

  if (!geo) return <div className="grid h-28 place-items-center text-sm text-mute">{emptyText}</div>;
  const { dates, byDate, dataMin, dataMax, pinned, xOf, yOf, paths, weekly } = geo;

  const onMove = (clientX: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = ((clientX - r.left) / r.width) * width;
    const i = Math.round(((x - pad.l) / plotW) * (dates.length - 1));
    const next = Math.max(0, Math.min(dates.length - 1, i));
    if (next !== hover) setHover(next);
  };
  const onKey = (e: ReactKeyboardEvent) => {
    const last = dates.length - 1;
    const step = e.shiftKey ? 7 : 1;
    let next: number | null | undefined;
    if (e.key === "ArrowLeft") next = Math.max(0, (hover ?? last + 1) - step);
    else if (e.key === "ArrowRight") next = Math.min(last, (hover ?? last - 1) + step);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    else if (e.key === "Escape" && hover !== null) next = null;
    if (next !== undefined) {
      e.preventDefault();
      setHover(next);
    }
  };

  const hoverDate = hover !== null ? dates[hover]! : null;
  const fmtOf = (s: Series) => s.format ?? formatY;
  const lastOf = (s: Series) => {
    for (let i = s.points.length - 1; i >= 0; i--) if (s.points[i]!.y !== null) return s.points[i];
    return undefined;
  };
  const firstOf = (s: Series) => s.points.find((q) => q.y !== null);
  const summary = [
    `${title}, ${formatShortDate(dates[0]!)} to ${formatShortDate(dates[dates.length - 1]!)}.`,
    ...series.map((s) => {
      const a = firstOf(s);
      const b = lastOf(s);
      return a && b ? `${s.label} ${fmtOf(s)(a.y!)} to ${fmtOf(s)(b.y!)}.` : `${s.label}: no data.`;
    }),
    ...series.filter((_, si) => weekly[si]).map((s) => `${s.label} drawn as weekly averages.`),
    refLine ? `${refLine.label}.` : "",
    "Use the left and right arrow keys to read each day.",
  ]
    .filter(Boolean)
    .join(" ");
  const pct = (v: number) => `${(v / height) * 100}%`;
  // Axis values read in the main line's own format (e.g. one decimal for bodyweight).
  const fmtAxis = (series.find((s) => s.kind === "line") ?? series[0])?.format ?? formatY;
  const gridAt = dataMax > dataMin ? [dataMax, (dataMax + dataMin) / 2, dataMin] : [dataMax];

  return (
    <div className="relative">
      <div className="mb-2 flex min-h-[34px] flex-wrap items-end gap-x-5 gap-y-1" aria-live="polite" aria-atomic="true">
        {series.map((s, si) => {
          const y = hoverDate ? byDate[si]!.get(hoverDate) : lastOf(s)?.y;
          return (
            <div key={s.key} className="flex items-center gap-2">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />
              <span className="text-xs text-mute">{s.label}</span>
              <span className="num text-sm">{y != null ? fmtOf(s)(y) : "—"}</span>
            </div>
          );
        })}
        <span className="label ml-auto">{hoverDate ? formatShortDate(hoverDate) : "Latest"}</span>
      </div>
      <div
        ref={ref}
        role="img"
        aria-label={summary}
        tabIndex={0}
        className="relative touch-pan-y rounded-md select-none"
        onPointerMove={(e) => onMove(e.clientX)}
        onPointerDown={(e) => onMove(e.clientX)}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
      >
        <svg viewBox={`0 0 ${width} ${height}`} className="block w-full" aria-hidden>
          {/* Hairlines at the data's high, middle and low. */}
          {gridAt.map((v) => (
            <line
              key={v}
              x1={pad.l}
              x2={width - pad.r}
              y1={yOf(v)}
              y2={yOf(v)}
              stroke={strong ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.045)"}
            />
          ))}
          {refLine && !pinned && (
            <line
              x1={pad.l}
              x2={width - pad.r}
              y1={yOf(refLine.y)}
              y2={yOf(refLine.y)}
              stroke="var(--color-gold)"
              strokeDasharray="3 5"
              opacity={0.6}
            />
          )}
          {series.map((s, si) => {
            const d = paths[si]!;
            if (s.kind === "dots")
              return (
                <path
                  key={s.key}
                  d={d}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={strong ? 4.8 : 3.6}
                  strokeLinecap="round"
                  opacity={strong ? 0.9 : 0.55}
                />
              );
            return (
              <g key={s.key}>
                <path d={d} fill="none" stroke={s.color} strokeWidth={6} opacity={0.08} strokeLinejoin="round" />
                <path d={d} fill="none" stroke={s.color} strokeWidth={strong ? 2.75 : 1.75} strokeLinejoin="round" strokeLinecap="round" />
              </g>
            );
          })}
          {hover !== null && (
            <g>
              <line
                x1={xOf(hover)}
                x2={xOf(hover)}
                y1={pad.t}
                y2={height - pad.b}
                stroke={strong ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.18)"}
              />
              {series.map((s, si) => {
                const y = byDate[si]!.get(hoverDate!);
                return y != null ? <circle key={s.key} cx={xOf(hover)} cy={yOf(y)} r={3} fill={s.color} /> : null;
              })}
            </g>
          )}
        </svg>
        {/* High and low of the plotted data, at their own levels on the left. */}
        <span
          aria-hidden
          className="pointer-events-none absolute left-2 -translate-y-full pb-0.5 font-mono text-2xs text-mute"
          style={{ top: pct(yOf(dataMax)) }}
        >
          {fmtAxis(dataMax)}
        </span>
        {dataMax > dataMin && (
          <span
            aria-hidden
            className="pointer-events-none absolute left-2 pt-0.5 font-mono text-2xs text-mute"
            style={{ top: pct(yOf(dataMin)) }}
          >
            {fmtAxis(dataMin)}
          </span>
        )}
        {refLine && !pinned && (
          <span
            aria-hidden
            className="pointer-events-none absolute right-0 -translate-y-full pb-1 font-mono text-2xs text-gold/90"
            style={{ top: pct(yOf(refLine.y)) }}
          >
            {refLine.label}
          </span>
        )}
        {refLine && pinned && (
          <span
            aria-hidden
            className={clsx(
              "pointer-events-none absolute right-0 font-mono text-2xs text-gold/90",
              pinned === "below" ? "bottom-0" : "top-0",
            )}
          >
            {refLine.label} {pinned === "below" ? "↓" : "↑"}
          </span>
        )}
      </div>
      <div className="mt-1.5 flex items-center justify-between px-2 font-mono text-2xs text-mute">
        <span aria-hidden>{formatShortDate(dates[0]!)}</span>
        <button
          type="button"
          aria-expanded={table}
          aria-controls={tableId}
          onClick={() => setTable((t) => !t)}
          // 44px tall without growing the row.
          className="label -my-3 inline-flex min-h-11 items-center gap-1 px-2 text-mute"
        >
          Table
          <ChevronDown size={11} aria-hidden className={clsx("transition-transform", table && "rotate-180")} />
        </button>
        <span aria-hidden>{formatShortDate(dates[dates.length - 1]!)}</span>
      </div>
      <div id={tableId} hidden={!table}>
        {table && (
          <div
            className="mt-3 max-h-60 overflow-y-auto overscroll-contain rounded-xl bg-white/[0.02] px-3"
            tabIndex={0}
            role="region"
            aria-label={`${title} values`}
          >
            <table className="w-full text-xs">
              <caption className="sr-only">
                {title}, the {rows.length} most recent days with data, newest first
              </caption>
              <thead className="sticky top-0 bg-ink-950/95">
                <tr>
                  <th scope="col" className="label py-2 text-left font-normal">
                    Date
                  </th>
                  {series.map((s) => (
                    <th key={s.key} scope="col" className="label py-2 text-right font-normal">
                      {s.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d} className="border-t border-white/[0.04]">
                    <th scope="row" className="py-1.5 text-left font-normal text-fg-2">
                      {formatShortDate(d)}
                    </th>
                    {series.map((s, si) => {
                      const y = byDate[si]!.get(d);
                      return (
                        <td key={s.key} className="num py-1.5 text-right text-fg">
                          {y != null ? fmtOf(s)(y) : <span className="text-mute">—</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
