/**
 * Finish in the dock: when it is offered (`dockFinishShown`), where it sits among the dock's other
 * items (nearest the nav, under a toast and the rest pill) and that it gives way on a very short
 * screen. The Train screen's own test drives it with real sessions.
 */
import { render, screen, within } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../../shared/schemas";
import { DOCK_PRIORITY, DockItem, DockProvider } from "../Dock";
import { ToastProvider, useToast } from "../Toast";
import { DOCK_FINISH_PRIORITY, DOCK_FINISH_SHORT_SCREEN, dockFinishShown, FinishPanel } from "./FinishPanel";

const session: Session = {
  date: "2026-11-16",
  label: "Push",
  cycle: 1,
  week: 3,
  deload: false,
  primaryMaxLb: 225,
  notes: "",
  completedAt: null,
  blocks: [],
};

describe("dockFinishShown", () => {
  const all = { dock: true, doneSets: 7, totalSets: 7, confirming: false, inlineOnScreen: false as boolean | null };

  it("every set logged, the page's button off screen: shown", () => {
    expect(dockFinishShown(all)).toBe(true);
  });

  it("not while a set is still open — however many are logged", () => {
    expect(dockFinishShown({ ...all, doneSets: 6 })).toBe(false);
    expect(dockFinishShown({ ...all, doneSets: 1 })).toBe(false);
  });

  it("not with nothing logged, even when nothing counts (a skipped main lift, an empty session)", () => {
    expect(dockFinishShown({ ...all, doneSets: 0, totalSets: 0 })).toBe(false);
    expect(dockFinishShown({ ...all, doneSets: 0 })).toBe(false);
  });

  it("not while the page's button is on screen, nor before that is known", () => {
    expect(dockFinishShown({ ...all, inlineOnScreen: true })).toBe(false);
    expect(dockFinishShown({ ...all, inlineOnScreen: null })).toBe(false);
  });

  it("not while the unlogged-sets question is up, and not unless the screen asks for it", () => {
    expect(dockFinishShown({ ...all, confirming: true })).toBe(false);
    expect(dockFinishShown({ ...all, dock: false })).toBe(false);
  });
});

describe("Finish in the dock", () => {
  const stack = () => document.querySelector<HTMLElement>("[data-dock]")!;
  const order = () => [...stack().querySelectorAll<HTMLElement>("[data-dock-item]")].map((el) => el.dataset.dockItem);
  const finish = () => within(stack()).queryByRole("button", { name: /^Finish · / });

  /** Shows a toast on mount, through the real toast layer. */
  function Toaster() {
    const toast = useToast();
    useEffect(() => {
      toast.show({ message: "Pull-up · set 2 deleted", action: { label: "Undo", onAction: () => {} } });
    }, [toast]);
    return null;
  }
  const panel = (o: Partial<Parameters<typeof FinishPanel>[0]> = {}) => (
    <FinishPanel
      session={session}
      dock
      doneSets={7}
      totalSets={7}
      volume={1000}
      exName={() => "Bench press"}
      onFinish={() => {}}
      onReopen={() => {}}
      {...o}
    />
  );

  afterEach(() => vi.unstubAllGlobals());

  it("sits nearest the nav: under a toast, which is under the rest pill — whatever order they mount in", () => {
    render(
      <DockProvider>
        <ToastProvider>
          {panel()}
          <DockItem id="rest-timer" priority={DOCK_PRIORITY.rest}>
            <p>rest</p>
          </DockItem>
          <Toaster />
        </ToastProvider>
      </DockProvider>,
      { container: document.getElementById("root")! },
    );
    expect(screen.getByText("Pull-up · set 2 deleted", { selector: ":not([role=status]) > span" })).toBeTruthy();
    expect(finish()).not.toBeNull();
    expect(order()).toEqual(["rest-timer", "toasts", "finish"]);
    expect(DOCK_FINISH_PRIORITY).toBeGreaterThan(DOCK_PRIORITY.toast);
    expect(DOCK_PRIORITY.toast).toBeGreaterThan(DOCK_PRIORITY.rest);
  });

  it("leaves the dock on a very short screen (under 30rem tall), by a media query on the pill", () => {
    render(<DockProvider>{panel()}</DockProvider>, { container: document.getElementById("root")! });
    expect(DOCK_FINISH_SHORT_SCREEN).toBe("[@media(max-height:30rem)]:hidden");
    expect(finish()!.className.split(" ")).toContain(DOCK_FINISH_SHORT_SCREEN);
    // The page's own button has no such rule: Finish is still at the end of the page.
    expect(screen.getByRole("button", { name: "Finish session" }).className).not.toContain("max-height");
  });

  it("is the accent pill with the count, and one press finishes", async () => {
    const onFinish = vi.fn();
    render(<DockProvider>{panel({ onFinish })}</DockProvider>, { container: document.getElementById("root")! });
    expect(finish()!.textContent).toBe("Finish·7/7 sets");
    expect(finish()!.className).toContain("bg-accent");
    expect(finish()!.className).toContain("min-h-11");
    finish()!.click();
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/unlogged\?/)).toBeNull();
  });

  it("isn't rendered while sets are open, with a main lift skipped and nothing logged, or without `dock`", () => {
    for (const props of [
      { doneSets: 6 },
      { doneSets: 0, totalSets: 0, allowEmpty: true },
      { doneSets: 0, allowEmpty: true },
      { dock: false },
    ]) {
      const { unmount } = render(<DockProvider>{panel(props)}</DockProvider>);
      expect(finish(), JSON.stringify(props)).toBeNull();
      unmount();
    }
  });

  it("asks IntersectionObserver about the page's button, above the nav — and waits for its answer", () => {
    const seen: Array<{ el: Element; rootMargin?: string }> = [];
    let answer: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(
          cb: (entries: Array<{ isIntersecting: boolean }>) => void,
          private init?: { rootMargin?: string },
        ) {
          answer = cb;
        }
        observe(el: Element) {
          seen.push({ el, rootMargin: this.init?.rootMargin });
        }
        disconnect() {}
      },
    );
    render(<DockProvider>{panel()}</DockProvider>, { container: document.getElementById("root")! });
    expect(seen.map((s) => s.el)).toEqual([screen.getByRole("button", { name: "Finish session" })]);
    // Only the bottom edge is pulled in (by what the nav covers; nothing in jsdom).
    expect(seen[0]!.rootMargin).toMatch(/^0px 0px -\d+px 0px$/);
    // Not known yet: no pill (it would flash over a button that is on screen).
    expect(finish()).toBeNull();
    expect(answer).not.toBeNull();
  });
});
