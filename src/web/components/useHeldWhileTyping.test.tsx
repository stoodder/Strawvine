/**
 * What a screen shows around its fields holds still while one of them is typed in, and catches up
 * when no field has focus (`useHeldWhileTyping`): when it holds, what releases it, and that a tap
 * on a button never finds the display changed between its press and its click.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it } from "vitest";
import { useHeldWhileTyping } from "./useHeldWhileTyping";

/** A task later: the hold ends (or not) a task after focus left. */
const nextTask = () => act(() => new Promise<void>((r) => setTimeout(r, 5)));

let setValue: (v: string) => void = () => {};
let setScope: (s: string) => void = () => {};
let setFields: (on: boolean) => void = () => {};

/** `shown` is the held value; the buttons and fields stand for an editor's. */
function Harness({ initial = "one" }: { initial?: string }) {
  const [value, set] = useState(initial);
  const [scope, setS] = useState("monday");
  const [fields, setF] = useState(true);
  setValue = set;
  setScope = setS;
  setFields = setF;
  const shown = useHeldWhileTyping(value, scope);
  return (
    <div>
      <output data-testid="shown">{shown}</output>
      <output data-testid="live">{value}</output>
      {/* A field that saves as it is left, the save reaching the screen in that very event (as a save that updates the store at once does). */}
      <input aria-label="Saves on blur" onBlur={() => flushSync(() => set("saved on blur"))} />
      {fields && (
        <>
          <input aria-label="First" />
          <input aria-label="Second" />
          <textarea aria-label="Notes" />
        </>
      )}
      <button type="button" onClick={() => set("from the button")}>
        Rate
      </button>
      <input type="checkbox" aria-label="Flag" />
      <input type="date" aria-label="Day" />
    </div>
  );
}

const shown = () => screen.getByTestId("shown").textContent;
const change = (v: string) => act(() => setValue(v));

afterEach(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

describe("useHeldWhileTyping", () => {
  it("follows the value while nothing is being typed in", async () => {
    render(<Harness />);
    expect(shown()).toBe("one");
    change("two");
    expect(shown()).toBe("two");
  });

  it("holds from the moment a field takes focus, field to field, and catches up when focus leaves fields", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("textbox", { name: "First" }));
    change("two");
    expect(shown()).toBe("one");
    expect(screen.getByTestId("live").textContent).toBe("two"); // nothing is held back but the display

    // On to the next field (a tap, then Tab — a keyboard or screen-reader user moving through the form): still held.
    await user.click(screen.getByRole("textbox", { name: "Second" }));
    change("three");
    await nextTask();
    expect(shown()).toBe("one");
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Notes" }));
    change("four");
    await nextTask();
    expect(shown()).toBe("one");

    // Tab on, to a button: no field has focus any more — the display catches up with everything since.
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Rate" }));
    await nextTask();
    expect(shown()).toBe("four");
  });

  it("catches up when the keyboard is dismissed (the field blurs to nothing)", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const first = screen.getByRole("textbox", { name: "First" });
    await user.click(first);
    change("two");
    expect(shown()).toBe("one");
    act(() => first.blur());
    await nextTask();
    expect(shown()).toBe("two");
  });

  it("a tap on a button that takes focus from the field finds nothing moved: the display catches up after its click", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const first = screen.getByRole("textbox", { name: "First" });
    const rate = screen.getByRole("button", { name: "Rate" });
    await user.click(first);
    change("two");

    // The press, as a browser plays it: pointer down, focus moves (the field blurs), pointer up, click.
    fireEvent.pointerDown(rate);
    act(() => rate.focus());
    expect(shown()).toBe("one");
    // However long the press lasts, nothing changes under it.
    await nextTask();
    expect(shown()).toBe("one");
    fireEvent.pointerUp(rate);
    expect(shown()).toBe("one");
    fireEvent.click(rate);
    // The click landed (the button's own change is saved)…
    expect(screen.getByTestId("live").textContent).toBe("from the button");
    expect(shown()).toBe("one");
    // …and only then does the display catch up.
    await nextTask();
    expect(shown()).toBe("from the button");
  });

  it("stays held through a tap on a button that leaves focus in the field; a checkbox taking focus ends it", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const first = screen.getByRole("textbox", { name: "First" });
    const rate = screen.getByRole("button", { name: "Rate" });
    await user.click(first);
    // Where a tapped button doesn't take focus and the field keeps it, typing simply goes on.
    fireEvent.pointerDown(rate);
    fireEvent.pointerUp(rate);
    fireEvent.click(rate);
    await nextTask();
    expect(document.activeElement).toBe(first);
    expect(screen.getByTestId("live").textContent).toBe("from the button");
    expect(shown()).toBe("one");
    // A checkbox is not a field: focus on it types nothing, and the display catches up.
    await user.click(screen.getByRole("checkbox", { name: "Flag" }));
    await nextTask();
    expect(shown()).toBe("from the button");
  });

  it("catches up on coming back to the foreground with a field still focused, and holds again at the next keystroke", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const first = screen.getByRole("textbox", { name: "First" });
    await user.click(first);
    change("two");
    expect(shown()).toBe("one");

    // Backgrounded: a sync lands while away.
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    change("synced while away");
    expect(shown()).toBe("one");
    // Back: nothing stale, though the field still has focus.
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(document.activeElement).toBe(first);
    expect(shown()).toBe("synced while away");

    // Typing goes on: held from here.
    await user.keyboard("7");
    change("after the keystroke");
    expect(shown()).toBe("synced while away");
    act(() => first.blur());
    await nextTask();
    expect(shown()).toBe("after the keystroke");
  });

  it("after coming back with a field focused, moving on to the next field holds from the field being left — its save moves nothing", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const saves = screen.getByRole("textbox", { name: "Saves on blur" });
    await user.click(saves);
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    change("caught up on return");
    expect(shown()).toBe("caught up on return"); // released: nobody's finger is on the page
    // On to the next field by Tab, with no key typed since: the field left saves in its blur — and that save waits.
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "First" }));
    expect(screen.getByTestId("live").textContent).toBe("saved on blur");
    expect(shown()).toBe("caught up on return");
    await nextTask();
    expect(shown()).toBe("caught up on return");
    act(() => (document.activeElement as HTMLElement).blur());
    await nextTask();
    expect(shown()).toBe("saved on blur");
  });

  it("…also where the browser doesn't say which field focus is going to: the press on the field starts the hold", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const saves = screen.getByRole("textbox", { name: "Saves on blur" });
    const second = screen.getByRole("textbox", { name: "Second" });
    await user.click(saves);
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    change("caught up on return");
    expect(shown()).toBe("caught up on return");
    // The tap as such a browser plays it: the press on the next field, then the first one blurs to nothing, then focus arrives.
    fireEvent.pointerDown(second);
    fireEvent.pointerUp(second);
    act(() => saves.blur());
    expect(screen.getByTestId("live").textContent).toBe("saved on blur");
    expect(shown()).toBe("caught up on return");
    act(() => second.focus());
    fireEvent.click(second);
    await nextTask();
    expect(shown()).toBe("caught up on return");
  });

  it("is held from the start when the screen appears with a field already focused", async () => {
    const outside = document.createElement("input");
    document.body.append(outside);
    outside.focus();
    try {
      render(<Harness />);
      change("two");
      expect(shown()).toBe("one");
      act(() => outside.blur());
      await nextTask();
      expect(shown()).toBe("two");
    } finally {
      outside.remove();
    }
  });

  it("a date picker is not typing: nothing waits while it has focus", async () => {
    render(<Harness />);
    const day = screen.getByLabelText("Day");
    act(() => day.focus());
    expect(document.activeElement).toBe(day);
    change("two");
    expect(shown()).toBe("two");
    // Nor does leaving a field for it keep anything waiting.
    const user = userEvent.setup();
    await user.click(screen.getByRole("textbox", { name: "First" }));
    change("three");
    expect(shown()).toBe("two");
    act(() => day.focus());
    await nextTask();
    expect(shown()).toBe("three");
  });

  it("a press that ends without a pointerup still ends: cancelled (the browser took it for a scroll), or only its click arrives", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const first = screen.getByRole("textbox", { name: "First" });
    const rate = screen.getByRole("button", { name: "Rate" });

    await user.click(first);
    change("two");
    fireEvent.pointerDown(rate);
    act(() => first.blur());
    await nextTask();
    expect(shown()).toBe("one"); // the press is still under way
    fireEvent.pointerCancel(rate);
    await nextTask();
    expect(shown()).toBe("two");

    await user.click(first);
    change("three");
    fireEvent.pointerDown(rate);
    act(() => first.blur());
    await nextTask();
    expect(shown()).toBe("two");
    fireEvent.click(rate); // no pointerup was seen
    await nextTask();
    expect(shown()).toBe("from the button");
  });

  it("never holds one day's display on another day", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("textbox", { name: "First" }));
    change("monday's, changed");
    expect(shown()).toBe("one");
    // Another day while a field still has focus: that day's own value, at once — and held from there.
    act(() => {
      setScope("tuesday");
      setValue("tuesday's");
    });
    expect(shown()).toBe("tuesday's");
    change("tuesday's, changed");
    expect(shown()).toBe("tuesday's");
  });

  it("is not left holding when the focused field goes away without a blur (its editor closed)", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("textbox", { name: "First" }));
    change("two");
    expect(shown()).toBe("one");
    // The fields unmount with focus in one of them: no focusout is fired for a removed element.
    act(() => setFields(false));
    expect(document.activeElement).toBe(document.body);
    await nextTask();
    expect(shown()).toBe("two");
  });

  it("does not outlive the screen: its listeners go with it", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness />);
    const first = screen.getByRole("textbox", { name: "First" });
    await user.click(first);
    unmount();
    // Events after the screen is gone reach nothing (no state update on an unmounted component, no error).
    fireEvent.pointerUp(document.body);
    fireEvent.focusOut(document.body);
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await nextTask();
    // A new screen starts un-held, with whatever it is given.
    render(<Harness initial="fresh" />);
    expect(shown()).toBe("fresh");
    change("fresh, changed");
    expect(shown()).toBe("fresh, changed");
  });
});
