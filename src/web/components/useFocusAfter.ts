import { useCallback, useEffect, useRef } from "react";

type Target = HTMLElement | null | undefined | (() => HTMLElement | null | undefined);

/**
 * Moves focus somewhere sensible after the control that had it goes away (a panel's "Use these"
 * button that unmounts with the panel, a row that's deleted…). Focus lands on the next animation
 * frame, after React has committed the change, so the target can be an element that only mounts
 * as a result of the action — pass a function to look it up then.
 *
 *   const focusAfter = useFocusAfter();
 *   onClick={() => { close(); focusAfter(() => triggerRef.current); }}
 *
 * Only one request is pending at a time (the latest wins); a pending one is dropped on unmount.
 */
export function useFocusAfter(): (target: Target) => void {
  const frame = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );
  return useCallback((target: Target) => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const el = typeof target === "function" ? target() : target;
      if (el?.isConnected) el.focus();
    });
  }, []);
}
