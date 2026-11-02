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
});
