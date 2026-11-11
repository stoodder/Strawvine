import clsx from "clsx";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useId, useRef, useState } from "react";
import type { Session } from "../../../shared/schemas";
import { fmt } from "../../lib/format";
import { DOCK_PRIORITY, DockItem, useDockHeight } from "../Dock";
import { afterLayout, useOnScreenAboveNav, useRevealAboveDock } from "./reveal";

const EASE = [0.22, 1, 0.36, 1] as const;

/** Finish sits nearest the nav in the dock: under toasts, which are under the rest pill. */
export const DOCK_FINISH_PRIORITY = DOCK_PRIORITY.toast + 10;
/** On a very short screen (under 30rem tall) Finish leaves the dock to the rest pill and toasts. */
export const DOCK_FINISH_SHORT_SCREEN = "[@media(max-height:30rem)]:hidden";

/**
 * Whether Finish is offered from the dock: once every counted set is logged (a skipped main lift
 * or exercise counts for nothing, so at least one set must be logged — an empty session finishes
 * from the page), not while the unlogged-sets question is up, and only while the page's own
 * button is known to be off screen (`inlineOnScreen` false; null — not measured yet — waits).
 */
export function dockFinishShown({
  dock,
  doneSets,
  totalSets,
  confirming,
  inlineOnScreen,
}: {
  dock: boolean;
  doneSets: number;
  totalSets: number;
  confirming: boolean;
  inlineOnScreen: boolean | null;
}): boolean {
  return dock && doneSets > 0 && doneSets >= totalSets && !confirming && inlineOnScreen === false;
}

export interface RecapLine {
  text: string;
  gold: boolean;
}

/**
 * AMRAP results and applied max bumps, for the recap (exercises skipped today don't count; a
 * skipped main lift gets a quiet line of its own).
 */
export function recapLines(session: Session, exName: (id: number) => string): RecapLine[] {
  const out: RecapLine[] = [];
  for (const b of session.blocks) {
    if (b.skipped) {
      const main = b.exercises[0];
      if (b.kind === "primary" && main) out.push({ text: `${exName(main.exerciseId)} skipped today`, gold: false });
      continue;
    }
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
  allowEmpty = false,
  dock = false,
}: {
  session: Session;
  doneSets: number;
  totalSets: number;
  volume: number;
  exName: (id: number) => string;
  onFinish: () => void;
  onReopen: () => void;
  /** Finishing needs no logged set (the main lift was skipped today: the day can still close). */
  allowEmpty?: boolean;
  /**
   * Also offer Finish from the bottom dock ("Finish · 7/7 sets") once every set is logged — the
   * moment it's the next thing to do — and only while the button here is off screen, so the two
   * never sit on top of each other. Until then the dock is left to the workout (the rest pill,
   * an Undo): Finish is at the end of the page. Same press as the button here.
   */
  dock?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const hintId = useId();
  const unlogged = totalSets - doneSets;
  const dockHeight = useDockHeight();
  const revealAboveDock = useRevealAboveDock();
  /** The page's own Finish button, and whether any of it shows above the nav (null: not known yet). */
  const [inlineFinish, setInlineFinish] = useState<HTMLButtonElement | null>(null);
  const inlineOnScreen = useOnScreenAboveNav(inlineFinish);
  const inDock = dockFinishShown({ dock, doneSets, totalSets, confirming, inlineOnScreen });
  /**
   * Where focus goes once the next view mounts: the control that was pressed (Finish, Keep
   * logging, Reopen) is replaced, so without this focus would drop to <body>. Only set by a
   * press here — opening an already finished session doesn't steal focus or scroll.
   */
  const focusNext = useRef<"recap" | "finish" | null>(null);
  /**
   * The question card, as it mounts (after the Finish button's exit): bring it clear of the dock
   * (rest timer, toasts).
   */
  const confirmCard = useCallback(
    (el: HTMLDivElement | null) => {
      if (el) afterLayout(() => revealAboveDock(el, { center: true }));
    },
    [revealAboveDock],
  );

  const finish = () => {
    focusNext.current = "recap";
    onFinish();
  };
  /** Finish pressed (here or in the dock): ask first while sets are unlogged. */
  const press = () => (unlogged > 0 ? setConfirming(true) : finish());
  /** The recap's heading: take focus and centre the recap above the dock after a finish. */
  const recapHeading = (el: HTMLHeadingElement | null) => {
    if (!el || focusNext.current !== "recap") return;
    focusNext.current = null;
    el.focus({ preventScroll: true });
    afterLayout(() => revealAboveDock(el.closest("[data-recap]"), { center: true }));
  };
  const finishButton = useCallback(
    (el: HTMLButtonElement | null) => {
      setInlineFinish(el);
      if (!el || focusNext.current !== "finish") return;
      focusNext.current = null;
      el.focus({ preventScroll: true });
      afterLayout(() => revealAboveDock(el));
    },
    [revealAboveDock],
  );

  if (session.completedAt) {
    const lines = recapLines(session, exName);
    return (
      <motion.div
        data-recap=""
        className="flex flex-col items-center text-center"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: EASE }}
      >
        <DoneMark value={totalSets ? doneSets / totalSets : 1} />
        <h2 ref={recapHeading} tabIndex={-1} className="label mt-4 text-accent">
          Session complete
        </h2>
        <dl className="mt-4 flex flex-wrap justify-center gap-x-8 gap-y-3">
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
          <ul className="mt-4 space-y-1 text-sm text-balance wrap-anywhere">
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
        <button
          type="button"
          className="btn-ghost mt-6"
          onClick={() => {
            focusNext.current = "finish";
            onReopen();
          }}
        >
          Reopen
        </button>
      </motion.div>
    );
  }

  if (doneSets === 0 && !allowEmpty)
    return (
      <div className="flex w-full flex-col items-center gap-2">
        <button type="button" disabled aria-describedby={hintId} className="btn-ghost w-full py-3.5 text-base">
          Finish session
        </button>
        <p
          id={hintId}
          // A disabled Finish can't take focus: drop a pending hand-off rather than firing it later.
          ref={(el) => {
            if (el && focusNext.current === "finish") focusNext.current = null;
          }}
          className="text-xs text-mute"
        >
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
            ref={confirmCard}
            role="group"
            aria-labelledby={hintId}
            className="rounded-2xl bg-white/[0.04] p-4"
            style={{ scrollMarginBottom: dockHeight + 16 }}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <p id={hintId} className="text-sm text-fg-2">
              Finish with <span className="num text-fg">{unlogged}</span> {unlogged === 1 ? "set" : "sets"} unlogged?
            </p>
            <div className="mt-3 flex flex-wrap gap-3">
              <button
                type="button"
                className="btn-ghost flex-1 whitespace-nowrap"
                onClick={() => {
                  focusNext.current = "finish";
                  setConfirming(false);
                }}
                autoFocus
              >
                Keep logging
              </button>
              <button
                type="button"
                className="btn-primary flex-1 whitespace-nowrap"
                onClick={() => {
                  setConfirming(false);
                  finish();
                }}
              >
                Finish
              </button>
            </div>
          </motion.div>
        ) : (
          <motion.div key="finish" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
            <button
              ref={finishButton}
              type="button"
              className="btn-primary w-full py-3.5 text-base"
              onClick={press}
            >
              Finish session
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      {/* Nearest the nav, below toasts and the rest pill: it never moves when those come and go,
          so a tap meant for a leaving toast's Undo can't land on Finish. Every set is logged when
          it shows, so it's the accent: the next thing to do. */}
      {inDock && (
        <DockItem id="finish" priority={DOCK_FINISH_PRIORITY}>
          <motion.button
            type="button"
            // The visible text, spelled out with its spaces (the parts are separate flex items).
            aria-label={`Finish · ${doneSets}/${totalSets} sets`}
            onClick={press}
            className={clsx(
              // A very short screen (a phone at 200% zoom, landscape) keeps the dock for what can't
              // wait — the rest pill, toasts — which Finish would otherwise squeeze out (the dock
              // is capped at 40% of the height). Finish is still at the end of the page.
              DOCK_FINISH_SHORT_SCREEN,
              "tap hc-edge pointer-events-auto inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-full px-5 text-sm font-medium whitespace-nowrap shadow-lg",
              "bg-accent text-accent-ink shadow-[0_0_32px_-8px_rgb(183_243_106/0.6)]",
            )}
            initial={{ y: 12, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ type: "spring", stiffness: 420, damping: 34 }}
          >
            <span>Finish</span>
            <span aria-hidden className="opacity-60">
              ·
            </span>
            <span>
              <span className="num">{`${doneSets}/${totalSets}`}</span>
              {/* On the very narrowest screens (200% zoom) the count alone has to do. */}
              <span className="max-[259px]:hidden"> sets</span>
            </span>
          </motion.button>
        </DockItem>
      )}
    </div>
  );
}
