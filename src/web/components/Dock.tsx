/**
 * The dock: one fixed stack just above the bottom nav (or the safe area, when there is no nav)
 * that every piece of transient bottom UI renders into, so the rest timer, toasts and the sync
 * pill stack instead of overlapping.
 *
 *   <DockProvider>…app…</DockProvider>               // once, near the root
 *   <DockItem id="rest" priority={DOCK_PRIORITY.rest}>{pill}</DockItem>
 *   const reserve = useDockHeight();                  // px the stack currently takes
 *
 * Items keep their React context (they are portals), so a DockItem can live anywhere in the tree.
 * Higher priority sits closer to the nav; ties keep mount order. The stack is portaled to
 * <body> (outside #root) so it stays interactive while a sheet makes #root inert; while a sheet
 * is open only items marked `overSheets` (toasts) stay visible.
 *
 * Each item's wrapper is `display: contents`, so the item's own top-level elements are the
 * stack's flex children: render nothing and the item takes no space; render an absolutely
 * positioned live region (sr-only) and it takes no space either.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { anySheetOpen, subscribeSheets } from "./ui";

/** Suggested priorities (higher = closer to the nav). */
export const DOCK_PRIORITY = { sync: 10, rest: 20, toast: 30 } as const;

interface Entry {
  id: string;
  priority: number;
  seq: number;
  overSheets: boolean;
  el: HTMLElement;
}

interface DockApi {
  register: (e: Entry) => () => void;
  update: () => void;
  setAnchor: (el: HTMLElement | null) => void;
}

const DockContext = createContext<DockApi | null>(null);
const DockHeightContext = createContext(0);

let seq = 0;
/** Gap between the nav (or the screen edge) and the stack, and between items. */
const GAP_PX = 8;

export function DockProvider({ children }: { children: ReactNode }) {
  const entries = useRef(new Map<string, Entry>());
  const stackRef = useRef<HTMLDivElement>(null);
  const [version, setVersion] = useState(0);
  const [anchor, setAnchorEl] = useState<HTMLElement | null>(null);
  const [base, setBase] = useState<number | null>(null);
  const [height, setHeight] = useState(0);
  const sheetOpen = useSyncExternalStore(subscribeSheets, anySheetOpen, anySheetOpen);

  const update = useCallback(() => setVersion((v) => v + 1), []);
  const api = useMemo<DockApi>(
    () => ({
      register: (e) => {
        entries.current.set(e.id, e);
        update();
        return () => {
          if (entries.current.get(e.id) === e) entries.current.delete(e.id);
          e.el.remove();
          update();
        };
      },
      update,
      setAnchor: setAnchorEl,
    }),
    [update],
  );

  // Put every item's element into the stack in priority order, moving only what is out of place
  // (moving a node would drop focus from a control inside it).
  useLayoutEffect(() => {
    const stack = stackRef.current;
    if (!stack) return;
    const sorted = [...entries.current.values()].sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    sorted.forEach((e, i) => {
      e.el.style.display = sheetOpen && !e.overSheets ? "none" : "contents";
      const at = stack.children[i] ?? null;
      if (at !== e.el) stack.insertBefore(e.el, at);
    });
  }, [version, sheetOpen]);

  // Sit just above the nav: follow its height (it includes the safe-area inset).
  useEffect(() => {
    if (!anchor) {
      setBase(null);
      return;
    }
    const measure = () => setBase(anchor.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(anchor);
    return () => ro.disconnect();
  }, [anchor]);

  useEffect(() => {
    const stack = stackRef.current;
    if (!stack || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setHeight(Math.round(stack.getBoundingClientRect().height)));
    ro.observe(stack);
    return () => ro.disconnect();
  }, []);

  return (
    <DockContext.Provider value={api}>
      <DockHeightContext.Provider value={height}>
        {children}
        {createPortal(
          <div
            ref={stackRef}
            data-dock=""
            className="pointer-events-none fixed inset-x-0 z-[55] mx-auto flex max-w-lg flex-col items-center px-5"
            style={{
              gap: GAP_PX,
              bottom: base !== null ? `${base + GAP_PX}px` : `calc(env(safe-area-inset-bottom) + 1rem)`,
            }}
          />,
          document.body,
        )}
      </DockHeightContext.Provider>
    </DockContext.Provider>
  );
}

/**
 * Renders `children` into the dock. Children should set `pointer-events-auto` on whatever is
 * interactive (the stack itself lets taps through to the page).
 */
export function DockItem({
  id,
  priority = 0,
  overSheets = false,
  children,
}: {
  id: string;
  /** Higher sits closer to the nav. See DOCK_PRIORITY. */
  priority?: number;
  /** Stay visible while a sheet is open (toasts with Undo). Default: hidden under sheets. */
  overSheets?: boolean;
  children: ReactNode;
}) {
  const dock = useContext(DockContext);
  const [el] = useState(() => {
    const div = document.createElement("div");
    div.style.display = "contents";
    div.dataset.dockItem = id;
    return div;
  });
  const entry = useRef<Entry | null>(null);

  useLayoutEffect(() => {
    if (!dock) return;
    const e: Entry = { id, priority, overSheets, seq: entry.current?.seq ?? seq++, el };
    entry.current = e;
    el.dataset.dockItem = id;
    return dock.register(e);
  }, [dock, id, priority, overSheets, el]);

  if (!dock) {
    if (import.meta.env.DEV) console.warn(`<DockItem id="${id}"> rendered outside <DockProvider>`);
    return null;
  }
  return createPortal(children, el);
}

/** Lets the bottom nav tell the dock where to sit (the dock follows the element's height). */
export function useDockAnchor(ref: RefObject<HTMLElement | null>) {
  const dock = useContext(DockContext);
  useLayoutEffect(() => {
    if (!dock) return;
    dock.setAnchor(ref.current);
    return () => dock.setAnchor(null);
  }, [dock, ref]);
}

/** Current height of the dock stack in px (0 when empty) — reserve it at the end of content if needed. */
export function useDockHeight(): number {
  return useContext(DockHeightContext);
}
