import clsx from "clsx";

/** Chart ranges in days; 0 is everything since the first log. */
export const RANGES = [
  ["30", 30],
  ["90", 90],
  ["All", 0],
] as const;

/**
 * 30 / 90 / All: one range for every chart on Progress. It sits at the top of each view that has
 * a chart (Body, Fuel, Activity) and they share its state, so a range picked on one holds on the
 * others.
 */
export function RangeControl({ range, onChange }: { range: number; onChange: (range: number) => void }) {
  return (
    <div className="flex" role="group" aria-label="Chart range">
      {RANGES.map(([l, v]) => (
        <button
          key={l}
          type="button"
          aria-pressed={range === v}
          aria-label={v ? `${l} days` : "All time"}
          onClick={() => onChange(v)}
          className={clsx(
            // Small pill, 44px-wide and (invisibly) 44px-tall target.
            "tap relative inline-flex min-w-11 justify-center rounded-full px-2.5 py-0.5 text-xs font-medium after:absolute after:inset-x-0 after:-inset-y-3 after:content-['']",
            range === v ? "bg-white/[0.08] text-fg" : "text-mute",
          )}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
