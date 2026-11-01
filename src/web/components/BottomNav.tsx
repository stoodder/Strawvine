import clsx from "clsx";
import { motion } from "motion/react";
import { useRef } from "react";
import { NavLink, useLocation } from "react-router";
import { Activity, Dumbbell, Sun, Target } from "lucide-react";
import { tick } from "../lib/haptics";
import { useDockAnchor } from "./Dock";

const TABS = [
  { to: "/", label: "Today", icon: Sun, match: (p: string) => p === "/" || p.startsWith("/day") },
  { to: "/train", label: "Train", icon: Dumbbell, match: (p: string) => p.startsWith("/train") },
  { to: "/progress", label: "Progress", icon: Activity, match: (p: string) => p.startsWith("/progress") },
  { to: "/goals", label: "Goals", icon: Target, match: (p: string) => p.startsWith("/goals") },
];

export function BottomNav() {
  const { pathname } = useLocation();
  const ref = useRef<HTMLElement>(null);
  // The dock (rest timer, toasts, sync pill) stacks just above the nav.
  useDockAnchor(ref);
  return (
    <nav
      ref={ref}
      className="fixed inset-x-0 bottom-0 z-40 mx-auto max-w-lg px-5 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]"
      aria-label="Primary"
    >
      <div className="hc-edge flex items-center justify-around gap-0.5 rounded-full bg-ink-800/80 px-2 py-1.5 shadow-[0_10px_40px_-10px_rgba(0,0,0,0.9)] ring-1 ring-white/[0.05] backdrop-blur-xl">
        {TABS.map((t) => {
          const active = t.match(pathname);
          const Icon = t.icon;
          return (
            <NavLink
              key={t.to}
              to={t.to}
              onClick={tick}
              aria-current={active ? "page" : undefined}
              className={clsx(
                "tap relative flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-full py-2",
                active ? "text-fg" : "text-mute",
              )}
            >
              {active && (
                <motion.span
                  layoutId="nav-pill"
                  className="absolute inset-0 rounded-full bg-white/[0.06]"
                  transition={{ type: "spring", stiffness: 500, damping: 40 }}
                />
              )}
              <Icon size={18} aria-hidden strokeWidth={active ? 2.2 : 1.8} className={clsx("relative shrink-0", active && "text-accent")} />
              {/* rem so it follows the user's font size; truncates (or hides, when very narrow) instead of overflowing. */}
              <span className="relative max-w-full truncate px-0.5 text-2xs font-medium tracking-wide max-[16rem]:sr-only">{t.label}</span>
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}
