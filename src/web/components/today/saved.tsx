import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSavedPulse } from "../../lib/store";

/** How long the tick stays before fading. */
const SHOW_MS = 1200;

export interface SavedFlash {
  /** The place (checklist row key, "journal"…) whose edit the server just acknowledged, briefly. */
  shown: string | null;
  /** Call right before saving an edit made in `where`. */
  mark: (where: string) => void;
}

/**
 * A transient "Saved" for the place the person last edited: when the server acknowledges a day
 * write for `date` (useSavedPulse ticks), the tick shows there for ~1.2s. Acks that arrive
 * without a fresh edit (a replay after reconnecting) show nothing.
 */
export function useSavedFlash(date: string): SavedFlash {
  const pulse = useSavedPulse(date);
  const last = useRef(pulse);
  const pending = useRef<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);

  useEffect(() => {
    pending.current = null;
    setShown(null);
  }, [date]);

  useEffect(() => {
    if (pulse === last.current) return;
    last.current = pulse;
    const where = pending.current;
    if (!where) return;
    pending.current = null;
    setShown(where);
    const id = window.setTimeout(() => setShown((s) => (s === where ? null : s)), SHOW_MS);
    return () => window.clearTimeout(id);
  }, [pulse]);

  const mark = useCallback((where: string) => {
    pending.current = where;
  }, []);
  return { shown, mark };
}

/**
 * The tick itself: a lime check and a mono "saved", fading in and out in place.
 * `live` (default) makes it a polite status for screen readers; inside a button, render it with
 * `live={false}` and announce through a separate status region.
 */
export function SavedTick({ show, className, live = true }: { show: boolean; className?: string; live?: boolean }) {
  const reduce = useReducedMotion();
  return (
    <span role={live ? "status" : undefined} aria-hidden={live ? undefined : true} className={className}>
      <AnimatePresence>
        {show && (
          <motion.span
            key="saved"
            className="label inline-flex items-center gap-1 text-accent"
            initial={{ opacity: 0, y: reduce ? 0 : 2 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.25, ease: [0.22, 1, 0.36, 1] }}
          >
            <Check size={11} strokeWidth={3} aria-hidden />
            saved
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}
