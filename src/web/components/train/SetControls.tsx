import clsx from "clsx";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { Check } from "lucide-react";
import type { Measure, SetEntry } from "../../../shared/schemas";
import { measureUnit } from "./SetSheets";
import { describeSet } from "./sessionEdit";
import { HOLD_MS, useHold } from "./useHold";

/** iOS: no callout / text selection on a long press. */
const noCallout = { WebkitTouchCallout: "none", touchAction: "manipulation" } as const;

/** Fills while a hold is in progress, so the gesture reads even without haptics (iOS). */
function HoldFill({ holding, className }: { holding: boolean; className: string }) {
  return (
    <motion.span
      aria-hidden
      className={clsx("pointer-events-none absolute", className)}
      initial={false}
      animate={{ scaleX: holding ? 1 : 0, opacity: holding ? 1 : 0 }}
      transition={holding ? { duration: HOLD_MS / 1000, ease: "linear" } : { duration: 0.12 }}
    />
  );
}

/** An accessory set: tap logs / unlogs, hold edits. */
export function SetChip({
  exerciseName,
  index,
  set,
  measure,
  describedBy,
  onTap,
  onHold,
}: {
  exerciseName: string;
  index: number;
  set: SetEntry;
  measure: Measure;
  describedBy?: string;
  onTap: () => void;
  onHold: () => void;
}) {
  const { holding, handlers } = useHold({ onTap, onHold });
  const reps = set.done ? set.reps : set.targetReps;
  const weight = set.done ? set.weight : set.targetWeight;
  const unit = measureUnit(measure);
  return (
    <motion.button
      type="button"
      aria-label={`${exerciseName} set ${index + 1}: ${describeSet(set, measure)}`}
      aria-pressed={set.done}
      aria-describedby={describedBy}
      className={clsx(
        "relative flex h-[52px] min-w-[64px] flex-col items-center justify-center overflow-hidden rounded-2xl px-3 select-none",
        set.done ? "bg-accent/[0.24] text-fg ring-1 ring-accent/50 ring-inset" : "bg-white/[0.035] text-fg-2",
      )}
      style={noCallout}
      animate={{
        scale: holding ? 0.94 : 1,
        boxShadow: set.done ? "0 0 22px -8px rgb(183 243 106 / 0.7)" : "0 0 0 0 rgba(0,0,0,0)",
      }}
      transition={{ scale: holding ? { duration: HOLD_MS / 1000 } : { type: "spring", stiffness: 500, damping: 28 } }}
      {...handlers}
    >
      <HoldFill holding={holding} className="inset-x-0 bottom-0 h-[3px] origin-left bg-accent shadow-[0_0_10px_rgb(183_243_106/0.7)]" />
      {set.done && <Check aria-hidden size={10} strokeWidth={3} className="absolute top-1.5 right-1.5 text-accent" />}
      <span className="num text-[15px] leading-none">
        {reps ?? "—"}
        {unit && <span className={clsx("text-[10px]", set.done ? "text-fg-2" : "text-mute")}>{unit}</span>}
      </span>
      {weight ? <span className={clsx("num mt-1 text-[10px] leading-none", set.done ? "text-fg-2" : "text-mute")}>{weight}</span> : null}
    </motion.button>
  );
}

/** A main-lift set row's tappable body: tap logs / unlogs (AMRAP opens its counter), hold edits. */
export function MainSetButton({
  label,
  pressed,
  describedBy,
  onTap,
  onHold,
  children,
}: {
  label: string;
  pressed: boolean;
  describedBy?: string;
  onTap: () => void;
  onHold: () => void;
  children: ReactNode;
}) {
  const { holding, handlers } = useHold({ onTap, onHold });
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      aria-describedby={describedBy}
      className="relative flex min-h-11 min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1 text-left select-none"
      style={noCallout}
      {...handlers}
    >
      <motion.span
        className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1"
        animate={{ scale: holding ? 0.97 : 1 }}
        style={{ originX: 0 }}
        transition={holding ? { duration: HOLD_MS / 1000 } : { type: "spring", stiffness: 500, damping: 28 }}
      >
        {children}
      </motion.span>
      <HoldFill
        holding={holding}
        className="right-0 -bottom-1.5 left-0 h-[2px] origin-left rounded-full bg-accent shadow-[0_0_10px_rgb(183_243_106/0.7)]"
      />
    </button>
  );
}
