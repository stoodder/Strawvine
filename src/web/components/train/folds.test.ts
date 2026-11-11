/**
 * Which done blocks show as their summary row (view state): nothing folds by itself while the
 * page is in use — done blocks fold when the day is opened or the app comes back to the
 * foreground (`foldDone`), and by hand (`setFold`); a block opened by hand stays open through those.
 */
import { describe, expect, it } from "vitest";
import { foldDone, initialFolds, isFolded, reconcileFolds, setFold, type BlockState, type FoldView } from "./folds";

const blocks = (states: Record<string, boolean>): BlockState[] => Object.entries(states).map(([id, done]) => ({ id, done }));
const folded = (view: FoldView, states: Record<string, boolean>) =>
  blocks(states)
    .filter((b) => isFolded(view, b))
    .map((b) => b.id);
/** The day opened (or the app back in the foreground) with the blocks in `states`. */
const opened = (view: FoldView, states: Record<string, boolean>) => foldDone(view, blocks(states));
/** The page in use: the blocks changed to `states`. */
const seen = (view: FoldView, states: Record<string, boolean>) => reconcileFolds(view, blocks(states));

describe("folds", () => {
  it("a day opens with its done blocks folded, the others open", () => {
    const states = { main: true, a: false, b: true };
    expect(folded(opened(initialFolds(), states), states)).toEqual(["main", "b"]);
  });

  it("a block completed while the page is in use doesn't fold — however long it stays done", () => {
    let view = opened(initialFolds(), { a: false, b: false });
    view = seen(view, { a: true, b: false });
    expect(folded(view, { a: true, b: false })).toEqual([]);
    // Nothing changed in the view at all: there is nothing waiting to happen.
    expect(seen(view, { a: true, b: false })).toBe(view);
    expect(seen(view, { a: true, b: true })).toBe(view);
  });

  it("it folds at the next moment the day is opened or the app comes back to the foreground", () => {
    let view = opened(initialFolds(), { a: false, b: false });
    view = seen(view, { a: true, b: false });
    view = opened(view, { a: true, b: false });
    expect(folded(view, { a: true, b: false })).toEqual(["a"]);
    // With nothing new to fold, such a moment changes nothing.
    expect(opened(view, { a: true, b: false })).toBe(view);
  });

  it("by hand: a folded block opens, an open done block folds", () => {
    let view = opened(initialFolds(), { a: true, b: true });
    view = setFold(view, "a", false);
    expect(folded(view, { a: true, b: true })).toEqual(["b"]);
    view = setFold(view, "a", true);
    expect(folded(view, { a: true, b: true })).toEqual(["a", "b"]);
    // One completed on the page (never folded by itself) folds by hand, too.
    view = seen(opened(initialFolds(), { c: false }), { c: true });
    expect(folded(setFold(view, "c", true), { c: true })).toEqual(["c"]);
  });

  it("a block opened by hand stays open through the moments that fold the others — until folded by hand", () => {
    let view = opened(initialFolds(), { a: true, b: false });
    view = setFold(view, "a", false);
    view = seen(view, { a: true, b: true });
    view = opened(view, { a: true, b: true });
    expect(folded(view, { a: true, b: true })).toEqual(["b"]);
    view = setFold(view, "a", true);
    expect(folded(opened(view, { a: true, b: true }), { a: true, b: true })).toEqual(["a", "b"]);
  });

  it("unlogging a set of a folded or hand-opened block makes it an ordinary open block: done again, it folds at the next moment", () => {
    let view = setFold(opened(initialFolds(), { a: true }), "a", false);
    view = seen(view, { a: false });
    expect(view.open.size).toBe(0);
    view = seen(view, { a: true });
    expect(folded(view, { a: true })).toEqual([]);
    expect(folded(opened(view, { a: true }), { a: true })).toEqual(["a"]);
    // A folded block that stops being done (another device unlogged a set) shows open, and isn't remembered as folded.
    view = seen(opened(initialFolds(), { b: true }), { b: false });
    expect(view.folded.size).toBe(0);
    expect(folded(seen(view, { b: true }), { b: true })).toEqual([]);
  });

  it("a block that isn't done is never folded, whatever the view holds", () => {
    const view: FoldView = { folded: new Set(["a"]), open: new Set() };
    expect(isFolded(view, { id: "a", done: false })).toBe(false);
    expect(isFolded(view, { id: "a", done: true })).toBe(true);
  });

  it("a block that appears while the page is in use (a done exercise taken out of a superset) is open", () => {
    let view = opened(initialFolds(), { a: false });
    view = seen(view, { a: false, own: true });
    expect(folded(view, { a: false, own: true })).toEqual([]);
  });

  it("forgets blocks that are gone", () => {
    let view = setFold(opened(initialFolds(), { a: true, b: true }), "a", false);
    view = seen(view, { c: false });
    expect(view.open.size).toBe(0);
    expect(view.folded.size).toBe(0);
  });

  it("returns the same view when nothing changed (the screen reconciles on every render)", () => {
    const view = opened(initialFolds(), { a: true, b: false });
    expect(seen(view, { a: true, b: false })).toBe(view);
  });

  it("a day opens from the blocks opened by hand earlier on this page", () => {
    const view = opened(initialFolds(["a"]), { a: true, b: true });
    expect(folded(view, { a: true, b: true })).toEqual(["b"]);
    expect([...view.open]).toEqual(["a"]);
    // One that isn't done any more isn't held open.
    expect(opened(initialFolds(["a"]), { a: false }).open.size).toBe(0);
  });
});
