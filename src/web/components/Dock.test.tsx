import { act, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DockItem, DockProvider, useDockAnchor, useDockTop } from "./Dock";
import { Sheet } from "./ui";

const stack = () => document.querySelector<HTMLElement>("[data-dock]")!;
const order = () => [...stack().querySelectorAll("[data-dock-item]")].map((el) => (el as HTMLElement).dataset.dockItem);

describe("Dock", () => {
  it("stacks items by priority (higher = closer to the nav, i.e. later in the column)", () => {
    render(
      <DockProvider>
        <DockItem id="toast" priority={30}>
          <p>toast</p>
        </DockItem>
        <DockItem id="sync" priority={10}>
          <p>sync</p>
        </DockItem>
        <DockItem id="rest" priority={20}>
          <p>rest</p>
        </DockItem>
      </DockProvider>,
    );
    expect(order()).toEqual(["sync", "rest", "toast"]);
    // Portaled outside #root, into <body>.
    expect(document.getElementById("root")!.contains(stack())).toBe(false);
    expect(stack().textContent).toBe("syncresttoast");
    // A landmark, so its toasts / timer / sync pill can be found outside the app's own regions.
    expect(screen.getByRole("region", { name: "Notifications" })).toBe(stack());
  });

  it("keeps mount order for equal priorities and reorders when items come and go", () => {
    function Harness() {
      const [rest, setRest] = useState(false);
      return (
        <DockProvider>
          <button type="button" onClick={() => setRest((r) => !r)}>
            toggle
          </button>
          <DockItem id="a" priority={10}>
            a
          </DockItem>
          <DockItem id="b" priority={10}>
            b
          </DockItem>
          {rest && (
            <DockItem id="rest" priority={5}>
              rest
            </DockItem>
          )}
        </DockProvider>
      );
    }
    render(<Harness />);
    expect(order()).toEqual(["a", "b"]);
    screen.getByRole("button", { name: "toggle" }).click();
    return Promise.resolve().then(() => {
      expect(order()).toEqual(["rest", "a", "b"]);
    });
  });

  it("items keep their React context (they are portals)", () => {
    function Inner() {
      const [n, setN] = useState(1);
      return (
        <DockItem id="counter">
          <button type="button" onClick={() => setN(n + 1)}>
            count {n}
          </button>
        </DockItem>
      );
    }
    render(
      <DockProvider>
        <Inner />
      </DockProvider>,
    );
    const btn = screen.getByRole("button", { name: "count 1" });
    expect(stack().contains(btn)).toBe(true);
  });

  it("hides items under an open sheet unless they opt in with overSheets", () => {
    const { rerender } = render(
      <DockProvider>
        <DockItem id="rest">rest</DockItem>
        <DockItem id="toast" overSheets>
          toast
        </DockItem>
        <Sheet open={false} onClose={() => {}} ariaLabel="s">
          <button type="button">x</button>
        </Sheet>
      </DockProvider>,
    );
    const item = (id: string) => stack().querySelector<HTMLElement>(`[data-dock-item="${id}"]`)!;
    expect(item("rest").style.display).toBe("contents");
    rerender(
      <DockProvider>
        <DockItem id="rest">rest</DockItem>
        <DockItem id="toast" overSheets>
          toast
        </DockItem>
        <Sheet open onClose={() => {}} ariaLabel="s">
          <button type="button">x</button>
        </Sheet>
      </DockProvider>,
    );
    expect(item("rest").style.display).toBe("none");
    expect(item("toast").style.display).toBe("contents");
  });

  it("useDockTop: the stack's top edge, the viewport height outside a provider or without layout", () => {
    function Probe() {
      return <output>{useDockTop()}</output>;
    }
    const { unmount } = render(<Probe />);
    expect(screen.getByRole("status").textContent).toBe(String(window.innerHeight));
    unmount();

    // jsdom has no layout: an all-zero rect reads as "unmeasured".
    render(
      <DockProvider>
        <Probe />
      </DockProvider>,
    );
    expect(screen.getByRole("status").textContent).toBe(String(window.innerHeight));
  });

  it("useDockTop follows the measured stack (rounded, never below the viewport)", () => {
    const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.dataset.dock !== undefined
        ? ({ top: 640.4, height: 40, bottom: 680.4, left: 0, right: 0, width: 0, x: 0, y: 640.4 } as DOMRect)
        : new DOMRect();
    });
    function Probe() {
      return <output>{useDockTop()}</output>;
    }
    render(
      <DockProvider>
        <Probe />
      </DockProvider>,
    );
    expect(screen.getByRole("status").textContent).toBe(String(Math.min(window.innerHeight, 640)));
    spy.mockRestore();
  });
});

/**
 * `--dock-clearance` (html's scroll-padding-bottom, styles.css) and `useDockTop` in the states an
 * iPhone puts the page in. jsdom has no layout, so the nav and the stack are given boxes, and they
 * are reported as we suppose WebKit reports fixed elements while the keyboard is up and the visual
 * viewport is panned: shifted up by the pan (`offsetTop`), while `innerHeight` stays the whole
 * window. That is a simulation of a hypothesis, not WebKit. Nothing here may follow that shift:
 * the clearance is made of heights and the visual viewport's offsets, never rects.
 */
describe("Dock clearance (scroll-padding-bottom)", () => {
  const H = 844;
  const NAV = 84;
  const GAP = 8;
  /** An iPhone keyboard with its suggestion bar. */
  const KB = 336;
  let stackHeight = 0;
  let observers: Array<() => void> = [];
  function fakeViewport(height = H, offsetTop = 0, scale = 1) {
    const vv = Object.assign(new EventTarget(), { height, offsetTop, scale });
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    return vv;
  }
  /** The layout viewport (`clientHeight`) and `innerHeight`, which iOS shrinks with pinch zoom. */
  function viewports({ layout = H, inner = layout }: { layout?: number; inner?: number }) {
    Object.defineProperty(document.documentElement, "clientHeight", { value: layout, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: inner, configurable: true });
  }
  /** What iOS does as the keyboard comes, changes (the suggestion bar) or goes: resize and pan. */
  const keyboard = (vv: ReturnType<typeof fakeViewport>, o: Partial<{ height: number; offsetTop: number; scale: number }>) =>
    act(() => {
      Object.assign(vv, o);
      vv.dispatchEvent(new Event("resize"));
      vv.dispatchEvent(new Event("scroll"));
    });
  /** The visual viewport panned (a scroll with the keyboard up): `scroll` only, no resize. */
  const pan = (vv: ReturnType<typeof fakeViewport>, offsetTop: number) =>
    act(() => {
      vv.offsetTop = offsetTop;
      vv.dispatchEvent(new Event("scroll"));
    });
  const clearance = () => document.documentElement.style.getPropertyValue("--dock-clearance");
  const px = () => parseFloat(clearance());

  let restore: Array<() => void> = [];
  beforeEach(() => {
    stackHeight = 0;
    observers = [];
    const innerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");
    viewports({});
    const ro = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      cb: () => void;
      constructor(cb: () => void) {
        this.cb = cb;
      }
      observe() {
        observers.push(this.cb);
      }
      unobserve() {}
      disconnect() {
        observers = observers.filter((o) => o !== this.cb);
      }
    } as unknown as typeof ResizeObserver;
    const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const pan = window.visualViewport?.offsetTop ?? 0;
      if (this.tagName === "NAV") return new DOMRect(0, H - NAV - pan, 390, NAV);
      if (this.dataset.dock !== undefined) return new DOMRect(0, H - NAV - GAP - stackHeight - pan, 390, stackHeight);
      return new DOMRect();
    });
    restore = [
      () => spy.mockRestore(),
      () => (globalThis.ResizeObserver = ro),
      () => (innerHeight ? Object.defineProperty(window, "innerHeight", innerHeight) : Reflect.deleteProperty(window, "innerHeight")),
      () => Reflect.deleteProperty(document.documentElement, "clientHeight"),
      () => Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true }),
    ];
  });
  afterEach(() => restore.forEach((r) => r()));

  function Nav() {
    const ref = useRef<HTMLElement>(null);
    useDockAnchor(ref);
    return <nav ref={ref} aria-label="Primary" />;
  }
  function DockTop() {
    return <output aria-label="Dock top">{useDockTop()}</output>;
  }
  function App({ pill = false }: { pill?: boolean }) {
    return (
      <DockProvider>
        <input aria-label="Carbs" />
        <textarea aria-label="Journal" />
        <button type="button">Save</button>
        <DockTop />
        {pill && (
          <DockItem id="sync">
            <p>Syncing…</p>
          </DockItem>
        )}
        <Nav />
      </DockProvider>
    );
  }
  const dockTop = () => Number(screen.getByRole("status", { name: "Dock top" }).textContent);
  /** The stack changed size (an item came or went): what its ResizeObserver reports. */
  const stackResized = (h: number) =>
    act(() => {
      stackHeight = h;
      observers.forEach((o) => o());
    });
  const focus = (name: string) => act(() => screen.getByRole("textbox", { name }).focus());

  it("without a keyboard: the nav, the stack and a gap on each — from their heights", () => {
    fakeViewport();
    render(<App />);
    expect(px()).toBe(NAV + GAP + GAP);
    stackResized(40);
    expect(px()).toBe(NAV + GAP + 40 + GAP);
    // A hardware keyboard (or Tab) into a field: no on-screen keyboard, the same clearance (WCAG 2.4.11).
    focus("Carbs");
    expect(px()).toBe(NAV + GAP + 40 + GAP);
  });

  it("without a keyboard, in full however tall the dock (WCAG 2.4.11: landscape, a full dock, Tab)", () => {
    // A phone on its side: 390 px tall, the dock holding a toast, the rest pill and the sync pill.
    viewports({ layout: 390 });
    fakeViewport(390);
    render(<App />);
    stackResized(150);
    expect(px()).toBe(NAV + GAP + 150 + GAP);
    act(() => screen.getByRole("button", { name: "Save" }).focus());
    expect(px()).toBe(NAV + GAP + 150 + GAP);
    focus("Carbs");
    expect(px()).toBe(NAV + GAP + 150 + GAP);
  });

  it("with the keyboard up over the nav and the dock: a few px — never the pan, never what is visible", () => {
    const vv = fakeViewport();
    render(<App />);
    focus("Carbs");
    // The keyboard: 508 px visible above it, the visual viewport panned 200 px down to the field;
    // it ends at 708, above the nav (760).
    keyboard(vv, { height: H - KB, offsetTop: 200 });
    expect(px()).toBe(16);
    // The suggestion bar comes, Safari pans again: still the same.
    keyboard(vv, { height: 418, offsetTop: 300 });
    expect(px()).toBe(16);
    // A field taking focus with the keyboard already up (field to field) keeps it.
    focus("Journal");
    expect(px()).toBe(16);
  });

  it("with the keyboard up, a sync pill arriving under it (and leaving) changes nothing", () => {
    const vv = fakeViewport();
    const { rerender } = render(<App />);
    focus("Journal");
    keyboard(vv, { height: H - KB, offsetTop: 200 });
    expect(px()).toBe(16);
    rerender(<App pill />);
    stackResized(32);
    expect(px()).toBe(16);
    stackResized(0);
    rerender(<App />);
    expect(px()).toBe(16);
  });

  it("with the keyboard up and the nav sitting on it (scrolled down): the nav, the stack and a gap above the keyboard's edge", () => {
    const vv = fakeViewport();
    render(<App />);
    focus("Carbs");
    keyboard(vv, { height: H - KB, offsetTop: 200 });
    expect(px()).toBe(16);
    // A scroll down with the keyboard up: the visual viewport pans to the layout viewport's bottom,
    // where the nav is — only a `scroll` event.
    pan(vv, KB);
    expect(px()).toBe(16 + NAV + GAP);
    stackResized(40);
    expect(px()).toBe(16 + NAV + GAP + 40);
    // Halfway: what of the dock and the nav is above the keyboard's edge.
    pan(vv, KB - 60);
    expect(px()).toBe(16 + NAV + GAP + 40 - 60);
    // Back up: covered again.
    pan(vv, 200);
    expect(px()).toBe(16);
  });

  it("with the keyboard up, never more than half of what is visible, whatever the dock holds", () => {
    const vv = fakeViewport();
    render(<App />);
    stackResized(300);
    focus("Carbs");
    keyboard(vv, { height: H - KB, offsetTop: KB });
    expect(px()).toBe(Math.floor((H - KB) / 2));
  });

  it("pinch zoom: innerHeight shrinks with the scale, the layout viewport doesn't — the keyboard is read against the layout viewport", () => {
    // Zoomed 1.5×: innerHeight ≈ H / 1.5, clientHeight stays H, the visual viewport is H / 1.5 tall.
    viewports({ layout: H, inner: H / 1.5 });
    const vv = fakeViewport(H / 1.5, 0, 1.5);
    render(<App />);
    focus("Carbs");
    // No keyboard (only zoom): the full clearance, and the dock's top in the layout viewport.
    expect(px()).toBe(NAV + GAP + GAP);
    expect(dockTop()).toBe(H - NAV - GAP);
    // The keyboard comes: (H - KB) screen px visible, (H - KB) / 1.5 CSS px. innerHeight - that × scale
    // is 54 px, as if there were no keyboard; clientHeight - that × scale is the keyboard's 336.
    keyboard(vv, { height: (H - KB) / 1.5, offsetTop: 100 });
    expect(px()).toBe(16);
    stackResized(40);
    expect(px()).toBe(16);
    expect(dockTop()).toBe(H - NAV - GAP - 40);
  });

  it("a browser that shrinks the layout viewport for the keyboard (resizes-content): no keyboard to allow for — the full clearance", () => {
    const vv = fakeViewport();
    render(<App />);
    focus("Carbs");
    act(() => {
      viewports({ layout: H - KB });
      window.dispatchEvent(new Event("resize"));
    });
    keyboard(vv, { height: H - KB, offsetTop: 0 });
    expect(px()).toBe(NAV + GAP + GAP);
    expect(dockTop()).toBe(H - KB - NAV - GAP);
  });

  it("focus leaving the fields (the keyboard on its way down) brings the clearance back", () => {
    const vv = fakeViewport();
    render(<App />);
    focus("Carbs");
    keyboard(vv, { height: H - KB, offsetTop: 200 });
    expect(px()).toBe(16);
    act(() => screen.getByRole("button", { name: "Save" }).focus());
    expect(px()).toBe(NAV + GAP + GAP);
    keyboard(vv, { height: H, offsetTop: 0 });
    expect(px()).toBe(NAV + GAP + GAP);
  });

  it("without a nav: the safe area and 1rem under the stack, and with the keyboard up the same rule in CSS", () => {
    const vv = fakeViewport();
    render(
      <DockProvider>
        <input aria-label="Carbs" />
      </DockProvider>,
    );
    expect(clearance()).toBe("calc(env(safe-area-inset-bottom) + 1rem + 8px)");
    focus("Carbs");
    keyboard(vv, { height: H - KB, offsetTop: 200 });
    // The visible area ends 136 px above the layout viewport's bottom: above the dock unless the safe area and 1rem reach it.
    expect(clearance()).toBe(`min(calc(16px + max(0px, -136px + 1rem + env(safe-area-inset-bottom))), ${Math.floor((H - KB) / 2)}px)`);
  });
});
