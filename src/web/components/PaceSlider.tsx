import type { Direction } from "../../shared/nutrition";
import { fmt } from "../lib/format";

export function PaceSlider({
  value,
  onChange,
  limit,
  bodyweight,
  direction,
}: {
  value: number;
  onChange: (v: number) => void;
  limit: number;
  bodyweight: number | null;
  direction: Direction;
}) {
  const v = Math.min(value, limit);
  const lb = bodyweight ? (v / 100) * bodyweight : null;
  const pct = limit > 0 ? (v / limit) * 100 : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <div className="label">Pace</div>
        <div className="num text-sm">
          {direction === "gain" ? "+" : direction === "lose" ? "−" : ""}
          {v.toFixed(2)}%<span className="text-mute">/wk</span>
          {lb !== null && <span className="ml-2 text-mute">≈ {fmt(lb, 1)} lb/wk</span>}
        </div>
      </div>
      <input
        type="range"
        aria-label="Pace, percent of bodyweight per week"
        min={0.1}
        max={limit}
        step={0.05}
        value={v}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-3 h-1 w-full cursor-pointer appearance-none rounded-full accent-[var(--color-accent)]"
        style={{ background: `linear-gradient(90deg, var(--color-accent) ${pct}%, rgba(255,255,255,0.08) ${pct}%)` }}
      />
      <div className="mt-1.5 flex justify-between text-[10px] text-faint">
        <span>Gentle</span>
        <span>Limit {limit}%</span>
      </div>
    </div>
  );
}
