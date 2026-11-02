import { act, render, screen } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
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

  it("keeps looking for a few frames until the target appears", async () => {
    /** The target mounts two frames after the click (like an edit that reaches the screen through the store). */
    function Late() {
      const [clicked, setClicked] = useState(false);
      const [shown, setShown] = useState(false);
      const focusAfter = useFocusAfter();
      useEffect(() => {
        if (!clicked) return;
        const id = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
        return () => cancelAnimationFrame(id);
      }, [clicked]);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setClicked(true);
              focusAfter(() => document.getElementById("late"));
            }}
          >
            Go
          </button>
          {shown && (
            <button id="late" type="button">
              Late
            </button>
          )}
        </>
      );
    }
    render(<Late />);
    act(() => screen.getByRole("button", { name: "Go" }).click());
    for (let i = 0; i < 5; i++) await act(frame);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Late" }));
  });

  it("skips a target inside an inert tree until it is no longer inert", async () => {
    function Inert() {
      const focusAfter = useFocusAfter();
      return (
        <>
          <div id="wrap" inert>
            <button type="button">Behind</button>
          </div>
          <button type="button" onClick={() => focusAfter(() => screen.getByRole("button", { name: "Behind", hidden: true }))}>
            Go
          </button>
        </>
      );
    }
    render(<Inert />);
    const go = screen.getByRole("button", { name: "Go" });
    go.focus();
    act(() => go.click());
    await act(frame);
    await act(frame);
    expect(document.activeElement).toBe(go);
    // The sheet closes: the tree stops being inert and the pending request lands.
    document.getElementById("wrap")!.inert = false;
    await act(frame);
    expect(document.activeElement?.textContent).toBe("Behind");
  });

  it("gives up after the frame budget, leaving focus where it was", async () => {
    function Never() {
      const focusAfter = useFocusAfter();
      return (
        <button type="button" onClick={() => focusAfter(() => document.getElementById("nope"), 3)}>
          Go
        </button>
      );
    }
    render(<Never />);
    const go = screen.getByRole("button", { name: "Go" });
    go.focus();
    act(() => go.click());
    for (let i = 0; i < 4; i++) await act(frame);
    // Mounting it afterwards no longer pulls focus.
    const late = document.createElement("button");
    late.id = "nope";
    document.body.append(late);
    for (let i = 0; i < 3; i++) await act(frame);
    expect(document.activeElement).toBe(go);
    late.remove();
  });

  it("ignores a disconnected element and the latest request wins", async () => {
    function Two() {
      const focusAfter = useFocusAfter();
      const gone = document.createElement("button");
      return (
        <>
          <button
            type="button"
            onClick={() => {
              focusAfter(gone);
              focusAfter(() => document.getElementById("b"));
            }}
          >
            A
          </button>
          <button id="b" type="button">
            B
          </button>
        </>
      );
    }
    render(<Two />);
    act(() => screen.getByRole("button", { name: "A" }).click());
    await act(frame);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "B" }));
  });
});
