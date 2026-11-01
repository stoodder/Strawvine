import clsx from "clsx";
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
  const atLimit = v >= limit;
  const verb = direction === "gain" ? "gain" : direction === "lose" ? "loss" : "change";
  const valueText = `${v.toFixed(2)}% per week${lb !== null ? `, about ${fmt(lb, 1)} lb` : ""}${atLimit ? ", at your limit" : ""}`;
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
      {/* The visible track is 4px; the input on top of it is a 44px tap target. */}
      <div className="relative mt-1 h-11">
        <div
          aria-hidden
          className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full"
          style={{ background: `linear-gradient(90deg, var(--color-accent) ${pct}%, rgba(255,255,255,0.12) ${pct}%)` }}
        />
        <input
          type="range"
          aria-label={`Pace, percent of bodyweight ${verb} per week`}
          aria-valuetext={valueText}
          min={0.1}
          max={limit}
          step={0.05}
          value={v}
          onChange={(e) => onChange(Number(e.target.value))}
          className="range absolute inset-0 h-11 w-full"
        />
      </div>
      <div className="flex justify-between text-2xs text-mute">
        <span>Gentle</span>
        <span className={clsx(atLimit && "text-fg-2")}>{atLimit ? `At your limit · ${limit}%` : `Limit ${limit}%`}</span>
      </div>
    </div>
  );
}
