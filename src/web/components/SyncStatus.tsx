/**
 * A small pill above the nav that appears only when edits are waiting to reach the server or
 * the device is offline. Tapping it in the failed state offers Retry / Discard.
 */
import clsx from "clsx";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { discardFailed, getSyncState, retryFailed, subscribeSync, type SyncState } from "../lib/sync";

export function useSyncState(): SyncState {
  return useSyncExternalStore(subscribeSync, getSyncState, getSyncState);
}

type View = { tone: "idle" | "busy" | "warn"; label: string } | null;

function view(s: SyncState, showBusy: boolean): View {
  const n = s.pending;
  if (s.failed) return { tone: "warn", label: `${s.failed} not saved` };
  if (!s.online) return { tone: "idle", label: n ? `Offline · ${n} pending` : "Offline" };
  if (s.authPaused && n) return { tone: "warn", label: `Signed out · ${n} pending` };
  if (s.retrying && n) return { tone: "warn", label: `Can't reach server · ${n} pending` };
  if (n && showBusy) return { tone: "busy", label: "Syncing…" };
  return null;
}

export function SyncStatus() {
  const s = useSyncState();
  // A normal save takes well under a second: only mention syncing when it's slow.
  const [slow, setSlow] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!s.pending) {
      setSlow(false);
      return;
    }
    const t = window.setTimeout(() => setSlow(true), 1500);
    return () => window.clearTimeout(t);
  }, [s.pending]);
  useEffect(() => {
    if (!s.failed) setOpen(false);
  }, [s.failed]);

  const v = view(s, slow);
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+4.9rem)] z-40 mx-auto flex max-w-lg justify-center px-5"
      role="status"
      aria-live="polite"
    >
      <AnimatePresence>
        {v && (
          <motion.div
            key="pill"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.2 }}
            className={clsx(
              "flex max-w-full items-center gap-2 rounded-full bg-ink-800/90 px-3 py-1 shadow-[0_6px_24px_-8px_rgba(0,0,0,0.9)] backdrop-blur-xl",
              v.tone === "warn" && "pointer-events-auto",
            )}
          >
            <button
              type="button"
              disabled={v.tone !== "warn" || !s.failed}
              onClick={() => setOpen((o) => !o)}
              aria-expanded={s.failed ? open : undefined}
              className="flex min-h-6 items-center gap-2 font-mono text-[10.5px] tracking-[0.12em] uppercase disabled:cursor-default"
            >
              <span
                aria-hidden
                className={clsx(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  v.tone === "warn" ? "bg-warn" : v.tone === "busy" ? "animate-pulse bg-accent" : "bg-faint",
                )}
              />
              <span className={v.tone === "warn" ? "text-warn" : "text-fg-2"}>{v.label}</span>
            </button>
            {open && s.failed > 0 && (
              <span className="flex items-center gap-1">
                <button type="button" className="tap min-h-8 rounded-full px-2.5 text-xs font-medium text-accent" onClick={retryFailed}>
                  Retry
                </button>
                <button
                  type="button"
                  className="tap min-h-8 rounded-full px-2.5 text-xs text-mute"
                  onClick={() => {
                    if (window.confirm(`Discard ${s.failed} change${s.failed === 1 ? "" : "s"} the server rejected?`)) discardFailed();
                  }}
                >
                  Discard
                </button>
              </span>
            )}
          </motion.div>
        )}
      </AnimatePresence>
      {open && s.failedMessage && <span className="sr-only">{s.failedMessage}</span>}
    </div>
  );
}
