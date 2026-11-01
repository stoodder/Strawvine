import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { addDays } from "../../shared/dates";
import { achievements, type Achievement } from "../../shared/gamify";
import { celebrate } from "../lib/haptics";
import { useData, useMarkSeen } from "../lib/store";

const TIER_LABEL: Record<Achievement["tier"], string> = {
  milestone: "Milestone",
  streak: "Streak",
  pr: "Personal record",
  goal: "Goal reached",
};

/**
 * Watches derived achievements and plays a restrained celebration for each new one, once.
 */
export function Celebrations() {
  const { data, today } = useData();
  const markSeen = useMarkSeen();
  const all = useMemo(() => achievements(data, today), [data, today]);
  const [queue, setQueue] = useState<Achievement[]>([]);

  useEffect(() => {
    const seen = new Set(data.seenAchievements);
    const fresh = all.filter((a) => !seen.has(a.key) && !queue.some((q) => q.key === a.key));
    if (!fresh.length) return;
    // Only celebrate recent things; quietly file away anything older.
    const cutoff = addDays(today, -3);
    const old = fresh.filter((a) => a.date < cutoff);
    if (old.length) markSeen(old.map((a) => a.key));
    const recent = fresh.filter((a) => a.date >= cutoff).reverse();
    if (recent.length) setQueue((q) => [...q, ...recent]);
  }, [all, data.seenAchievements, today, markSeen, queue]);

  const current = queue[0];
  useEffect(() => {
    if (current) celebrate();
  }, [current]);

  const dismiss = () => {
    if (!current) return;
    markSeen([current.key]);
    setQueue((q) => q.slice(1));
  };

  const gold = current?.tier === "pr" || current?.tier === "goal";
  const color = gold ? "var(--color-gold)" : "var(--color-accent)";

  return (
    <AnimatePresence>
      {current && (
        <motion.div
          key={current.key}
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
            <div className="relative mb-8 grid h-36 w-36 place-items-center">
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
              <div className="label mb-3" style={{ color }}>
                {TIER_LABEL[current.tier]}
              </div>
              <div className={gold ? "glow-gold text-4xl font-light tracking-tight" : "glow text-4xl font-light tracking-tight"}>
                {current.title}
              </div>
              <p className="mx-auto mt-3 max-w-xs text-sm leading-relaxed text-fg-2">{current.detail}</p>
              <div className="label mt-10 text-faint">Tap to continue{queue.length > 1 ? ` · ${queue.length - 1} more` : ""}</div>
            </motion.div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
