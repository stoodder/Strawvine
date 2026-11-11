import clsx from "clsx";
import { motion } from "motion/react";
import { useCallback, useEffect, useId, useState } from "react";
import { Check, Timer, X } from "lucide-react";
import { platesPerSide } from "../../../shared/program";
import { success } from "../../lib/haptics";
import { DOCK_PRIORITY, DockItem } from "../Dock";

const FROM_KEY = "strawvine:rest-from";
const TARGET_KEY = "strawvine:rest-target";
const BASE_KEY = "strawvine:rest-base";
const BY_KEY = "strawvine:rest-by";
/** Tap-to-cycle steps for the current rest (plus the Program → Rules value it started at). */
const TARGETS = [60, 90, 120, 180] as const;
const DEFAULT_TARGET_S = 90;
/**
 * A rest is forgotten (and the pill dismisses itself) this long after it started: 10 min, or
 * 5 min of overtime past a longer target, so a long target always gets to finish.
 */
export const restLimitS = (targetS: number) => Math.max(600, targetS + 300);

function read(key: string): number | null {
  try {
    const v = Number(window.localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}
function write(key: string, v: number | string | null) {
  try {
    if (v === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, String(v));
  } catch {
    /* storage unavailable: the timer just won't survive a tab switch */
  }
}
function readText(key: string): string | null {
  try {
    return window.localStorage.getItem(key) || null;
  } catch {
    return null;
  }
}

/**
 * The current rest: its start time and target, kept in localStorage so they survive switching
 * tabs / reloading the PWA. `start(targetS, by)` begins a rest at the target the logged set calls
 * for (main lift vs accessory, from Program → Rules); `setTarget` overrides it for this rest only.
 * `by` is the id of the set whose logging started it (none for a rest several sets started at
 * once): unlogging that set ends the rest it began — `stopIfStartedBy`.
 */
export function useRestTimer() {
  const [target, setTargetState] = useState<number>(() => read(TARGET_KEY) ?? DEFAULT_TARGET_S);
  const [base, setBase] = useState<number>(() => read(BASE_KEY) ?? read(TARGET_KEY) ?? DEFAULT_TARGET_S);
  const [from, setFrom] = useState<number | null>(() => {
    const v = read(FROM_KEY);
    return v !== null && Date.now() - v < restLimitS(read(TARGET_KEY) ?? DEFAULT_TARGET_S) * 1000 ? v : null;
  });
  const start = useCallback((targetS: number, by: string | null = null) => {
    const now = Date.now();
    write(FROM_KEY, now);
    write(TARGET_KEY, targetS);
    write(BASE_KEY, targetS);
    write(BY_KEY, by);
    setFrom(now);
    setTargetState(targetS);
    setBase(targetS);
  }, []);
  const stop = useCallback(() => {
    write(FROM_KEY, null);
    write(BY_KEY, null);
    setFrom(null);
  }, []);
  /** End the rest if `setId` is the set that started it (kept in storage: it survives a reload). */
  const stopIfStartedBy = useCallback(
    (setId: string) => {
      if (readText(BY_KEY) === setId) stop();
    },
    [stop],
  );
  const setTarget = useCallback((targetS: number) => {
    write(TARGET_KEY, targetS);
    setTargetState(targetS);
  }, []);
  return { from, target, base, start, stop, stopIfStartedBy, setTarget };
}

/**
 * The next tap-to-cycle step after `t`, wrapping: the defaults plus `base` (the Program → Rules value
 * this rest started at), so an off-list target can always be cycled back to.
 */
export function nextTarget(t: number, base: number): number {
  const steps = [...new Set<number>([...TARGETS, base])].sort((a, b) => a - b);
  return steps.find((x) => x > t) ?? steps[0]!;
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

type PlateGroup = { plate: number; count: number };

/**
 * Plates per side as compact chips: runs of three or more read "45×3"; a load needing more than
 * four chips also folds pairs ("45×2"), so the pill stays short.
 */
export function plateChips(plates: number[]): PlateGroup[] {
  const runs: PlateGroup[] = [];
  for (const p of plates) {
    const last = runs[runs.length - 1];
    if (last && last.plate === p) last.count++;
    else runs.push({ plate: p, count: 1 });
  }
  const spread = (min: number) =>
    runs.flatMap((g) => (g.count >= min ? [g] : Array.from({ length: g.count }, () => ({ plate: g.plate, count: 1 }))));
  const loose = spread(3);
  return loose.length > 4 ? spread(2) : loose;
}

/**
 * The next set's load for the pill (null: nothing to show): a barbell set's plates per side, or
 * (`plates` false — dumbbells, cables, an accessory) just the load.
 */
function nextLoad(weightLb: number | null, plates: boolean) {
  if (weightLb === null || weightLb <= 0) return null;
  if (!plates) return { weightLb, plates: [], remainder: 0, chips: [], crowded: false };
  if (weightLb <= 45) return null;
  const perSide = platesPerSide(weightLb);
  if (!perSide.plates.length) return null;
  const chips = plateChips(perSide.plates);
  return { weightLb, ...perSide, chips, crowded: chips.length + (perSide.remainder > 0 ? 1 : 0) > 4 };
}

/** "next 225 · 45 45": what to load for the coming set (a load without plates reads "next 50 lb"). */
function NextPlates({ load }: { load: NonNullable<ReturnType<typeof nextLoad>> }) {
  const { weightLb, plates, remainder, chips } = load;
  const spoken = plates.length
    ? `Next set ${weightLb} lb: ${plates.join(", ")} per side${remainder > 0 ? `, plus ${remainder} lb` : ""}.`
    : `Next set ${weightLb} lb.`;
  return (
    <span className="flex items-center gap-1.5 pr-1 pl-1.5 whitespace-nowrap">
      <span className="sr-only">{spoken}</span>
      {/* On narrow phones (or for a load with many plates) the pill drops the word and keeps the
          numbers; on the very narrowest it keeps just the clock (the spoken text still has it all). */}
      <span aria-hidden className={clsx("label text-mute max-[359px]:hidden", load.crowded && "hidden")}>
        next
      </span>
      <span aria-hidden className={clsx("num text-[0.8125rem] text-fg-2 max-[259px]:hidden", load.crowded && "max-[399px]:hidden")}>
        {weightLb}
        {!chips.length && <span className="ml-0.5 text-[0.625rem] text-mute">lb</span>}
      </span>
      {chips.length > 0 && (
        <span aria-hidden className="flex items-center gap-0.5 max-[259px]:hidden">
          {chips.map((g, i) => (
            <span key={i} className="num rounded-[4px] bg-white/[0.08] px-[3px] text-[0.625rem] leading-4 text-fg">
              {g.plate}
              {g.count > 1 && <span className="text-fg-2">×{g.count}</span>}
            </span>
          ))}
          {remainder > 0 && <span className="num text-[0.625rem] text-warn">+{remainder}</span>}
        </span>
      )}
    </span>
  );
}

/**
 * Rest pill in the bottom dock: counts down to the rest's target (tap to cycle 60/90/120/180 s
 * and the Program → Rules value for this rest), then flips to "Ready" with a check and counts the overtime.
 */
export function RestTimer({
  from,
  target,
  base,
  onTarget,
  onDismiss,
  nextWeightLb = null,
  nextPlates = true,
}: {
  from: number | null;
  target: number;
  /** The target this rest started at (Program → Rules), kept in the tap cycle. */
  base: number;
  onTarget: (s: number) => void;
  onDismiss: () => void;
  /** Load of the next set; null hides it. */
  nextWeightLb?: number | null;
  /** The next set is barbell work: show its plates per side (else just the load). */
  nextPlates?: boolean;
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
    if (from !== null && secs >= restLimitS(target)) onDismiss();
  }, [from, secs, target, onDismiss]);

  // One polite announcement + buzz as the target is reached (not every tick).
  const [announced, setAnnounced] = useState<string>("");
  useEffect(() => {
    if (from === null) return setAnnounced("");
    if (ready && !announced) {
      success();
      setAnnounced(`Rest done: ${clock(target)}.`);
    } else if (!ready && announced) setAnnounced("");
  }, [ready, from, target, announced]);

  const cycle = () => onTarget(nextTarget(target, base));
  const next = nextLoad(nextWeightLb, nextPlates);
  const showNext = !!next;

  return (
    <>
      {/* The announcement lives in the dock (outside #root, which a sheet makes inert) and stays
          rendered over sheets, so "Rest done" is heard even while a set is being edited. */}
      <DockItem id="rest-timer-status" priority={DOCK_PRIORITY.rest} overSheets>
        <span className="sr-only" role="status" aria-live="polite">
          {announced}
        </span>
      </DockItem>
      {from !== null && (
        <DockItem id="rest-timer" priority={DOCK_PRIORITY.rest}>
          <motion.div
            role="group"
            aria-label="Rest timer"
            className="hc-edge pointer-events-auto relative mx-auto flex w-fit max-w-full items-center overflow-hidden rounded-full bg-ink-800/90 text-sm shadow-lg ring-1 ring-white/[0.06] backdrop-blur-xl"
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
              {ready ? <Check size={14} strokeWidth={3} className="text-accent" /> : <Timer size={14} className="text-fg-2" />}
              {/* With the next set's plates shown, the word goes (icon and colour still say rest / ready). */}
              <span className={clsx("label", ready ? "text-accent" : "text-fg-2", showNext && "sr-only")}>{ready ? "Ready" : "Rest"}</span>
              <span className={clsx("num min-w-[4ch]", ready ? "text-accent" : "text-fg")}>
                {ready ? `+${clock(secs - target)}` : clock(target - secs)}
              </span>
              {/* The target only says something new once the countdown has moved off it; its
                  space is kept from the start so the pill doesn't widen when it appears. */}
              <span
                aria-hidden={secs > 0 ? undefined : true}
                className={clsx(
                  "num text-[0.6875rem] text-fg-2 transition-opacity duration-300",
                  secs > 0 ? "opacity-100" : "opacity-0",
                  // A load with many plates needs the room on the narrowest phones.
                  next?.crowded && "max-[399px]:hidden",
                )}
              >
                <span className="sr-only">target {clock(target)}</span>
                {/* Below ~260px only the clock fits: the target is still in the spoken name. */}
                <span aria-hidden className="max-[259px]:hidden">
                  /{clock(target)}
                </span>
              </span>
            </button>
            <span id={hintId} className="sr-only">
              Tap to change the target rest.
            </span>
            {next && <NextPlates load={next} />}
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
