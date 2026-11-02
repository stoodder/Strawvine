/**
 * Scroll helpers that account for the bottom dock (rest pill, toasts, sync pill) floating over
 * the end of the page: "visible" means between the top of the viewport and the top of the dock.
 * (Focus hand-offs use the shared `useFocusAfter`.)
 */

import { useCallback, useRef } from "react";
import { useDockTop } from "../Dock";

/** Space kept between a revealed element and the dock / the top edge. */
const MARGIN_PX = 16;

const reduceMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Bring `el` into the visible area above `dockTop` (the viewport y of the dock's top edge, from
 * `useDockTop`): by default only if it's covered (scrolling as little as possible); with
 * `center`, centre it between the top of the screen and the dock.
 */
export function revealAboveDock(el: Element | null, dockTop: number, { center = false }: { center?: boolean } = {}) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  const top = MARGIN_PX;
  const bottom = Math.min(window.innerHeight, dockTop) - MARGIN_PX;
  let delta = 0;
  if (center) delta = (r.top + r.bottom) / 2 - (top + bottom) / 2;
  else if (r.bottom > bottom) delta = Math.min(r.bottom - bottom, r.top - top);
  else if (r.top < top) delta = r.top - top;
  if (Math.abs(delta) < 1) return;
  window.scrollBy({ top: delta, behavior: reduceMotion() ? "auto" : "smooth" });
}

/**
 * `revealAboveDock` bound to the live dock edge. The returned function is stable and reads the
 * latest `useDockTop()` when it runs — typically a frame or two after a commit (`afterLayout`),
 * once a rest pill or toast that just appeared has been measured.
 */
export function useRevealAboveDock(): (el: Element | null, opts?: { center?: boolean }) => void {
  const dockTop = useDockTop();
  const latest = useRef(dockTop);
  latest.current = dockTop;
  return useCallback((el, opts) => revealAboveDock(el, latest.current, opts), []);
}

/** Run `fn` once layout has settled after a React commit (two frames: the commit, then the dock's resize). */
export function afterLayout(fn: () => void) {
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

/** Run `fn` on the first frame `ready()` holds (checking for up to `frames` frames). */
export function whenReady(ready: () => boolean, fn: () => void, frames = 20) {
  let left = frames;
  const attempt = () => {
    if (ready()) fn();
    else if (--left > 0) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}
