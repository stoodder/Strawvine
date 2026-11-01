/**
 * Scroll helpers that account for the bottom dock (rest pill, toasts, sync pill) floating over
 * the end of the page: "visible" means between the top of the viewport and the top of the dock.
 */

/** Space kept between a revealed element and the dock / the top edge. */
const MARGIN_PX = 16;

const reduceMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The y coordinate (viewport) above which content isn't covered by the dock or the nav. */
function visibleBottom(): number {
  const dock = document.querySelector<HTMLElement>("[data-dock]");
  // An empty dock has no height: its top is where it would start, just above the nav.
  return dock ? Math.min(window.innerHeight, dock.getBoundingClientRect().top) : window.innerHeight;
}

/**
 * Bring `el` into the visible area: by default only if it's covered (scrolling as little as
 * possible); with `center`, centre it between the top of the screen and the dock.
 */
export function revealAboveDock(el: Element | null, { center = false }: { center?: boolean } = {}) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  const top = MARGIN_PX;
  const bottom = visibleBottom() - MARGIN_PX;
  let delta = 0;
  if (center) delta = (r.top + r.bottom) / 2 - (top + bottom) / 2;
  else if (r.bottom > bottom) delta = Math.min(r.bottom - bottom, r.top - top);
  else if (r.top < top) delta = r.top - top;
  if (Math.abs(delta) < 1) return;
  window.scrollBy({ top: delta, behavior: reduceMotion() ? "auto" : "smooth" });
}

/** Run `fn` once layout has settled after a React commit (two frames: the commit, then the dock's resize). */
export function afterLayout(fn: () => void) {
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

/**
 * Focus the element `find` returns as soon as it exists and can take focus (not inside an inert
 * tree), checking once per frame for up to `frames` frames. For "the control I pressed went away":
 * the replacement can appear a frame or two later, since a session edit reaches the screen
 * through the store rather than in the same React commit.
 */
export function focusWhenReady(find: () => HTMLElement | null, frames = 20) {
  let left = frames;
  const attempt = () => {
    const el = find();
    if (el?.isConnected && !el.closest("[inert]")) {
      el.focus();
      return;
    }
    if (--left > 0) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
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
