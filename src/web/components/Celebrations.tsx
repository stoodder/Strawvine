import clsx from "clsx";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { addDays } from "../../shared/dates";
import type { Achievement } from "../../shared/gamify";
import { celebrate } from "../lib/haptics";
import { useData, useMarkSeen } from "../lib/store";

const TIER_LABEL: Record<Achievement["tier"], string> = {
  milestone: "Milestone",
  streak: "Streak",
  pr: "Personal record",
  goal: "Goal reached",
};

/** How often to re-check whether the moment is right, and how many calm checks in a row it takes. */
const CHECK_MS = 500;
const CALM_CHECKS = 2;
/** Taps that land in the first instant of the overlay were meant for what was underneath. */
const ARM_MS = 450;

/**
 * True while showing an overlay would interrupt data entry. An expanded checklist editor
 * (`data-celebration-hold`) holds celebrations for as long as it stays open — the moment comes
 * when it collapses or the person leaves the screen, not after some idle time mid-entry.
 */
function isBusy(): boolean {
  if (document.visibilityState !== "visible") return true;
  const el = document.activeElement as HTMLElement | null;
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return true;
  if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return true;
  return !!document.querySelector("[data-celebration-hold]");
}

/**
 * Watches derived achievements and plays a restrained celebration for each new one, once —
 * at a calm moment: never while a field is focused, a sheet is open or an editor is in use.
 */
export function Celebrations() {
  const { data, today, achievements: all } = useData();
  const markSeen = useMarkSeen();
  const [queue, setQueue] = useState<Achievement[]>([]);
  // Keys already queued or dismissed this session. `seenAchievements` catches up a render
  // later, and without this a just-dismissed celebration would immediately queue again.
  const handled = useRef(new Set<string>());

  useEffect(() => {
    const seen = new Set(data.seenAchievements);
    const fresh = all.filter((a) => !seen.has(a.key) && !handled.current.has(a.key));
    if (!fresh.length) return;
    for (const a of fresh) handled.current.add(a.key);
    // Only celebrate recent things; quietly file away anything older.
    const cutoff = addDays(today, -3);
    const old = fresh.filter((a) => a.date < cutoff);
    if (old.length) markSeen(old.map((a) => a.key));
    const recent = fresh.filter((a) => a.date >= cutoff).reverse();
    if (recent.length) setQueue((q) => [...q, ...recent]);
  }, [all, data.seenAchievements, today, markSeen]);

  // An edit can take an achievement back before it is shown; skip those.
  const live = useMemo(() => {
    const keys = new Set(all.map((a) => a.key));
    return queue.filter((a) => keys.has(a.key));
  }, [all, queue]);
  const current = live[0];

  // Wait for a calm moment. Once showing, stay up until the queue is through.
  const [ready, setReady] = useState(false);
  const returnTo = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!current) {
      setReady(false);
      return;
    }
    if (ready) return;
    let calm = 0;
    const id = window.setInterval(() => {
      calm = isBusy() ? 0 : calm + 1;
      if (calm >= CALM_CHECKS) {
        // Remember where focus was (the overlay's button takes it on mount) to hand it back.
        returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setReady(true);
      }
    }, CHECK_MS);
    return () => window.clearInterval(id);
  }, [current, ready]);

  const shown = ready ? current : undefined;
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!shown) return;
    celebrate();
    setArmed(false);
    const id = window.setTimeout(() => setArmed(true), ARM_MS);
    return () => window.clearTimeout(id);
  }, [shown]);

  const dismiss = useCallback(() => {
    if (!shown || !armed) return;
    const key = shown.key;
    markSeen([key]);
    setQueue((q) => q.filter((a) => a.key !== key));
  }, [shown, armed, markSeen]);

  // Modal while open: the app behind is inert, Escape/Enter continue, focus returns afterwards.
  const visible = !!shown;
  const dismissRef = useRef(dismiss);
  useLayoutEffect(() => {
    dismissRef.current = dismiss;
  });
  useEffect(() => {
    if (!visible) return;
    const root = document.getElementById("root");
    root?.setAttribute("inert", "");
    const onKey = (e: KeyboardEvent) => {
      // Enter on the Continue button is the button's own click.
      if (e.key === "Escape" || (e.key === "Enter" && !(e.target instanceof HTMLButtonElement))) {
        e.preventDefault();
        dismissRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      root?.removeAttribute("inert");
      const el = returnTo.current;
      if (el?.isConnected && el !== document.body) el.focus({ preventScroll: true });
    };
  }, [visible]);

  const tierId = useId();
  const titleId = useId();
  const detailId = useId();
  const gold = shown?.tier === "pr" || shown?.tier === "goal";
  const color = gold ? "var(--color-gold)" : "var(--color-accent)";
  const more = live.length - 1;

  return createPortal(
    <AnimatePresence>
      {shown && (
        <motion.div
          key={shown.key}
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${tierId} ${titleId}`}
          aria-describedby={detailId}
          className="fixed inset-0 z-[60] grid place-items-center px-8"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={dismiss}
        >
          <div className="absolute inset-0 bg-ink-950/80 backdrop-blur-md" />
          <motion.div
            className="relative flex flex-col items-center text-center"
            initial={{ scale: 0.92, y: 12 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.96, opacity: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 24 }}
          >
            <div className="relative mb-8 grid h-36 w-36 place-items-center" aria-hidden="true">
              <motion.div
                className="absolute inset-0 rounded-full"
                style={{ background: `radial-gradient(circle, ${color} 0%, transparent 65%)` }}
                initial={{ opacity: 0, scale: 0.5 }}
                animate={{ opacity: [0, 0.35, 0.18], scale: [0.5, 1.15, 1] }}
                transition={{ duration: 1.2, ease: "easeOut" }}
              />
              {Array.from({ length: 14 }).map((_, i) => {
                const a = (i / 14) * Math.PI * 2;
                return (
                  <motion.span
                    key={i}
                    className="absolute h-1 w-1 rounded-full"
                    style={{ background: color }}
                    initial={{ x: 0, y: 0, opacity: 0 }}
                    animate={{ x: Math.cos(a) * 78, y: Math.sin(a) * 78, opacity: [0, 1, 0] }}
                    transition={{ duration: 1.1, delay: 0.15 + (i % 3) * 0.04, ease: [0.22, 1, 0.36, 1] }}
                  />
                );
              })}
              <svg width="96" height="96" viewBox="0 0 96 96" className="relative overflow-visible">
                <motion.circle
                  cx="48"
                  cy="48"
                  r="44"
                  fill="none"
                  stroke={color}
                  strokeWidth="2"
                  strokeLinecap="round"
                  initial={{ pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
                  style={{ filter: `drop-shadow(0 0 8px ${color})` }}
                />
                <motion.path
                  d="M32 49 L43 60 L65 37"
                  fill="none"
                  stroke={color}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  initial={{ pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ duration: 0.45, delay: 0.6, ease: "easeOut" }}
                />
              </svg>
            </div>
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 }}>
              <div id={tierId} className="label mb-3" style={{ color }}>
                {TIER_LABEL[shown.tier]}
              </div>
              <h2 id={titleId} className={clsx("text-4xl font-light tracking-tight", gold ? "glow-gold text-gold" : "glow")}>
                {shown.title}
              </h2>
              <p id={detailId} className="mx-auto mt-3 max-w-xs text-sm leading-relaxed text-fg-2">
                {shown.detail}
              </p>
              <button
                type="button"
                autoFocus
                onClick={(e) => {
                  e.stopPropagation();
                  dismiss();
                }}
                className="label mt-8 min-h-11 rounded-full px-5 text-mute"
              >
                Continue{more > 0 ? ` · ${more} more` : ""}
              </button>
            </motion.div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
