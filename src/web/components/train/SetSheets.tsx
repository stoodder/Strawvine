import clsx from "clsx";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useState } from "react";
import { Trash2 } from "lucide-react";
import { platesPerSide } from "../../../shared/program";
import type { Measure, SetEntry } from "../../../shared/schemas";
import { celebrate, success } from "../../lib/haptics";
import { Sheet, Stepper } from "../ui";

/** Ref callback: focus an element as it mounts (after the control that was pressed went away). */
const focusOnMount = (el: HTMLElement | null) => el?.focus({ preventScroll: true });

export function measureUnit(m: Measure): string {
  return m === "seconds" ? "s" : m === "meters" ? "m" : "";
}

export function Plates({ weight }: { weight: number | null }) {
  if (!weight || weight <= 45) return null;
  const { plates, remainder } = platesPerSide(weight);
  return (
    <div
      role="img"
      className="flex items-center gap-1.5"
      aria-label={`Plates per side: ${plates.join(", ")}${remainder > 0 ? `, plus ${remainder} lb` : ""}`}
    >
      <span className="label mr-1 whitespace-nowrap" aria-hidden>
        per side
      </span>
      {plates.map((p, i) => (
        <span
          key={i}
          className="num grid place-items-center rounded-[5px] bg-white/[0.06] text-[0.625rem] text-fg-2"
          style={{ height: 14 + Math.min(p, 45) * 0.45, minWidth: 22, padding: "0 4px" }}
        >
          {p}
        </span>
      ))}
      {remainder > 0 && <span className="text-[0.625rem] text-warn">+{remainder}</span>}
    </div>
  );
}

/** ±2.5 lb fine-tuning under a load stepper. */
function FineLoad({ weight, onChange }: { weight: number; onChange: (v: number) => void }) {
  return (
    <div className="flex gap-2">
      {[-2.5, 2.5].map((d) => (
        <button
          key={d}
          type="button"
          aria-label={`${d > 0 ? "Add" : "Remove"} 2.5 lb`}
          className="chip min-h-11 bg-white/[0.04] px-4 text-mute"
          onClick={() => onChange(Math.max(0, weight + d))}
        >
          {d > 0 ? "+" : "−"}2.5
        </button>
      ))}
    </div>
  );
}

/** Edit a single set's reps/time/distance and load. */
export function SetEditSheet({
  open,
  onClose,
  title,
  set,
  measure,
  showPlates,
  onSave,
  onDelete,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  set: SetEntry | null;
  measure: Measure;
  /** Barbell work only: plates make no sense for dumbbells or cables. */
  showPlates?: boolean;
  onSave: (s: SetEntry) => void;
  onDelete?: () => void;
}) {
  const [reps, setReps] = useState(0);
  const [weight, setWeight] = useState(0);
  const setId = set?.id;
  useEffect(() => {
    if (set) {
      setReps(set.reps ?? set.targetReps ?? (measure === "reps" ? 10 : measure === "seconds" ? 30 : 40));
      setWeight(set.weight ?? set.targetWeight ?? 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, setId, measure]);
  if (!set) return null;
  const repStep = measure === "reps" ? 1 : measure === "seconds" ? 5 : 5;
  const repLabel = measure === "reps" ? "Reps" : measure === "seconds" ? "Seconds" : "Meters";
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <div className="space-y-8 pb-2">
        <div className="flex flex-col items-center gap-2">
          <div className="label">{repLabel}</div>
          <Stepper value={reps} onChange={setReps} step={repStep} max={10000} editable label={repLabel.toLowerCase()} />
        </div>
        <div className="flex flex-col items-center gap-2">
          <div className="label">Load · lb</div>
          <Stepper value={weight} onChange={setWeight} step={5} max={2000} editable label="load" />
          <FineLoad weight={weight} onChange={setWeight} />
          {showPlates && (
            <div className="mt-2 min-h-6">
              <Plates weight={weight} />
            </div>
          )}
        </div>
        <div className="flex items-center gap-3">
          {onDelete && (
            <button
              type="button"
              aria-label="Delete set"
              className="btn h-11 w-11 shrink-0 bg-warn/10 px-0 text-warn hover:bg-warn/15"
              onClick={onDelete}
            >
              <Trash2 size={16} />
            </button>
          )}
          <button
            type="button"
            className="btn-ghost flex-1 whitespace-nowrap"
            onClick={() =>
              onSave({
                ...set,
                targetReps: reps,
                targetWeight: weight || null,
                reps: set.done ? reps : set.reps,
                weight: set.done ? weight || null : set.weight,
              })
            }
          >
            Save target
          </button>
          <button
            type="button"
            className="btn-primary flex-1 whitespace-nowrap"
            onClick={() => {
              success();
              onSave({ ...set, reps, weight: weight || null, done: true });
            }}
          >
            {set.done ? "Update" : "Log set"}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

/** A rep PR on this AMRAP (more reps than any earlier AMRAP of the lift at this load or heavier). */
export interface AmrapRepPr {
  reps: number;
  weightLb: number;
  previousReps: number;
}

/**
 * The AMRAP moment: count reps big, then — if the target was beaten — offer the max bump. A rep
 * PR is shown on the same result screen (one celebration per AMRAP, not two).
 */
export function AmrapSheet({
  open,
  onClose,
  set,
  exerciseName,
  currentMaxLb,
  lbPerExtraRep,
  progressionEnabled,
  onLog,
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  set: SetEntry | null;
  exerciseName: string;
  currentMaxLb: number | null;
  lbPerExtraRep: number;
  progressionEnabled: boolean;
  /** Logs the set; returns the rep PR it sets, if any (shown here, so it isn't celebrated again). */
  onLog: (reps: number, weight: number | null) => AmrapRepPr | null;
  onApply: (gainLb: number, reps: number) => Promise<void>;
}) {
  const [reps, setReps] = useState(0);
  const [weight, setWeight] = useState(0);
  const [phase, setPhase] = useState<"count" | "result">("count");
  const resultId = useId();
  const [busy, setBusy] = useState(false);
  const [repPr, setRepPr] = useState<AmrapRepPr | null>(null);
  // Whether the result offers the max bump (frozen: logging updates `set`).
  const [offerGain, setOfferGain] = useState(false);
  // The max before the bump, frozen for the result: Apply updates currentMaxLb while pending.
  const [maxBefore, setMaxBefore] = useState<number | null>(null);
  // Reset only when the sheet opens for a set — logging reps updates `set` and must not
  // bounce the sheet back to the counter before the result phase shows.
  const setId = set?.id;
  useEffect(() => {
    if (open && set) {
      setReps(set.reps ?? set.targetReps ?? 0);
      setWeight(set.weight ?? set.targetWeight ?? 0);
      setPhase("count");
      setBusy(false);
      setRepPr(null);
      setOfferGain(false);
      setMaxBefore(currentMaxLb);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, setId]);
  if (!set) return null;
  const target = set.targetReps ?? 0;
  const extra = Math.max(0, reps - target);
  const gain = progressionEnabled ? extra * lbPerExtraRep : 0;
  const alreadyApplied = set.appliedProgressionLb !== null;

  return (
    <Sheet open={open} onClose={onClose} title={<span className="label text-accent">AMRAP · last set</span>}>
      <AnimatePresence mode="wait">
        {phase === "count" ? (
          <motion.div
            key="count"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex flex-col items-center pb-2 text-center"
          >
            <div className="text-sm text-mute">
              {exerciseName} · target <span className="num">{target}+</span>
            </div>
            <div className="mt-8">
              <Stepper value={reps} onChange={setReps} size="xl" max={100} editable label="reps" />
            </div>
            <div className="mt-4 h-6 text-sm">
              {extra > 0 ? (
                <span className="text-gold">
                  +{extra} over target{gain > 0 && !alreadyApplied ? ` · +${gain} lb to your max` : ""}
                </span>
              ) : (
                <span className="text-mute">reps completed</span>
              )}
            </div>
            <div className="mt-6 flex flex-col items-center gap-2">
              <div className="label">Load · lb</div>
              <Stepper value={weight} onChange={setWeight} step={5} max={2000} editable label="load" />
              <FineLoad weight={weight} onChange={setWeight} />
            </div>
            <button
              type="button"
              className="btn-primary mt-6 w-full py-3.5 text-base"
              onClick={() => {
                const pr = onLog(reps, weight || null);
                const bump = gain > 0 && !alreadyApplied;
                if (bump || pr) {
                  celebrate();
                  setMaxBefore(currentMaxLb);
                  setRepPr(pr);
                  setOfferGain(bump);
                  setPhase("result");
                } else {
                  success();
                  onClose();
                }
              }}
            >
              Log {reps} reps
            </button>
          </motion.div>
        ) : (
          <motion.div
            key="result"
            role="status"
            aria-labelledby={resultId}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex flex-col items-center pb-2 text-center"
          >
            {/* Focus lands here: the Log button the person pressed is gone. */}
            <h3 id={resultId} ref={focusOnMount} tabIndex={-1} className="label text-gold">
              {offerGain ? "Target beaten" : "Rep PR"}
            </h3>
            <motion.div
              className="glow-gold num mt-6 text-7xl font-light text-gold"
              initial={{ y: 10, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ type: "spring", stiffness: 300, damping: 20, delay: 0.1 }}
            >
              {offerGain ? (
                `+${gain} lb`
              ) : (
                <>
                  {repPr?.reps} <span className="text-2xl">reps</span>
                </>
              )}
            </motion.div>
            {offerGain && maxBefore !== null && (
              <div className="mt-4 text-sm text-fg-2">
                {exerciseName} max <span className="num">{maxBefore}</span> → <span className="num text-gold">{maxBefore + gain}</span>
              </div>
            )}
            {repPr && (
              <div className={clsx("text-sm", offerGain ? "glow-gold mt-2 text-gold" : "mt-4 text-fg-2")}>
                {offerGain ? "Rep PR — " : `${exerciseName} · `}
                <span className="num">
                  {repPr.reps} @ {repPr.weightLb}
                </span>
                , best was <span className="num">{repPr.previousReps}</span>
              </div>
            )}
            {offerGain ? (
              <div className="mt-10 flex w-full gap-3">
                <button type="button" className="btn-ghost flex-1" onClick={onClose}>
                  Not now
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className="btn flex-1 bg-gold font-medium text-ink-950 shadow-[0_0_32px_-8px_rgb(244_184_96/0.7)]"
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await onApply(gain, reps);
                      success();
                      onClose();
                    } catch {
                      setBusy(false);
                    }
                  }}
                >
                  Apply
                </button>
              </div>
            ) : (
              <button type="button" className="btn-ghost mt-10 w-full" onClick={onClose}>
                Done
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </Sheet>
  );
}
