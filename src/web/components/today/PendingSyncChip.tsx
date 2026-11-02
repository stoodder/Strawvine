import clsx from "clsx";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Check, RefreshCw } from "lucide-react";
import { useSyncInfo } from "../../lib/store";

/** How long the "synced" tick stays after a successful tap. */
const DONE_MS = 1600;

/** "settling": the sync finished; the next render (with the store as it is now) decides done or idle. */
type Phase = "idle" | "busy" | "settling" | "done";

/**
 * A small chip in Today's header while the day has edits the server hasn't confirmed: "2 unsynced"
 * (the count is everything waiting, since a sync sends it all). Tapping it syncs now — a spinner
 * while it runs, then a brief "synced" tick before it goes away. Offline it says so and can't be
 * tapped (the edits sync on their own when the connection is back). Nothing shows when nothing
 * is pending.
 */
export function PendingSyncChip({ pending }: { /** This day has edits waiting to sync. */ pending: boolean }) {
  const info = useSyncInfo();
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
                    : `${n} unsynced. Sync now`
            }
            onClick={() => void run()}
            className={clsx(
              // Looks 24px tall; the tap target reaches 44px.
              "tap hc-edge relative inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-white/[0.05] px-2 font-mono text-2xs tracking-[0.08em] whitespace-nowrap uppercase",
              "after:absolute after:-inset-x-1 after:-inset-y-2.5 after:content-[''] disabled:cursor-default",
              phase === "done" ? "text-accent" : "text-fg-2",
            )}
          >
            {busy ? (
              <RefreshCw aria-hidden size={10} className={clsx("shrink-0", !reduce && "animate-spin")} />
            ) : phase === "done" ? (
              <Check aria-hidden size={11} strokeWidth={2.5} className="shrink-0" />
            ) : (
              <span aria-hidden className={clsx("h-1.5 w-1.5 shrink-0 rounded-full", offline ? "bg-mute" : "animate-pulse bg-accent")} />
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
