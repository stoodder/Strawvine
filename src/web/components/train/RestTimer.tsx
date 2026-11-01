import clsx from "clsx";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useId, useState } from "react";
import { Check, Timer, X } from "lucide-react";
import { success } from "../../lib/haptics";

const FROM_KEY = "strawvine:rest-from";
const TARGET_KEY = "strawvine:rest-target";
const TARGETS = [60, 90, 120, 180] as const;
/** A rest older than this is forgotten (and the pill dismisses itself). */
const MAX_REST_S = 600;

function read(key: string): number | null {
  try {
    const v = Number(window.localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}
function write(key: string, v: number | null) {
  try {
    if (v === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, String(v));
  } catch {
    /* storage unavailable: the timer just won't survive a tab switch */
  }
}

/** Rest start time, kept in localStorage so it survives switching tabs / reloading the PWA. */
export function useRestTimer() {
  const [from, setFrom] = useState<number | null>(() => {
    const v = read(FROM_KEY);
    return v !== null && Date.now() - v < MAX_REST_S * 1000 ? v : null;
  });
  const start = useCallback(() => {
    const now = Date.now();
    write(FROM_KEY, now);
    setFrom(now);
  }, []);
  const stop = useCallback(() => {
    write(FROM_KEY, null);
    setFrom(null);
  }, []);
  return { from, start, stop };
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/**
 * Floating rest pill: counts down to a target rest (tap to cycle 60/90/120/180 s), then flips
 * to "Ready" with a check and counts the overtime. `raised` lifts it above a toast.
 */
export function RestTimer({ from, onDismiss, raised }: { from: number | null; onDismiss: () => void; raised?: boolean }) {
  const [now, setNow] = useState(Date.now());
  const [target, setTarget] = useState<number>(() => {
    const t = read(TARGET_KEY);
    return t !== null && (TARGETS as readonly number[]).includes(t) ? t : 90;
  });
  const hintId = useId();
  useEffect(() => {
    if (from === null) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [from]);
  const secs = from === null ? 0 : Math.max(0, Math.floor((now - from) / 1000));
  const ready = from !== null && secs >= target;

  useEffect(() => {
    if (secs >= MAX_REST_S) onDismiss();
  }, [secs, onDismiss]);

  // One polite announcement + buzz as the target is reached (not every tick).
  const [announced, setAnnounced] = useState<string>("");
  useEffect(() => {
    if (from === null) return setAnnounced("");
    if (ready && !announced) {
      success();
      setAnnounced(`Rest done: ${clock(target)}.`);
    } else if (!ready && announced) setAnnounced("");
  }, [ready, from, target, announced]);

  const cycle = () => {
    const next = TARGETS[(TARGETS.indexOf(target as (typeof TARGETS)[number]) + 1) % TARGETS.length]!;
    setTarget(next);
    write(TARGET_KEY, next);
  };

  return (
    <>
      <span className="sr-only" role="status" aria-live="polite">
        {announced}
      </span>
      <AnimatePresence>
        {from !== null && (
          <motion.div
            role="group"
            aria-label="Rest timer"
            className="fixed bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] left-1/2 z-30 flex -translate-x-1/2 items-center overflow-hidden rounded-full bg-ink-700/90 text-sm shadow-lg ring-1 ring-white/[0.06] backdrop-blur-xl"
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: raised ? -60 : 0, opacity: 1 }}
            exit={{ y: 20, opacity: 0 }}
            transition={{ type: "spring", stiffness: 420, damping: 34 }}
          >
            <button
              type="button"
              onClick={cycle}
              aria-describedby={hintId}
              className="tap flex min-h-11 items-center gap-2 py-2 pr-1 pl-4 whitespace-nowrap"
            >
              {ready ? <Check size={14} strokeWidth={3} className="text-accent" /> : <Timer size={14} className="text-mute" />}
              <span className={clsx("label", ready && "text-accent")}>{ready ? "Ready" : "Rest"}</span>
              <span className={clsx("num min-w-[4ch]", ready ? "text-accent" : "text-fg")}>
                {ready ? `+${clock(secs - target)}` : clock(target - secs)}
              </span>
              <span className="num text-[11px] text-mute">
                <span className="sr-only">target </span>/{clock(target)}
              </span>
            </button>
            <span id={hintId} className="sr-only">
              Tap to change the target rest.
            </span>
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss rest timer"
              className="tap grid h-11 w-11 place-items-center text-mute"
            >
              <X size={14} />
            </button>
            {/* Progress toward the target. */}
            <motion.span
              aria-hidden
              className="pointer-events-none absolute bottom-0 left-0 h-[2px] w-full origin-left bg-accent/70"
              initial={false}
              animate={{ scaleX: Math.min(1, secs / target) }}
              transition={{ duration: 0.25, ease: "linear" }}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
