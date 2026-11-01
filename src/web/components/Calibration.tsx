import clsx from "clsx";
import { motion } from "motion/react";
import { CALIBRATION_DAYS } from "../../shared/energy";

const MILESTONES: Array<[number, string]> = [
  [1, "first entry"],
  [2, "first TDEE reading"],
  [7, "weighted averages online"],
  [CALIBRATION_DAYS, "fully calibrated"],
];

/**
 * The ramp-up as a row of ticks with the next unlock spelled out.
 * `missing`: the viewed day has one half of a logged day (weight or calories) but not the other.
 */
export function Calibration({ logged, missing = null }: { logged: number; missing?: "weight" | "calories" | null }) {
  const n = Math.min(logged, CALIBRATION_DAYS);
  const next = MILESTONES.find(([d]) => d > n);
  return (
    <div>
      <div className="flex items-end gap-[3px]">
        {Array.from({ length: CALIBRATION_DAYS }).map((_, i) => {
          const milestone = MILESTONES.some(([d]) => d === i + 1);
          const filled = i < n;
          return (
            <div key={i} className="flex flex-1 flex-col items-center gap-1.5">
              <span className={clsx("h-1 w-1 rounded-full", milestone ? (filled ? "bg-accent" : "bg-white/25") : "bg-transparent")} />
              <motion.div
                className={clsx("h-3 w-full rounded-[2px]", filled ? "bg-accent" : "bg-white/[0.06]")}
                initial={false}
                animate={{ opacity: 1 }}
                transition={{ delay: i * 0.03 }}
                style={{ boxShadow: filled && i === n - 1 ? "0 0 10px rgb(183 243 106 / 0.6)" : undefined }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs">
        <span className="text-fg-2">
          Calibrating <span className="num text-accent">{n}</span>
          <span className="text-mute">/{CALIBRATION_DAYS}</span>
        </span>
        {missing ? (
          <span className="text-mute">
            Add {missing} to complete day <span className="num">{n + 1}</span>
          </span>
        ) : (
          next && (
            <span className="text-mute">
              {next[0] - n} {next[0] - n === 1 ? "day" : "days"} to {next[1]}
            </span>
          )
        )}
      </div>
    </div>
  );
}
