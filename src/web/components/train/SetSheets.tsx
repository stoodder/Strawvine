import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { platesPerSide } from "../../../shared/program";
import type { Measure, SetEntry } from "../../../shared/schemas";
import { celebrate, success } from "../../lib/haptics";
import { Sheet, Stepper } from "../ui";

export function measureUnit(m: Measure): string {
  return m === "seconds" ? "s" : m === "meters" ? "m" : "";
}

export function Plates({ weight }: { weight: number | null }) {
  if (!weight || weight <= 45) return null;
  const { plates, remainder } = platesPerSide(weight);
  return (
    <div className="flex items-center gap-1.5" aria-label={`Plates per side: ${plates.join(", ")}`}>
      <span className="label mr-1">per side</span>
      {plates.map((p, i) => (
        <span
          key={i}
          className="num grid place-items-center rounded-[5px] bg-white/[0.06] text-[10px] text-fg-2"
          style={{ height: 14 + Math.min(p, 45) * 0.45, minWidth: 22, padding: "0 4px" }}
        >
          {p}
        </span>
      ))}
      {remainder > 0 && <span className="text-[10px] text-warn">+{remainder}</span>}
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
  onSave,
  onDelete,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  set: SetEntry | null;
  measure: Measure;
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
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <div className="space-y-8 pb-2">
        <div className="flex flex-col items-center gap-2">
          <div className="label">{measure === "reps" ? "Reps" : measure === "seconds" ? "Seconds" : "Meters"}</div>
          <Stepper value={reps} onChange={setReps} step={repStep} max={10000} />
        </div>
        <div className="flex flex-col items-center gap-2">
          <div className="label">Load · lb</div>
          <Stepper value={weight} onChange={setWeight} step={5} max={2000} />
          <div className="flex gap-2">
            {[-2.5, 2.5].map((d) => (
              <button key={d} type="button" className="chip bg-white/[0.04] text-mute" onClick={() => setWeight(Math.max(0, weight + d))}>
                {d > 0 ? "+" : "−"}2.5
              </button>
            ))}
          </div>
          <div className="mt-2 min-h-6">
            <Plates weight={weight} />
          </div>
        </div>
        <div className="flex items-center gap-3">
          {onDelete && (
            <button type="button" aria-label="Delete set" className="btn-ghost px-4" onClick={onDelete}>
              <Trash2 size={16} />
            </button>
          )}
          <button
            type="button"
            className="btn-ghost flex-1"
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
            className="btn-primary flex-1"
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

/**
 * The AMRAP moment: count reps big, then — if the target was beaten — offer the max bump.
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
  onLog: (reps: number) => void;
  onApply: (gainLb: number, reps: number) => Promise<void>;
}) {
  const [reps, setReps] = useState(0);
  const [phase, setPhase] = useState<"count" | "result">("count");
  const [busy, setBusy] = useState(false);
  // Reset only when the sheet opens for a set — logging reps updates `set` and must not
  // bounce the sheet back to the counter before the result phase shows.
  const setId = set?.id;
  useEffect(() => {
    if (open && set) {
      setReps(set.reps ?? set.targetReps ?? 0);
      setPhase("count");
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, setId]);
  if (!set) return null;
  const target = set.targetReps ?? 0;
  const extra = Math.max(0, reps - target);
  const gain = progressionEnabled ? extra * lbPerExtraRep : 0;
  const alreadyApplied = set.appliedProgressionLb !== null;

  return (
    <Sheet open={open} onClose={onClose}>
      <AnimatePresence mode="wait">
        {phase === "count" ? (
          <motion.div
            key="count"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex flex-col items-center pb-2 text-center"
          >
            <div className="label text-accent">AMRAP · last set</div>
            <div className="mt-2 text-sm text-mute">
              {exerciseName} · {set.targetWeight} lb · target {target}+
            </div>
            <div className="mt-10">
              <Stepper value={reps} onChange={setReps} size="xl" max={100} />
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
            <button
              type="button"
              className="btn-primary mt-8 w-full py-3.5 text-base"
              onClick={() => {
                onLog(reps);
                if (gain > 0 && !alreadyApplied) {
                  celebrate();
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
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex flex-col items-center pb-2 text-center"
          >
            <div className="label text-gold">Target beaten</div>
            <motion.div
              className="glow-gold num mt-6 text-7xl font-light text-gold"
              initial={{ y: 10, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ type: "spring", stiffness: 300, damping: 20, delay: 0.1 }}
            >
              +{gain} lb
            </motion.div>
            {currentMaxLb !== null && (
              <div className="mt-4 text-sm text-fg-2">
                {exerciseName} max <span className="num">{currentMaxLb}</span> →{" "}
                <span className="num text-gold">{currentMaxLb + gain}</span>
              </div>
            )}
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
          </motion.div>
        )}
      </AnimatePresence>
    </Sheet>
  );
}
