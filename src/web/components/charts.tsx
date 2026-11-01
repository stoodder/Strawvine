/**
 * Lightweight SVG charts: sparklines that sit inline with text, and a scrubbable line chart.
 */
import clsx from "clsx";
import { useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { formatShortDate } from "../../shared/dates";

export interface Point {
  x: string; // ISO date
  y: number | null;
}

export function Sparkline({
  points,
  width = 88,
  height = 26,
  color = "var(--color-accent)",
}: {
  points: Array<number | null>;
  width?: number;
  height?: number;
  color?: string;
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
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" opacity={0.9} />
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
}

export function LineChart({
  series,
  height = 180,
  refLine,
  formatY = (v) => v.toFixed(0),
  emptyText = "Not enough data yet.",
  title = "Chart",
}: {
  series: Series[];
  height?: number;
  refLine?: { y: number; label: string };
  formatY?: (v: number) => string;
  emptyText?: ReactNode;
  /** Names the chart for screen readers ("Bodyweight"); the summary is generated. */
  title?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const width = 360;
  const pad = { t: 12, r: 8, b: 8, l: 8 };

  const dates = useMemo(() => {
    const set = new Set<string>();
    for (const s of series) for (const p of s.points) set.add(p.x);
    return [...set].sort();
  }, [series]);

  const all = series.flatMap((s) => s.points.map((p) => p.y)).filter((v): v is number => v !== null);
  if (all.length < 2 || dates.length < 2) return <div className="grid h-28 place-items-center text-sm text-mute">{emptyText}</div>;

  // The y-domain hugs the data. A reference line close to the data joins the domain; one far
  // outside it is pinned to the edge as a marker instead of squashing the lines flat.
  let min = Math.min(...all);
  let max = Math.max(...all);
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

  const plotW = width - pad.l - pad.r;
  const xOf = (i: number) => pad.l + (i / (dates.length - 1)) * plotW;
  const yOf = (v: number) => pad.t + (1 - (v - min) / (max - min)) * (height - pad.t - pad.b);
  const idx = new Map(dates.map((d, i) => [d, i]));

  const onMove = (clientX: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = ((clientX - r.left) / r.width) * width;
    const i = Math.round(((x - pad.l) / plotW) * (dates.length - 1));
    setHover(Math.max(0, Math.min(dates.length - 1, i)));
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
  const lastOf = (s: Series) => [...s.points].reverse().find((q) => q.y !== null);
  const firstOf = (s: Series) => s.points.find((q) => q.y !== null);
  const summary = [
    `${title}, ${formatShortDate(dates[0]!)} to ${formatShortDate(dates[dates.length - 1]!)}.`,
    ...series.map((s) => {
      const a = firstOf(s);
      const b = lastOf(s);
      return a && b ? `${s.label} ${fmtOf(s)(a.y!)} to ${fmtOf(s)(b.y!)}.` : `${s.label}: no data.`;
    }),
    refLine ? `${refLine.label}.` : "",
    "Use the left and right arrow keys to read each day.",
  ]
    .filter(Boolean)
    .join(" ");
  const pct = (v: number) => `${(v / height) * 100}%`;

  return (
    <div className="relative">
      <div className="mb-2 flex min-h-[34px] flex-wrap items-end gap-x-5 gap-y-1" aria-live="polite" aria-atomic="true">
        {series.map((s) => {
          const p = hoverDate ? s.points.find((q) => q.x === hoverDate) : lastOf(s);
          return (
            <div key={s.key} className="flex items-center gap-2">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />
              <span className="text-xs text-mute">{s.label}</span>
              <span className="num text-sm">{p?.y != null ? fmtOf(s)(p.y) : "—"}</span>
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
          {[0.25, 0.5, 0.75].map((f) => (
            <line
              key={f}
              x1={pad.l}
              x2={width - pad.r}
              y1={pad.t + f * (height - pad.t - pad.b)}
              y2={pad.t + f * (height - pad.t - pad.b)}
              stroke="rgba(255,255,255,0.04)"
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
          {series.map((s) => {
            const pts = s.points.filter((p) => p.y !== null).map((p) => [xOf(idx.get(p.x)!), yOf(p.y!)] as const);
            if (s.kind === "dots")
              return (
                <g key={s.key}>
                  {pts.map(([x, y], i) => (
                    <circle key={i} cx={x} cy={y} r={1.8} fill={s.color} opacity={0.55} />
                  ))}
                </g>
              );
            const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
            return (
              <g key={s.key}>
                <path d={d} fill="none" stroke={s.color} strokeWidth={6} opacity={0.08} strokeLinejoin="round" />
                <path d={d} fill="none" stroke={s.color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
              </g>
            );
          })}
          {hover !== null && (
            <g>
              <line x1={xOf(hover)} x2={xOf(hover)} y1={pad.t} y2={height - pad.b} stroke="rgba(255,255,255,0.18)" />
              {series.map((s) => {
                const p = s.points.find((q) => q.x === hoverDate);
                return p?.y != null ? <circle key={s.key} cx={xOf(hover)} cy={yOf(p.y)} r={3} fill={s.color} /> : null;
              })}
            </g>
          )}
        </svg>
        {refLine && !pinned && (
          <span
            aria-hidden
            className="pointer-events-none absolute right-0 -translate-y-full pb-1 font-mono text-[0.625rem] text-gold/90"
            style={{ top: pct(yOf(refLine.y)) }}
          >
            {refLine.label}
          </span>
        )}
        {refLine && pinned && (
          <span
            aria-hidden
            className={clsx(
              "pointer-events-none absolute right-0 font-mono text-[0.625rem] text-gold/90",
              pinned === "below" ? "bottom-0" : "top-0",
            )}
          >
            {refLine.label} {pinned === "below" ? "↓" : "↑"}
          </span>
        )}
      </div>
      <div aria-hidden className="mt-1.5 flex justify-between px-2 font-mono text-[0.625rem] text-mute">
        <span>{formatShortDate(dates[0]!)}</span>
        <span>{formatShortDate(dates[dates.length - 1]!)}</span>
      </div>
    </div>
  );
}
