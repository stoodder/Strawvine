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
 * `--dock-clearance` (html's scroll-padding-bottom, styles.css) in the states an iPhone puts the
 * page in. jsdom has no layout, so the nav and the stack are given boxes, and they are reported
 * the way WebKit may report fixed elements while the keyboard is up and the visual viewport is
 * panned: shifted up by the pan (`offsetTop`), while `innerHeight` stays the whole window.
 * Nothing here may follow that shift: the clearance is made of heights only, and with the
 * keyboard up (which covers the nav and the dock) it is a few px.
 */
describe("Dock clearance (scroll-padding-bottom)", () => {
  const H = 844;
  const NAV = 84;
  const GAP = 8;
  let stackHeight = 0;
  let observers: Array<() => void> = [];
  function fakeViewport(height = H, offsetTop = 0) {
    const vv = Object.assign(new EventTarget(), { height, offsetTop, scale: 1 });
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    return vv;
  }
  /** What iOS does as the keyboard comes, changes (the suggestion bar) or goes: resize and pan. */
  const keyboard = (vv: ReturnType<typeof fakeViewport>, o: Partial<{ height: number; offsetTop: number; scale: number }>) =>
    act(() => {
      Object.assign(vv, o);
      vv.dispatchEvent(new Event("resize"));
      vv.dispatchEvent(new Event("scroll"));
    });
  const clearance = () => document.documentElement.style.getPropertyValue("--dock-clearance");
  const px = () => parseFloat(clearance());

  let restore: Array<() => void> = [];
  beforeEach(() => {
    stackHeight = 0;
    observers = [];
    const innerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");
    Object.defineProperty(window, "innerHeight", { value: H, configurable: true });
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
      () => Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true }),
    ];
  });
  afterEach(() => restore.forEach((r) => r()));

  function Nav() {
    const ref = useRef<HTMLElement>(null);
    useDockAnchor(ref);
    return <nav ref={ref} aria-label="Primary" />;
  }
  function App({ pill = false }: { pill?: boolean }) {
    return (
      <DockProvider>
        <input aria-label="Carbs" />
        <textarea aria-label="Journal" />
        <button type="button">Save</button>
        {pill && (
          <DockItem id="sync">
            <p>Syncing…</p>
          </DockItem>
        )}
        <Nav />
      </DockProvider>
    );
  }
  /** The stack changed size (an item came or went): what its ResizeObserver reports. */
  const stackResized = (h: number) =>
    act(() => {
      stackHeight = h;
      observers.forEach((o) => o());
    });

  it("without a keyboard: the nav, the stack and a gap on each — from their heights", () => {
    fakeViewport();
    render(<App />);
    expect(px()).toBe(NAV + GAP + GAP);
    stackResized(40);
    expect(px()).toBe(NAV + GAP + 40 + GAP);
    // A hardware keyboard (or Tab) into a field: no on-screen keyboard, the same clearance (WCAG 2.4.11).
    act(() => screen.getByRole("textbox", { name: "Carbs" }).focus());
    expect(px()).toBe(NAV + GAP + 40 + GAP);
  });

  it("with the keyboard up and the view panned (as WebKit has it): a few px — never the pan, never what is visible", () => {
    const vv = fakeViewport();
    render(<App />);
    act(() => screen.getByRole("textbox", { name: "Carbs" }).focus());
    // The keyboard: 463 px visible above it, the visual viewport panned 381 px down to the field.
    keyboard(vv, { height: 463, offsetTop: 381 });
    expect(px()).toBeGreaterThan(0);
    expect(px()).toBeLessThanOrEqual(16);
    // The suggestion bar comes, Safari pans again: still the same.
    keyboard(vv, { height: 418, offsetTop: 300 });
    expect(px()).toBeLessThanOrEqual(16);
    // A field taking focus with the keyboard already up (field to field) keeps it.
    act(() => screen.getByRole("textbox", { name: "Journal" }).focus());
    expect(px()).toBeLessThanOrEqual(16);
  });

  it("with the keyboard up, the first save's sync pill arriving in (and leaving) the dock changes nothing", () => {
    const vv = fakeViewport();
    const { rerender } = render(<App />);
    act(() => screen.getByRole("textbox", { name: "Journal" }).focus());
    keyboard(vv, { height: 463, offsetTop: 381 });
    const before = clearance();
    rerender(<App pill />);
    stackResized(32);
    expect(clearance()).toBe(before);
    stackResized(0);
    rerender(<App />);
    expect(clearance()).toBe(before);
  });

  it("focus leaving the fields (the keyboard on its way down) brings the clearance back", () => {
    const vv = fakeViewport();
    render(<App />);
    act(() => screen.getByRole("textbox", { name: "Carbs" }).focus());
    keyboard(vv, { height: 463, offsetTop: 381 });
    act(() => screen.getByRole("button", { name: "Save" }).focus());
    expect(px()).toBe(NAV + GAP + GAP);
    keyboard(vv, { height: H, offsetTop: 0 });
    expect(px()).toBe(NAV + GAP + GAP);
  });

  it("never more than half of what is visible, whatever the dock holds", () => {
    const vv = fakeViewport();
    render(<App />);
    stackResized(500);
    expect(px()).toBeLessThanOrEqual(H / 2);
    // Something shorter visible and no field focused (pinch zoom, a keyboard going down).
    keyboard(vv, { height: 300, offsetTop: 0 });
    expect(px()).toBeLessThanOrEqual(150);
  });
});
