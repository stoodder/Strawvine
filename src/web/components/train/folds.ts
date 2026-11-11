/**
 * Which finished blocks of a Train day show as their summary row. View state only: it is never
 * part of the session, the store or the outbox — each device (each page load) has its own.
 *
 * Nothing ever folds under a thumb. A done block folds, in one step, only
 *   - when its day is opened: the screen appears (the app is opened, the Train tab is come back
 *     to) or shows another date;
 *   - when the app comes back to the foreground (`visibilitychange`), the page held in place
 *     around what the athlete was looking at (`foldInPlace`);
 *   - by hand: a tap on its open header folds it, a tap on its folded row opens it.
 * A block that becomes done while the page is in use — its last set logged here, or on another
 * device — stays as it is until the next of those moments.
 *
 * A block opened by hand stays open through those moments, for the life of the page (`rememberedOpen`),
 * until it is folded by hand — or stops being done (a set unlogged or added), which makes it an
 * ordinary open block again.
 */
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

export interface FoldView {
  /** Blocks shown as their summary row (each of them done). */
  folded: ReadonlySet<string>;
  /** Done blocks opened by hand: they stay open when the others fold. */
  open: ReadonlySet<string>;
}

export interface BlockState {
  id: string;
  /** Every set of the block is logged (`blockComplete`). */
  done: boolean;
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((x) => b.has(x));

/** A day before it has been looked at: nothing folded, `open` the blocks opened by hand earlier. */
export const initialFolds = (open: Iterable<string> = []): FoldView => ({ folded: new Set(), open: new Set(open) });

/** Whether a block shows as its summary row. */
export const isFolded = (view: FoldView, block: BlockState): boolean => block.done && view.folded.has(block.id);

/**
 * Keep the view true to the blocks as they are now: a block that isn't done (or is gone) is
 * neither folded nor "opened by hand". Nothing is ever folded here. The same object when nothing changed.
 */
export function reconcileFolds(view: FoldView, blocks: ReadonlyArray<BlockState>): FoldView {
  const done = new Set(blocks.filter((b) => b.done).map((b) => b.id));
  const folded = new Set([...view.folded].filter((id) => done.has(id)));
  const open = new Set([...view.open].filter((id) => done.has(id)));
  return sameSet(folded, view.folded) && sameSet(open, view.open) ? view : { folded, open };
}

/** One of the moments at which done blocks fold: every done block does, except those opened by hand. */
export function foldDone(view: FoldView, blocks: ReadonlyArray<BlockState>): FoldView {
  const kept = reconcileFolds(view, blocks);
  const folded = new Set(blocks.filter((b) => b.done && !kept.open.has(b.id)).map((b) => b.id));
  return sameSet(folded, kept.folded) ? kept : { folded, open: kept.open };
}

/** A done block folded (`fold`) or opened by hand. */
export function setFold(view: FoldView, id: string, fold: boolean): FoldView {
  const folded = new Set(view.folded);
  const open = new Set(view.open);
  if (fold) {
    folded.add(id);
    open.delete(id);
  } else {
    folded.delete(id);
    open.add(id);
  }
  return { folded, open };
}

// --- Remembered for the life of the page ----------------------------------------------------

const remembered = new Map<string, ReadonlySet<string>>();
/** The blocks of `date` opened by hand earlier on this page. */
export const rememberedOpen = (date: string): ReadonlySet<string> => remembered.get(date) ?? new Set();
function remember(date: string, ids: ReadonlySet<string>) {
  if (ids.size) remembered.set(date, new Set(ids));
  else remembered.delete(date);
}
/** Forget every day's hand-opened blocks (tests). */
export const forgetFolds = () => remembered.clear();

// --- Folding with the page held in place ----------------------------------------------------

/**
 * Apply a change that folds the blocks `folding` (`apply` must commit it synchronously) without
 * moving what the athlete was looking at: the first block at or below the top of the screen that
 * isn't done — the one being worked on, as a rule — is where it was afterwards (past the last
 * block: the end of the exercises, `[data-fold-end]`, with everything after it). Done blocks
 * don't count, folded or open: a row already folded at the top of the screen must not hold the
 * page while the block under the thumb comes up. One layout read before, one after, one scroll;
 * the page is still (the app has only just come back to the foreground). Blocks folding above
 * that point make the page shorter above it, so the page is scrolled up by as much; at the very
 * top of the page there is nothing to scroll, and what is left simply comes up.
 *
 * Keyboard focus inside a block that folds goes to its folded row.
 */
export function foldInPlace(folding: ReadonlySet<string>, apply: () => void) {
  const marks = [...document.querySelectorAll<HTMLElement>("[data-fold], [data-fold-end]")];
  const anchor = marks.find((el) => !el.hasAttribute("data-done") && el.getBoundingClientRect().bottom > 0);
  const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-fold]")?.dataset.fold;
  const before = anchor?.getBoundingClientRect().top;
  apply();
  if (anchor && before !== undefined && anchor.isConnected) {
    const moved = Math.round(anchor.getBoundingClientRect().top - before);
    if (moved) window.scrollBy(0, moved);
  }
  if (focused && folding.has(focused))
    document.querySelector<HTMLElement>(`[data-fold-toggle="${focused}"]`)?.focus({ preventScroll: true });
}

/**
 * The folds of one Train day. `blocks`: every block with whether it is done.
 *
 * Returns `folded(id)` and `setFolded(id, fold)` (by hand). Opening the day folds its done blocks
 * (the first render for a date); coming back to the foreground folds them in place.
 */
export function useFolds(date: string, blocks: ReadonlyArray<BlockState>) {
  const [state, setState] = useState(() => ({ date, view: foldDone(initialFolds(rememberedOpen(date)), blocks) }));
  // Another day in the same screen is a day opened: its done blocks fold (derived during render, as the screen does for its date).
  const view = state.date === date ? reconcileFolds(state.view, blocks) : foldDone(initialFolds(rememberedOpen(date)), blocks);
  if (state.date !== date || view !== state.view) setState({ date, view });

  const open = [...view.open].sort().join(" ");
  useEffect(() => {
    remember(date, new Set(open ? open.split(" ") : []));
  }, [date, open]);

  const now = useRef({ date, blocks, view });
  now.current = { date, blocks, view };
  useEffect(() => {
    const onVisibility = () => {
      // Back in the foreground (the phone was unlocked, the app switched back to): nobody's finger is on the page.
      // Behind an open sheet the page is pinned and can't be held in place: it folds at the next of these moments.
      if (document.visibilityState !== "visible" || "scrollLocked" in document.documentElement.dataset) return;
      const { date, blocks, view } = now.current;
      const next = foldDone(view, blocks);
      if (next === view) return;
      const folding = new Set([...next.folded].filter((id) => !view.folded.has(id)));
      foldInPlace(folding, () => flushSync(() => setState((s) => (s.date === date ? { date, view: foldDone(s.view, blocks) } : s))));
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const byId = new Map(blocks.map((b) => [b.id, b]));
  return {
    /** Whether a block shows as its summary row. */
    folded: (id: string) => {
      const b = byId.get(id);
      return !!b && isFolded(view, b);
    },
    /** Fold a done block, or open it, by hand. */
    setFolded: (id: string, fold: boolean) => setState((s) => (s.date === date ? { date, view: setFold(s.view, id, fold) } : s)),
  };
}
