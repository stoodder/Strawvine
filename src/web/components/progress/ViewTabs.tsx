import clsx from "clsx";
import { motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { tick } from "../../lib/haptics";

/** Progress's views, in tab order. The first is the default (`/progress`); the others are `?view=<id>`. */
export const PROGRESS_VIEWS = [
  { id: "week", label: "Week" },
  { id: "body", label: "Body" },
  { id: "fuel", label: "Fuel" },
  { id: "activity", label: "Activity" },
  { id: "strength", label: "Strength" },
] as const;
export type ProgressView = (typeof PROGRESS_VIEWS)[number]["id"];

/** The view a `?view=` value names; anything else (or nothing) is the week. */
export function viewFromParam(value: string | null): ProgressView {
  return PROGRESS_VIEWS.find((v) => v.id === value)?.id ?? "week";
}

const LAST_VIEW_KEY = "strawvine:progress-view";

/**
 * The view last shown, for this browser session (sessionStorage: gone with the tab or the Home
 * Screen app's process). Storage may be unavailable (private mode, blocked): then nothing is
 * remembered, quietly.
 */
export function rememberProgressView(view: ProgressView): void {
  try {
    sessionStorage.setItem(LAST_VIEW_KEY, view);
  } catch {
    // Not remembered: Progress opens on Week.
  }
}

/** The remembered view, or null when there is none (or it names no view any more). */
export function recallProgressView(): ProgressView | null {
  try {
    const stored = sessionStorage.getItem(LAST_VIEW_KEY);
    return PROGRESS_VIEWS.find((v) => v.id === stored)?.id ?? null;
  } catch {
    return null;
  }
}

export const PROGRESS_PANEL_ID = "progress-panel";
export const progressTabId = (view: ProgressView) => `progress-tab-${view}`;

/**
 * The segmented control under Progress's header: a tablist that stays in reach while the view
 * scrolls. It sticks just under the safe area (the notch / status bar of the Home Screen app) and,
 * once stuck, sits on an ink backing that also covers that safe area, so charts never show through
 * the clock. Too narrow for five tabs (a small phone, 200 % zoom), it scrolls sideways inside
 * itself — the page never does — and keeps the selected tab in sight.
 *
 * Tabs follow the ARIA pattern with automatic activation: one tab stop, ← → Home End move and
 * select. The panel (`PROGRESS_PANEL_ID`) is rendered by the screen.
 */
export function ViewTabs({ view, onChange }: { view: ProgressView; onChange: (view: ProgressView) => void }) {
  const mark = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  const mounted = useRef(false);

  /** The page scroll at which the bar starts to stick: its place in the flow (the mark above it) less its sticky offset. */
  const stuckAt = () => {
    const m = mark.current;
    const el = bar.current;
    if (!m || !el) return null;
    return m.getBoundingClientRect().top + window.scrollY - (parseFloat(getComputedStyle(el).top) || 0);
  };

  useEffect(() => {
    const measure = () => {
      const at = stuckAt();
      setStuck(at !== null && window.scrollY > at + 0.5);
    };
    measure();
    window.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, []);

  useLayoutEffect(() => {
    // The selected tab, centred when the control scrolls inside itself.
    const l = list.current;
    const tab = l?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (l && tab && l.scrollWidth > l.clientWidth) l.scrollLeft = tab.offsetLeft - (l.clientWidth - tab.offsetWidth) / 2;
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    // A new view starts at its top: when the page was scrolled into the old one (the bar is
    // stuck), go back to where the bar just sticks, the view's top under it. Never scrolls down.
    const at = stuckAt();
    if (at !== null && window.scrollY > at + 1) window.scrollTo(0, at);
  }, [view]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const i = PROGRESS_VIEWS.findIndex((v) => v.id === view);
    const n = PROGRESS_VIEWS.length;
    const next =
      e.key === "ArrowRight"
        ? (i + 1) % n
        : e.key === "ArrowLeft"
          ? (i - 1 + n) % n
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? n - 1
              : null;
    if (next === null) return;
    e.preventDefault();
    const id = PROGRESS_VIEWS[next]!.id;
    document.getElementById(progressTabId(id))?.focus();
    if (id !== view) onChange(id);
  };

  return (
    <>
      {/* Marks the bar's place in the flow (once stuck, the bar itself can't tell where it came from). */}
      <div ref={mark} aria-hidden />
      <div ref={bar} data-stuck={stuck ? "" : undefined} className="sticky top-[env(safe-area-inset-top)] z-30 -mx-5 px-5 py-2">
        {/* The backing: only once stuck, reaching up over the safe area, fading out below. */}
        <div
          aria-hidden
          className={clsx(
            "pointer-events-none absolute inset-x-0 -top-[env(safe-area-inset-top)] -bottom-3 bg-gradient-to-b from-ink-950 from-[calc(100%-0.75rem)] to-transparent transition-opacity duration-200 motion-reduce:transition-none",
            stuck ? "opacity-100" : "opacity-0",
          )}
        />
        <motion.div
          ref={list}
          // The pill's slide accounts for the control's own sideways scroll.
          layoutScroll
          role="tablist"
          aria-label="Progress views"
          onKeyDown={onKeyDown}
          className="hc-edge scrollbar-none relative flex overflow-x-auto overscroll-x-contain rounded-full bg-white/[0.04] p-1"
        >
          {PROGRESS_VIEWS.map((v) => {
            const selected = v.id === view;
            return (
              <button
                key={v.id}
                type="button"
                role="tab"
                id={progressTabId(v.id)}
                aria-selected={selected}
                aria-controls={PROGRESS_PANEL_ID}
                tabIndex={selected ? 0 : -1}
                onClick={() => {
                  if (selected) return;
                  tick();
                  onChange(v.id);
                }}
                className={clsx(
                  // A 36px pill with a 44px-tall target (the invisible ::after reaches into the track's padding).
                  "tap relative flex min-h-9 min-w-max flex-auto items-center justify-center rounded-full px-1.5 text-[0.8125rem] after:absolute after:inset-x-0 after:-inset-y-1 after:content-['']",
                  // Selected: brighter, heavier and on a pill — not colour alone.
                  selected ? "font-medium text-fg" : "text-fg-2",
                )}
              >
                {selected && (
                  <motion.span
                    layoutId="progress-view-pill"
                    className="absolute inset-0 rounded-full bg-white/[0.08]"
                    transition={{ type: "spring", stiffness: 500, damping: 40 }}
                  />
                )}
                {/* The invisible ::after holds the label at its selected weight, so selecting a tab never nudges its neighbours. */}
                <span
                  data-label={v.label}
                  className="relative grid after:invisible after:col-start-1 after:row-start-1 after:font-medium after:content-[attr(data-label)]"
                >
                  <span className="col-start-1 row-start-1 text-center">{v.label}</span>
                </span>
              </button>
            );
          })}
        </motion.div>
      </div>
    </>
  );
}
