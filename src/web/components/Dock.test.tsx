import { render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DockItem, DockProvider, useDockTop } from "./Dock";
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
