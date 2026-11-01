/**
 * Lightweight SVG charts: sparklines that sit inline with text, and a scrubbable line chart.
 */
import { useMemo, useRef, useState, type ReactNode } from "react";
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
}: {
  series: Series[];
  height?: number;
  refLine?: { y: number; label: string };
  formatY?: (v: number) => string;
  emptyText?: ReactNode;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const width = 360;
  const pad = { t: 12, r: 8, b: 20, l: 8 };

  const dates = useMemo(() => {
    const set = new Set<string>();
    for (const s of series) for (const p of s.points) set.add(p.x);
    return [...set].sort();
  }, [series]);

  const all = series.flatMap((s) => s.points.map((p) => p.y)).filter((v): v is number => v !== null);
  if (refLine) all.push(refLine.y);
  if (all.length < 2 || dates.length < 2) return <div className="grid h-28 place-items-center text-sm text-mute">{emptyText}</div>;

  let min = Math.min(...all);
  let max = Math.max(...all);
  const padY = (max - min || Math.abs(max) * 0.05 || 1) * 0.15;
  min -= padY;
  max += padY;

  const xOf = (i: number) => pad.l + (i / (dates.length - 1)) * (width - pad.l - pad.r);
  const yOf = (v: number) => pad.t + (1 - (v - min) / (max - min)) * (height - pad.t - pad.b);
  const idx = new Map(dates.map((d, i) => [d, i]));

  const onMove = (clientX: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = ((clientX - r.left) / r.width) * width;
    const i = Math.round(((x - pad.l) / (width - pad.l - pad.r)) * (dates.length - 1));
    setHover(Math.max(0, Math.min(dates.length - 1, i)));
  };

  const hoverDate = hover !== null ? dates[hover]! : null;

  return (
    <div className="relative">
      <div className="mb-2 flex min-h-[34px] flex-wrap items-end gap-x-5 gap-y-1">
        {series.map((s) => {
          const p = hoverDate ? s.points.find((q) => q.x === hoverDate) : [...s.points].reverse().find((q) => q.y !== null);
          return (
            <div key={s.key} className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />
              <span className="text-xs text-mute">{s.label}</span>
              <span className="num text-sm">{p?.y != null ? (s.format ?? formatY)(p.y) : "—"}</span>
            </div>
          );
        })}
        <span className="label ml-auto">{hoverDate ? formatShortDate(hoverDate) : "Latest"}</span>
      </div>
      <svg
        ref={ref}
        viewBox={`0 0 ${width} ${height}`}
        className="w-full touch-pan-y select-none"
        onPointerMove={(e) => onMove(e.clientX)}
        onPointerDown={(e) => onMove(e.clientX)}
        onPointerLeave={() => setHover(null)}
      >
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
        {refLine && (
          <g>
            <line
              x1={pad.l}
              x2={width - pad.r}
              y1={yOf(refLine.y)}
              y2={yOf(refLine.y)}
              stroke="var(--color-gold)"
              strokeDasharray="3 5"
              opacity={0.6}
            />
            <text
              x={width - pad.r}
              y={yOf(refLine.y) - 5}
              textAnchor="end"
              fontSize="9"
              fill="var(--color-gold)"
              opacity={0.8}
              fontFamily="var(--font-mono)"
            >
              {refLine.label}
            </text>
          </g>
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
        {hover !== null && <line x1={xOf(hover)} x2={xOf(hover)} y1={pad.t} y2={height - pad.b} stroke="rgba(255,255,255,0.18)" />}
        <text x={pad.l} y={height - 4} fontSize="9" fill="var(--color-faint)" fontFamily="var(--font-mono)">
          {formatShortDate(dates[0]!)}
        </text>
        <text x={width - pad.r} y={height - 4} fontSize="9" fill="var(--color-faint)" textAnchor="end" fontFamily="var(--font-mono)">
          {formatShortDate(dates[dates.length - 1]!)}
        </text>
      </svg>
    </div>
  );
}
