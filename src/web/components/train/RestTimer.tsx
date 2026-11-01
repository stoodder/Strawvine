import clsx from "clsx";
import { motion } from "motion/react";
import { useCallback, useEffect, useId, useState } from "react";
import { Check, Timer, X } from "lucide-react";
import { success } from "../../lib/haptics";
import { DOCK_PRIORITY, DockItem } from "../Dock";

const FROM_KEY = "strawvine:rest-from";
const TARGET_KEY = "strawvine:rest-target";
/** Tap-to-cycle steps for the current rest; a rest starts at the target its set calls for. */
const TARGETS = [60, 90, 120, 180] as const;
const DEFAULT_TARGET_S = 90;
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

/**
 * The current rest: its start time and target, kept in localStorage so they survive switching
 * tabs / reloading the PWA. `start(targetS)` begins a rest at the target the logged set calls
 * for (main lift vs accessory, from Settings); `setTarget` overrides it for this rest only.
 */
export function useRestTimer() {
  const [from, setFrom] = useState<number | null>(() => {
    const v = read(FROM_KEY);
    return v !== null && Date.now() - v < MAX_REST_S * 1000 ? v : null;
  });
  const [target, setTargetState] = useState<number>(() => read(TARGET_KEY) ?? DEFAULT_TARGET_S);
  const start = useCallback((targetS: number) => {
    const now = Date.now();
    write(FROM_KEY, now);
    write(TARGET_KEY, targetS);
    setFrom(now);
    setTargetState(targetS);
  }, []);
  const stop = useCallback(() => {
    write(FROM_KEY, null);
    setFrom(null);
  }, []);
  const setTarget = useCallback((targetS: number) => {
    write(TARGET_KEY, targetS);
    setTargetState(targetS);
  }, []);
  return { from, target, start, stop, setTarget };
}

/** The next tap-to-cycle step after `t` (wrapping), so an off-list target from Settings still cycles. */
function nextTarget(t: number): number {
  return TARGETS.find((x) => x > t) ?? TARGETS[0];
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/**
 * Rest pill in the bottom dock: counts down to the rest's target (tap to cycle 60/90/120/180 s
 * for this rest), then flips to "Ready" with a check and counts the overtime.
 */
export function RestTimer({
  from,
  target,
  onTarget,
  onDismiss,
}: {
  from: number | null;
  target: number;
  onTarget: (s: number) => void;
  onDismiss: () => void;
}) {
  const [now, setNow] = useState(Date.now());
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

  const cycle = () => onTarget(nextTarget(target));

  return (
    <>
      <span className="sr-only" role="status" aria-live="polite">
        {announced}
      </span>
      {from !== null && (
        <DockItem id="rest-timer" priority={DOCK_PRIORITY.rest}>
          <motion.div
            role="group"
            aria-label="Rest timer"
            className="pointer-events-auto relative mx-auto flex w-fit items-center overflow-hidden rounded-full bg-ink-700/90 text-sm shadow-lg ring-1 ring-white/[0.06] backdrop-blur-xl"
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
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
              animate={{ scaleX: target > 0 ? Math.min(1, secs / target) : 1 }}
              transition={{ duration: 0.25, ease: "linear" }}
            />
          </motion.div>
        </DockItem>
      )}
    </>
  );
}
