/**
 * App-wide toasts: transient messages with an optional action (e.g. Undo / Retry).
 * Also the app's polite live region, so messages are announced to screen readers.
 * Rendered into the dock (see Dock.tsx: outside #root, above the nav) so it stays interactive while a
 * sheet makes #root inert. Needs a <DockProvider> above the <ToastProvider>.
 *
 *   const toast = useToast();
 *   toast.show({ message: "Week removed", action: { label: "Undo", onAction: restore } });
 *   toast.show({ message: "Couldn't save steps", tone: "warn", action: { label: "Retry", onAction: retry } });
 */
import clsx from "clsx";
import { AnimatePresence, motion } from "motion/react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DOCK_PRIORITY, DockItem } from "./Dock";

export interface ToastInput {
  message: string;
  tone?: "default" | "warn" | "good";
  action?: { label: string; onAction: () => void };
  /** ms before auto-dismiss; default 5000 (7000 with an action). */
  duration?: number;
  /**
   * Called once when the toast leaves, however it goes: timed out, dismissed, pushed out by newer
   * ones, or after its action ran. For whoever needs to know that an Undo is no longer on offer.
   */
  onClose?: () => void;
}

interface ToastItem extends ToastInput {
  id: number;
}

interface ToastApi {
  show: (t: ToastInput) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

let nextId = 1;

/** Toasts can also be raised from outside React (e.g. the data layer). */
let external: ToastApi | null = null;
export function showToast(t: ToastInput): number {
  return external?.show(t) ?? -1;
}

/** A toast's auto-dismiss: the time left, and the running timeout (null while paused). */
interface Timer {
  left: number;
  startedAt: number;
  handle: number | null;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<number, Timer>());
  const closers = useRef(new Map<number, () => void>());
  /** Tells a toast's owner it has gone — once, and never in the middle of a render. */
  const closed = useCallback((id: number) => {
    const onClose = closers.current.get(id);
    if (!onClose) return;
    closers.current.delete(id);
    queueMicrotask(onClose);
  }, []);

  const dismiss = useCallback(
    (id: number) => {
      const t = timers.current.get(id);
      if (t?.handle != null) window.clearTimeout(t.handle);
      timers.current.delete(id);
      setItems((xs) => xs.filter((x) => x.id !== id));
      closed(id);
    },
    [closed],
  );

  const start = useCallback(
    (id: number) => {
      const t = timers.current.get(id);
      if (!t || t.handle !== null) return;
      t.startedAt = Date.now();
      t.handle = window.setTimeout(() => dismiss(id), t.left);
    },
    [dismiss],
  );
  // While a toast is hovered or has focus it stays (WCAG 2.2.1): reading it, or reaching Undo by
  // keyboard, never races the timer. Leaving it resumes the time that was left (at least 2 s).
  const pause = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (!t || t.handle === null) return;
    window.clearTimeout(t.handle);
    t.handle = null;
    t.left = Math.max(2000, t.left - (Date.now() - t.startedAt));
  }, []);

  const show = useCallback(
    (t: ToastInput) => {
      const id = nextId++;
      // Keep at most 2 on screen; newest wins.
      setItems((xs) => {
        const kept = xs.slice(-1);
        for (const x of xs)
          if (!kept.includes(x)) {
            dismissTimer(timers.current, x.id);
            closed(x.id);
          }
        return [...kept, { ...t, id }];
      });
      if (t.onClose) closers.current.set(id, t.onClose);
      timers.current.set(id, { left: t.duration ?? (t.action ? 7000 : 5000), startedAt: Date.now(), handle: null });
      start(id);
      return id;
    },
    [start, closed],
  );

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);
  useEffect(() => {
    external = api;
    return () => {
      if (external === api) external = null;
    };
  }, [api]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* In the dock (outside #root): sheets make #root inert, and Undo must stay reachable. */}
      <DockItem id="toasts" priority={DOCK_PRIORITY.toast} overSheets>
        {/* The live region is sr-only (absolute), so it takes no room in the dock when idle. */}
        <div role="status" aria-live="polite" className="sr-only">
          {items.length > 0 && <span key={items.at(-1)!.id}>{items.at(-1)!.message}</span>}
        </div>
        <AnimatePresence initial={false}>
          {items.map((t, i) => (
            <motion.div
              key={t.id}
              data-toast=""
              onPointerEnter={() => pause(t.id)}
              onPointerLeave={(e) => {
                if (!e.currentTarget.contains(document.activeElement)) start(t.id);
              }}
              onFocus={() => pause(t.id)}
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null) && !e.currentTarget.matches(":hover")) start(t.id);
              }}
              layout
              initial={{ y: 16, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 16, opacity: 0 }}
              transition={{ type: "spring", stiffness: 420, damping: 34 }}
              className={clsx(
                "hc-edge pointer-events-auto flex w-full items-center gap-3 rounded-2xl bg-ink-700/95 py-2.5 pr-2 pl-4 text-sm shadow-[0_10px_40px_-10px_rgba(0,0,0,0.9)] ring-1 ring-white/[0.06] backdrop-blur-xl",
                t.tone === "warn" ? "text-warn" : t.tone === "good" ? "text-accent" : "text-fg",
              )}
            >
              {/* The older of two toasts gives way to one line when the viewport is short (landscape, zoomed in). */}
              <span className={clsx("min-w-0 flex-1 wrap-anywhere", i < items.length - 1 && "[@media(max-height:30rem)]:line-clamp-1")}>{t.message}</span>
              {t.action && (
                <button
                  type="button"
                  className="tap min-h-11 shrink-0 rounded-full px-4 font-medium text-accent"
                  onClick={() => {
                    t.action!.onAction();
                    dismiss(t.id);
                  }}
                >
                  {t.action.label}
                </button>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
      </DockItem>
    </ToastContext.Provider>
  );
}

function dismissTimer(timers: Map<number, Timer>, id: number) {
  const t = timers.get(id);
  if (t?.handle != null) window.clearTimeout(t.handle);
  timers.delete(id);
}

export function useToast(): ToastApi {
  const v = useContext(ToastContext);
  if (!v) throw new Error("useToast outside ToastProvider");
  return v;
}
