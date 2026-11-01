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

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    window.clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setItems((xs) => xs.filter((x) => x.id !== id));
  }, []);

  const show = useCallback(
    (t: ToastInput) => {
      const id = nextId++;
      // Keep at most 2 on screen; newest wins.
      setItems((xs) => [...xs.slice(-1), { ...t, id }]);
      const ms = t.duration ?? (t.action ? 7000 : 5000);
      timers.current.set(
        id,
        window.setTimeout(() => dismiss(id), ms),
      );
      return id;
    },
    [dismiss],
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
          {items.map((t) => (
            <motion.div
              key={t.id}
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
              <span className="min-w-0 flex-1">{t.message}</span>
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

export function useToast(): ToastApi {
  const v = useContext(ToastContext);
  if (!v) throw new Error("useToast outside ToastProvider");
  return v;
}
