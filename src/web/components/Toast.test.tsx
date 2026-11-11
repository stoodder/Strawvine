import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DockProvider } from "./Dock";
import { ToastProvider, useToast } from "./Toast";

function Raise() {
  const toast = useToast();
  return (
    <button type="button" onClick={() => toast.show({ message: "Week removed", action: { label: "Undo", onAction: () => {} } })}>
      raise
    </button>
  );
}

const setup = () =>
  render(
    <DockProvider>
      <ToastProvider>
        <Raise />
      </ToastProvider>
    </DockProvider>,
  );

/** What the toast live region holds (the exit animation can keep the toast itself on screen a moment). */
const live = () => screen.getByRole("status").textContent;

describe("Toast", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("dismisses itself after its time", () => {
    setup();
    act(() => screen.getByRole("button", { name: "raise" }).click());
    expect(live()).toBe("Week removed");
    act(() => vi.advanceTimersByTime(7100));
    expect(live()).toBe("");
  });

  it("waits while it has focus or the pointer (WCAG 2.2.1), then resumes", () => {
    setup();
    act(() => screen.getByRole("button", { name: "raise" }).click());
    const undo = screen.getByRole("button", { name: "Undo" });
    act(() => vi.advanceTimersByTime(3000));
    act(() => undo.focus());
    act(() => vi.advanceTimersByTime(30_000));
    expect(live()).toBe("Week removed");
    act(() => undo.blur());
    act(() => vi.advanceTimersByTime(3900));
    expect(live()).toBe("Week removed");
    act(() => vi.advanceTimersByTime(200));
    expect(live()).toBe("");
  });

  it("pauses under the pointer", () => {
    setup();
    act(() => screen.getByRole("button", { name: "raise" }).click());
    const toast = screen.getByText("Week removed", { selector: "[data-toast] span" }).closest("[data-toast]")!;
    fireEvent.pointerOver(toast);
    act(() => vi.advanceTimersByTime(20_000));
    expect(live()).toBe("Week removed");
    fireEvent.pointerOut(toast);
    act(() => vi.advanceTimersByTime(7100));
    expect(live()).toBe("");
  });

  describe("onClose", () => {
    /** Raises toasts with an `onClose` that records the toast's name; `api` reaches show/dismiss. */
    const closed: string[] = [];
    let api: ReturnType<typeof useToast>;
    function Grab() {
      api = useToast();
      return null;
    }
    const raise = (name: string, action = false) =>
      api.show({
        message: name,
        onClose: () => void closed.push(name),
        ...(action ? { action: { label: "Undo", onAction: () => {} } } : {}),
      });
    /** Lets the queued notifications run (they are deferred: never in the middle of a render). */
    const settle = () => act(async () => void (await Promise.resolve()));
    beforeEach(() => {
      closed.length = 0;
      render(
        <DockProvider>
          <ToastProvider>
            <Grab />
          </ToastProvider>
        </DockProvider>,
      );
    });

    it("tells the owner when the toast times out — once", async () => {
      act(() => void raise("a"));
      act(() => vi.advanceTimersByTime(4900));
      await settle();
      expect(closed).toEqual([]);
      act(() => vi.advanceTimersByTime(200));
      await settle();
      expect(closed).toEqual(["a"]);
      act(() => vi.advanceTimersByTime(60_000));
      await settle();
      expect(closed).toEqual(["a"]);
    });

    it("tells it after the action ran, and when the toast is dismissed", async () => {
      act(() => void raise("undoable", true));
      act(() => screen.getByRole("button", { name: "Undo" }).click());
      await settle();
      expect(closed).toEqual(["undoable"]);
      let id = 0;
      act(() => void (id = raise("b")));
      act(() => api.dismiss(id));
      act(() => api.dismiss(id));
      await settle();
      expect(closed).toEqual(["undoable", "b"]);
    });

    it("tells it when newer toasts push it out (two stay)", async () => {
      act(() => void raise("first"));
      act(() => void raise("second"));
      await settle();
      expect(closed).toEqual([]);
      act(() => void raise("third"));
      await settle();
      expect(closed).toEqual(["first"]);
      act(() => vi.advanceTimersByTime(5100));
      await settle();
      expect(closed).toEqual(["first", "second", "third"]);
    });
  });
});
