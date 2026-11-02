import clsx from "clsx";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, CloudOff, RefreshCw } from "lucide-react";
import { useSyncInfo } from "../../lib/store";
import { useSyncState } from "../SyncStatus";

/** How long the "synced" tick stays after a successful tap. */
const DONE_MS = 1600;

/** "settling": the sync finished; the next render (with the store as it is now) decides done or idle. */
type Phase = "idle" | "busy" | "settling" | "done";

/**
 * A small chip in Today's header while the day has edits the server hasn't confirmed: "2 unsynced"
 * (the count is everything waiting, since a sync sends it all). Tapping it syncs now — a spinner
 * while it runs, then a brief "synced" tick before it goes away. Offline it says so and can't be
 * tapped (the edits sync on their own when the connection is back); while the server can't be
 * reached (the dock says "Can't reach server") it takes the warn tone. Nothing shows when nothing
 * is pending.
 *
 * The chip goes away by itself (after "synced", or when the day clears): if it had focus, focus
 * moves to `focusFallback()` (Today's date control) first, so keyboard users aren't dropped on <body>.
 */
export function PendingSyncChip({
  pending,
  focusFallback,
}: {
  /** This day has edits waiting to sync. */
  pending: boolean;
  /** Where focus goes when the chip disappears while focused. */
  focusFallback?: () => HTMLElement | null | undefined;
}) {
  const info = useSyncInfo();
  const sync = useSyncState();
  const ref = useRef<HTMLButtonElement>(null);
  const reduce = useReducedMotion();
  const [phase, setPhase] = useState<Phase>("idle");
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  useEffect(() => {
    if (phase !== "done") return;
    const t = window.setTimeout(() => setPhase("idle"), DONE_MS);
    return () => window.clearTimeout(t);
  }, [phase]);
  useEffect(() => {
    if (phase === "settling") setPhase(pending ? "idle" : "done");
  }, [phase, pending]);
  // An edit made while the tick shows: back to the count.
  useEffect(() => {
    if (pending && phase === "done") setPhase("idle");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when edits arrive
  }, [pending, info.unsynced]);

  const n = info.unsynced || info.pending;
  const busy = phase === "busy" || phase === "settling";
  const visible = phase !== "idle" || (pending && n > 0);
  const offline = !info.online;
  // The last attempt failed (network / 5xx) and the outbox is backing off: same as the dock's pill.
  const unreachable = !offline && sync.retrying && phase === "idle";

  // Leaving while focused: hand focus on before the exit animation removes the button.
  const wasVisible = useRef(visible);
  useLayoutEffect(() => {
    if (wasVisible.current && !visible && ref.current && ref.current === document.activeElement) focusFallback?.()?.focus();
    wasVisible.current = visible;
  }, [visible, focusFallback]);

  const run = async () => {
    if (busy || offline) return;
    setPhase("busy");
    try {
      await info.syncNow();
    } finally {
      if (mounted.current) setPhase("settling");
    }
  };

  return (
    <>
      <span role="status" className="sr-only">
        {busy ? "Syncing…" : phase === "done" ? "All changes synced" : ""}
      </span>
      <AnimatePresence initial={false}>
        {visible && (
          <motion.button
            key="chip"
            ref={ref}
            type="button"
            data-pending-chip={phase}
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
            transition={{ duration: 0.18 }}
            disabled={offline && phase === "idle"}
            // Starts with the visible words (voice control: "tap 2 unsynced").
            aria-label={
              phase === "done"
                ? "Synced"
                : busy
                  ? "Syncing"
                  : offline
                    ? `${n} offline. ${n === 1 ? "This change syncs" : "These changes sync"} when you're back online`
                    : unreachable
                      ? `${n} unsynced. Can't reach the server. Try now`
                      : `${n} unsynced. Sync now`
            }
            onClick={() => void run()}
            className={clsx(
              // Looks 24px tall; the tap target reaches 44px.
              "tap hc-edge relative inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-white/[0.05] px-2 font-mono text-2xs tracking-[0.08em] whitespace-nowrap uppercase",
              "after:absolute after:-inset-x-1 after:-inset-y-2.5 after:content-[''] disabled:cursor-default",
              phase === "done" ? "text-accent" : unreachable ? "text-warn" : "text-fg-2",
            )}
          >
            {busy ? (
              <RefreshCw aria-hidden size={10} className={clsx("shrink-0", !reduce && "animate-spin")} />
            ) : phase === "done" ? (
              <Check aria-hidden size={11} strokeWidth={2.5} className="shrink-0" />
            ) : (
              <>
                {/* Wide: a quiet dot beside the words. Tight (the words hide): a glyph that says what the count is. */}
                <span
                  aria-hidden
                  className={clsx(
                    "h-1.5 w-1.5 shrink-0 rounded-full max-[22rem]:hidden",
                    offline ? "bg-mute" : unreachable ? "bg-warn" : "animate-pulse bg-accent",
                  )}
                />
                {offline || unreachable ? (
                  <CloudOff aria-hidden size={11} className="shrink-0 min-[22rem]:hidden" />
                ) : (
                  <RefreshCw aria-hidden size={10} className="shrink-0 text-accent min-[22rem]:hidden" />
                )}
              </>
            )}
            <span aria-hidden className="num">
              {phase === "done" ? (
                "synced"
              ) : busy ? (
                "syncing"
              ) : (
                <>
                  {n}
                  {/* Just the count when the header is tight (320px and narrower, or zoomed in). */}
                  <span className="max-[22rem]:sr-only"> {offline ? "offline" : "unsynced"}</span>
                </>
              )}
            </span>
          </motion.button>
        )}
      </AnimatePresence>
    </>
  );
}
