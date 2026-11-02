import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Ring } from "../ui";

const SWEEP_S = 0.8;

/**
 * Per tab session: the dates this ring has shown open, and the dates whose sweep has played.
 * A day that was open when last seen here and is closed now was closed elsewhere (the lift
 * finished on Train, a sync from another device): the sweep plays once on return.
 */
const MEMORY_KEY = "strawvine:day-ring";
const MEMORY_MAX = 31;
type Memory = { open: string[]; played: string[] };

function readMemory(): Memory {
  try {
    const m = JSON.parse(window.sessionStorage.getItem(MEMORY_KEY) ?? "null") as Partial<Memory> | null;
    return {
      open: Array.isArray(m?.open) ? m.open.filter((x) => typeof x === "string") : [],
      played: Array.isArray(m?.played) ? m.played.filter((x) => typeof x === "string") : [],
    };
  } catch {
    return { open: [], played: [] };
  }
}

function remember(list: "open" | "played", date: string) {
  const m = readMemory();
  if (m[list].includes(date)) return;
  m[list] = [...m[list], date].slice(-MEMORY_MAX);
  try {
    window.sessionStorage.setItem(MEMORY_KEY, JSON.stringify(m));
  } catch {
    /* storage unavailable: the sweep just won't replay on return */
  }
}

/** Whether the sweep should play for a closed day that this ring mounts on (or switches to). */
function closedSinceLastSeen(date: string): boolean {
  const m = readMemory();
  return m.open.includes(date) && !m.played.includes(date);
}

/**
 * The hero ring on Today. When the day closes (not-closed → closed for the same date, while
 * watching), a restrained sweep plays once: a bright arc runs the full circle and a soft halo
 * breathes out. Reduced motion keeps only a brief glow. Distinct from the full-screen
 * celebrations — this is the "click" of the day closing, not an achievement.
 *
 * It also plays, once per date, when coming back to a day that closed while it was out of view
 * (see `closedSinceLastSeen`).
 */
export function DayRing({
  date,
  closed,
  value,
  size = 60,
  stroke = 3.5,
  children,
}: {
  date: string;
  closed: boolean;
  value: number;
  size?: number;
  stroke?: number;
  children?: ReactNode;
}) {
  const reduce = useReducedMotion();
  const prev = useRef({ date, closed });
  const [sweep, setSweep] = useState(0);

  const mountedDate = useRef<string | null>(null);
  useEffect(() => {
    const p = prev.current;
    prev.current = { date, closed };
    const arrived = mountedDate.current !== date; // first render for this date (mount or day switch)
    mountedDate.current = date;
    if (!closed) {
      remember("open", date);
      return;
    }
    if ((!arrived && p.date === date && !p.closed) || (arrived && closedSinceLastSeen(date))) {
      remember("played", date);
      setSweep((n) => n + 1);
    }
  }, [date, closed]);

  useEffect(() => {
    if (!sweep) return;
    const id = window.setTimeout(() => setSweep(0), (SWEEP_S + 0.25) * 1000);
    return () => window.clearTimeout(id);
  }, [sweep]);

  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const arc = c * 0.22;

  return (
    <div className="relative" data-day-ring={sweep || undefined}>
      <Ring value={value} size={size} stroke={stroke}>
        {children}
      </Ring>
      <AnimatePresence>
        {sweep > 0 && (
          <motion.div
            key={sweep}
            aria-hidden
            className="pointer-events-none absolute inset-0"
            exit={{ opacity: 0, transition: { duration: 0.15 } }}
          >
            {/* Halo: a soft lime ring that breathes out and fades. */}
            <motion.span
              className="absolute inset-0 rounded-full"
              initial={{ opacity: 0, scale: reduce ? 1 : 0.92 }}
              animate={{ opacity: [0, 0.9, 0], scale: reduce ? 1 : [0.92, 1.12, 1.22] }}
              transition={{ duration: SWEEP_S + 0.2, ease: [0.22, 1, 0.36, 1], times: [0, 0.35, 1] }}
              style={{ boxShadow: "0 0 0 1px rgb(183 243 106 / 0.35), 0 0 22px 2px rgb(183 243 106 / 0.35)" }}
            />
            {!reduce && (
              <svg width={size} height={size} className="absolute inset-0 -rotate-90 overflow-visible">
                <motion.circle
                  cx={size / 2}
                  cy={size / 2}
                  r={r}
                  fill="none"
                  stroke="var(--color-fg)"
                  strokeWidth={stroke}
                  strokeLinecap="round"
                  strokeDasharray={`${arc} ${c - arc}`}
                  initial={{ strokeDashoffset: arc, opacity: 0 }}
                  animate={{ strokeDashoffset: arc - c, opacity: [0, 1, 1, 0] }}
                  transition={{ duration: SWEEP_S, ease: [0.45, 0, 0.2, 1], times: [0, 0.15, 0.7, 1] }}
                  style={{ filter: "drop-shadow(0 0 6px var(--color-accent))" }}
                />
              </svg>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
