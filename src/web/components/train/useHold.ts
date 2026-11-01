import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { tick } from "../../lib/haptics";

export const HOLD_MS = 400;

/**
 * Tap vs. hold on one control: tap runs `onTap`, holding for HOLD_MS runs `onHold` (and the
 * click that follows the release is swallowed). `holding` drives a visible progress cue, since
 * iOS ignores vibration. Keyboard / AT: Shift+F10 or the ContextMenu key (and right-click)
 * run `onHold`.
 */
export function useHold({ onTap, onHold, ms = HOLD_MS }: { onTap: () => void; onHold: () => void; ms?: number }) {
  const timer = useRef<number | null>(null);
  /** When the last hold fired (dedupes touch long-press + the contextmenu it also raises). */
  const heldAt = useRef(0);
  /** A pointer hold swallows the click its release produces — only that one, and only briefly. */
  const swallowUntil = useRef(0);
  const [holding, setHolding] = useState(false);

  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  };
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const fireHold = (fromPointer: boolean) => {
    const now = Date.now();
    if (now - heldAt.current < 600) return;
    heldAt.current = now;
    if (fromPointer) swallowUntil.current = now + 1500;
    tick();
    onHold();
  };

  return {
    holding,
    handlers: {
      onPointerDown: (e: PointerEvent) => {
        if (e.button !== 0) return;
        swallowUntil.current = 0;
        clear();
        setHolding(true);
        timer.current = window.setTimeout(() => {
          timer.current = null;
          setHolding(false);
          fireHold(true);
        }, ms);
      },
      onPointerUp: clear,
      onPointerLeave: clear,
      onPointerCancel: clear,
      onContextMenu: (e: MouseEvent) => {
        e.preventDefault();
        // A touch long-press already handled (or still timing) — don't open twice.
        if (timer.current !== null || Date.now() - heldAt.current < 1500) return;
        fireHold(false);
      },
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
          e.preventDefault();
          fireHold(false);
        }
      },
      onClick: () => {
        if (Date.now() < swallowUntil.current) {
          swallowUntil.current = 0;
          return;
        }
        onTap();
      },
    },
  };
}
