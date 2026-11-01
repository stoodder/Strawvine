import clsx from "clsx";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { Check } from "lucide-react";
import type { Measure, SetEntry } from "../../../shared/schemas";
import { measureUnit } from "./SetSheets";
import { describeSet, unitWord } from "./sessionEdit";
import { HOLD_MS, useHold } from "./useHold";

/** iOS: no callout / text selection on a long press. */
const noCallout = { WebkitTouchCallout: "none", touchAction: "manipulation" } as const;

/**
 * Fills while a hold is in progress, so the gesture reads even without haptics (iOS). A plain CSS
 * width transition rather than a motion scaleX: with reduced motion on, motion finishes its
 * animations instantly, which made the bar jump straight to full on pointer-down. A slow linear
 * fill is a progress cue, not decorative movement, so it runs in both modes.
 */
function HoldFill({ holding, className }: { holding: boolean; className: string }) {
  return (
    <span
      aria-hidden
      className={clsx("pointer-events-none absolute left-0", className)}
      style={{
        width: holding ? "100%" : "0%",
        opacity: holding ? 1 : 0,
        transition: holding ? `width ${HOLD_MS}ms linear` : "width 120ms ease-out, opacity 120ms ease-out",
      }}
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
  dataSet,
  open,
  onTap,
  onHold,
}: {
  exerciseName: string;
  /** `data-set` / `data-open` hooks, so the screen can find the next open set to reveal. */
  dataSet?: string;
  open?: boolean;
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
  // The accessible name is built from the visible text plus sr-only words around it (WCAG 2.5.3):
  // "Row set 1: 10 reps at 50 lb", where "10" and "50" are what the chip shows.
  return (
    <motion.button
      type="button"
      data-set={dataSet}
      data-open={open ? "" : undefined}
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
      <HoldFill holding={holding} className="bottom-0 h-[3px] bg-accent shadow-[0_0_10px_rgb(183_243_106/0.7)]" />
      {set.done && <Check aria-hidden size={10} strokeWidth={3} className="absolute top-1.5 right-1.5 text-accent" />}
      <span className="num text-[0.9375rem] leading-none">
        <span className="sr-only">{`${exerciseName} set ${index + 1}: `}</span>
        {reps ?? (
          <>
            <span aria-hidden>—</span>
            <span className="sr-only">no target</span>
          </>
        )}
        {unit ? (
          <span className={clsx("text-[0.625rem]", set.done ? "text-fg-2" : "text-mute")}>{unit}</span>
        ) : (
          reps !== null && <span className="sr-only">{` ${unitWord(measure, reps)}`}</span>
        )}
      </span>
      {weight ? (
        <span className={clsx("num mt-1 text-[0.625rem] leading-none", set.done ? "text-fg-2" : "text-mute")}>
          <span className="sr-only"> at </span>
          {weight}
          <span className="sr-only"> lb</span>
        </span>
      ) : null}
    </motion.button>
  );
}

/**
 * A main-lift set row's tappable body: tap logs / unlogs (AMRAP opens its counter), hold edits.
 * Its accessible name is `srPrefix` (sr-only, e.g. "Bench press set 1:") followed by the visible
 * children ("270 × 3 AMRAP"), so the name contains what's on screen (WCAG 2.5.3).
 */
export function MainSetButton({
  srPrefix,
  pressed,
  describedBy,
  onTap,
  onHold,
  children,
}: {
  srPrefix: string;
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
        <span className="sr-only">{`${srPrefix} `}</span>
        {children}
      </motion.span>
      <HoldFill holding={holding} className="-bottom-1.5 h-[2px] rounded-full bg-accent shadow-[0_0_10px_rgb(183_243_106/0.7)]" />
    </button>
  );
}

/** A planned accessory set in a read-only preview: the chip's shape, outlined, not interactive. */
export function PlannedChip({ index, set, measure }: { index: number; set: SetEntry; measure: Measure }) {
  const unit = measureUnit(measure);
  return (
    <li className="flex h-[52px] min-w-[64px] flex-col items-center justify-center rounded-2xl border border-dashed border-white/[0.12] px-3 text-fg-2">
      <span className="sr-only">{`Set ${index + 1}: ${describeSet(set, measure)}`}</span>
      <span aria-hidden className="num text-[0.9375rem] leading-none">
        {set.targetReps ?? "—"}
        {unit && <span className="text-[0.625rem] text-mute">{unit}</span>}
      </span>
      {set.targetWeight ? (
        <span aria-hidden className="num mt-1 text-[0.625rem] leading-none text-mute">
          {set.targetWeight}
        </span>
      ) : null}
    </li>
  );
}
