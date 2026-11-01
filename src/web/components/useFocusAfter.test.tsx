import { act, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it } from "vitest";
import { useFocusAfter } from "./useFocusAfter";

/** A trigger that unmounts while its panel is open (like Today's Paste button). */
function Harness() {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const focusAfter = useFocusAfter();
  return open ? (
    <button
      type="button"
      onClick={() => {
        setOpen(false);
        focusAfter(() => trigger.current);
      }}
    >
      Done
    </button>
  ) : (
    <button ref={trigger} type="button" onClick={() => setOpen(true)}>
      Open
    </button>
  );
}

const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

describe("useFocusAfter", () => {
  it("focuses an element that only mounts as a result of the action, on the next frame", async () => {
    render(<Harness />);
    act(() => screen.getByRole("button", { name: "Open" }).click());
    const done = screen.getByRole("button", { name: "Done" });
    done.focus();
    act(() => done.click()); // unmounts the focused button
    await act(frame);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open" }));
  });

  it("does nothing once the component is gone", async () => {
    const { unmount } = render(<Harness />);
    act(() => screen.getByRole("button", { name: "Open" }).click());
    act(() => screen.getByRole("button", { name: "Done" }).click());
    unmount();
    await act(frame);
    expect(document.activeElement?.textContent).not.toBe("Open");
  });
});
