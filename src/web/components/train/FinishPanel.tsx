import clsx from "clsx";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import type { Session } from "../../../shared/schemas";
import { fmt } from "../../lib/format";

const EASE = [0.22, 1, 0.36, 1] as const;

export interface RecapLine {
  text: string;
  gold: boolean;
}

/** AMRAP results and applied max bumps, for the recap (exercises skipped today don't count). */
export function recapLines(session: Session, exName: (id: number) => string): RecapLine[] {
  const out: RecapLine[] = [];
  for (const b of session.blocks)
    for (const e of b.exercises) {
      if (e.skipped) continue;
      for (const s of e.sets) {
        if (!s.amrap || !s.done || s.reps === null) continue;
        const over = s.targetReps !== null ? s.reps - s.targetReps : 0;
        const w = s.weight ?? s.targetWeight;
        out.push({
          text: `${exName(e.exerciseId)} AMRAP · ${s.reps}${w ? ` × ${w}` : ""}${over > 0 ? ` · +${over} over target` : ""}`,
          gold: over > 0,
        });
        if (s.appliedProgressionLb) out.push({ text: `New max · +${s.appliedProgressionLb} lb`, gold: true });
      }
    }
  return out;
}

/** A ring that fills to `value`, then draws a check. Plays once on mount. */
function DoneMark({ value }: { value: number }) {
  const size = 72;
  const stroke = 3;
  const r = (size - stroke) / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="overflow-visible">
      <circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(255,255,255,0.07)" strokeWidth={stroke} fill="none" />
      <motion.circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke="var(--color-accent)"
        strokeWidth={stroke}
        strokeLinecap="round"
        fill="none"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        initial={{ pathLength: 0 }}
        animate={{ pathLength: Math.max(0.02, Math.min(1, value)) }}
        transition={{ duration: 0.9, ease: EASE }}
        style={{ filter: "drop-shadow(0 0 6px var(--color-accent))" }}
      />
      <motion.path
        d="M24 37 l8 8 l16 -18"
        stroke="var(--color-accent)"
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ delay: 0.75, duration: 0.35, ease: EASE }}
      />
    </svg>
  );
}

export function FinishPanel({
  session,
  doneSets,
  totalSets,
  volume,
  exName,
  onFinish,
  onReopen,
}: {
  session: Session;
  doneSets: number;
  totalSets: number;
  volume: number;
  exName: (id: number) => string;
  onFinish: () => void;
  onReopen: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const hintId = useId();
  const unlogged = totalSets - doneSets;
  const confirmRef = useRef<HTMLDivElement>(null);
  // Bring the question clear of the floating rest timer.
  useEffect(() => {
    if (confirming) confirmRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [confirming]);

  if (session.completedAt) {
    const lines = recapLines(session, exName);
    return (
      <motion.div
        className="flex flex-col items-center text-center"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: EASE }}
      >
        <DoneMark value={totalSets ? doneSets / totalSets : 1} />
        <h2 className="label mt-4 text-accent">Session complete</h2>
        <dl className="mt-4 flex gap-8">
          <div>
            <dt className="label">Sets</dt>
            <dd className="num mt-1 text-2xl font-light">
              {doneSets}
              <span className="text-sm text-mute">/{totalSets}</span>
            </dd>
          </div>
          {volume > 0 && (
            <div>
              <dt className="label">Moved</dt>
              <dd className="num mt-1 text-2xl font-light whitespace-nowrap">
                {fmt(volume)}
                <span className="ml-1 text-sm text-mute">lb</span>
              </dd>
            </div>
          )}
        </dl>
        {lines.length > 0 && (
          <ul className="mt-4 space-y-1 text-sm text-balance">
            {lines.map((l, i) => (
              <motion.li
                key={i}
                className={clsx(l.gold ? "glow-gold text-gold" : "text-fg-2")}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 1 + i * 0.12, duration: 0.3 }}
              >
                {l.text}
              </motion.li>
            ))}
          </ul>
        )}
        <button type="button" className="btn-ghost mt-6" onClick={onReopen}>
          Reopen
        </button>
      </motion.div>
    );
  }

  if (doneSets === 0)
    return (
      <div className="flex w-full flex-col items-center gap-2">
        <button type="button" disabled aria-describedby={hintId} className="btn-ghost w-full py-3.5 text-base disabled:opacity-50">
          Finish session
        </button>
        <p id={hintId} className="text-xs text-mute">
          Log a set to finish.
        </p>
      </div>
    );

  return (
    <div className="w-full">
      <AnimatePresence mode="wait" initial={false}>
        {confirming ? (
          <motion.div
            key="confirm"
            ref={confirmRef}
            role="group"
            aria-labelledby={hintId}
            className="rounded-2xl bg-white/[0.04] p-4"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <p id={hintId} className="text-sm text-fg-2">
              Finish with <span className="num text-fg">{unlogged}</span> {unlogged === 1 ? "set" : "sets"} unlogged?
            </p>
            <div className="mt-3 flex flex-wrap gap-3">
              <button type="button" className="btn-ghost flex-1 whitespace-nowrap" onClick={() => setConfirming(false)} autoFocus>
                Keep logging
              </button>
              <button
                type="button"
                className="btn-primary flex-1 whitespace-nowrap"
                onClick={() => {
                  setConfirming(false);
                  onFinish();
                }}
              >
                Finish
              </button>
            </div>
          </motion.div>
        ) : (
          <motion.div key="finish" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
            <button
              type="button"
              className="btn-primary w-full py-3.5 text-base"
              onClick={() => (unlogged > 0 ? setConfirming(true) : onFinish())}
            >
              Finish session
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
