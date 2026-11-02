import { useCallback, useEffect, useRef } from "react";

type Target = HTMLElement | null | undefined | (() => HTMLElement | null | undefined);

/** How many frames to keep looking for the target before giving up (~170 ms at 60 Hz). */
export const FOCUS_RETRY_FRAMES = 10;

/** Whether `el` can take focus now: in the document and not inside an `inert` tree (an open sheet's backdrop). */
function focusable(el: HTMLElement | null | undefined): el is HTMLElement {
  return !!el && el.isConnected && !el.closest("[inert]");
}

/**
 * Moves focus somewhere sensible after the control that had it goes away (a panel's "Use these"
 * button that unmounts with the panel, a row that's deleted…). Focus lands from the next
 * animation frame on, after React has committed the change, so the target can be an element that
 * only mounts as a result of the action — pass a function to look it up then.
 *
 *   const focusAfter = useFocusAfter();
 *   onClick={() => { close(); focusAfter(() => triggerRef.current); }}
 *
 * The target is looked up once per frame for up to `frames` frames (default 10) until it exists,
 * is connected and isn't inside an `inert` tree — an edit that reaches the screen through the
 * store, or a sheet that is still closing, can take a frame or two. A target that never becomes
 * focusable is skipped (focus stays where it is).
 *
 * Only one request is pending at a time (the latest wins); a pending one is dropped on unmount.
 */
export function useFocusAfter(): (target: Target, frames?: number) => void {
  const frame = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    },
    [],
  );
  return useCallback((target: Target, frames = FOCUS_RETRY_FRAMES) => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    let left = Math.max(1, frames);
    const attempt = () => {
      frame.current = null;
      const el = typeof target === "function" ? target() : target;
      if (focusable(el)) {
        el.focus();
        return;
      }
      if (--left > 0) frame.current = requestAnimationFrame(attempt);
    };
    frame.current = requestAnimationFrame(attempt);
  }, []);
}
