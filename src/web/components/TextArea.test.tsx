/**
 * JournalText grows with its text without the page ever being shorter than it is (jsdom has no
 * layout: the element's sizes are stubbed, and what is checked is the order things happen in).
 * The scroll itself is measured in e2e/40.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fitToContent, JournalText } from "./TextArea";

/** Give `el` a layout: its content is `content()` px tall, its wrapper as tall as the element's inline height says. */
function stubLayout(el: HTMLTextAreaElement, content: () => number, rowsPx = 60) {
  const box = el.parentElement!;
  const seen: Array<{ height: string; boxMinHeight: string }> = [];
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => {
      // What the page looks like at the moment the content is measured.
      seen.push({ height: el.style.height, boxMinHeight: box.style.minHeight });
      return Math.max(rowsPx, content());
    },
  });
  Object.defineProperty(box, "offsetHeight", {
    configurable: true,
    get: () => (el.style.height === "auto" || el.style.height === "" ? rowsPx : parseFloat(el.style.height)),
  });
  return seen;
}

afterEach(() => vi.useRealTimers());

describe("fitToContent", () => {
  it("measures the element at its natural height while the wrapper keeps the height it had", () => {
    render(<JournalText ariaLabel="Notes" value={null} onSave={() => {}} minRows={2} />);
    const el = screen.getByRole("textbox", { name: "Notes" }) as HTMLTextAreaElement;
    const box = el.parentElement!;
    el.style.height = "320px"; // twelve lines so far
    const seen = stubLayout(el, () => 346); // a thirteenth

    fitToContent(el);

    // Measured collapsed (the only way to read the content's height)…
    expect(seen).toEqual([{ height: "auto", boxMinHeight: "320px" }]); // …inside a wrapper still 320px tall: the page never shrank.
    expect(el.style.height).toBe("346px");
    // The hold is gone afterwards: the wrapper follows the element again.
    expect(box.style.minHeight).toBe("");
  });

  it("shrinks with the text, and puts back a min-height the wrapper had of its own", () => {
    render(<JournalText ariaLabel="Notes" value={null} onSave={() => {}} minRows={2} />);
    const el = screen.getByRole("textbox", { name: "Notes" }) as HTMLTextAreaElement;
    const box = el.parentElement!;
    box.style.minHeight = "10px";
    el.style.height = "320px";
    const seen = stubLayout(el, () => 86);
    fitToContent(el);
    expect(seen).toEqual([{ height: "auto", boxMinHeight: "320px" }]);
    expect(el.style.height).toBe("86px");
    expect(box.style.minHeight).toBe("10px");
  });
});

describe("JournalText", () => {
  it("fits its height on every keystroke, within the keystroke (before the browser follows the caret)", () => {
    render(<JournalText ariaLabel="Notes" value={null} onSave={() => {}} minRows={2} />);
    const el = screen.getByRole("textbox", { name: "Notes" }) as HTMLTextAreaElement;
    let lines = 2;
    const seen = stubLayout(el, () => lines * 26 + 8);
    el.style.height = "60px"; // at rest: its two rows (jsdom measured nothing at mount)
    for (lines = 3; lines <= 6; lines++) {
      seen.length = 0;
      fireEvent.change(el, { target: { value: Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n") } });
      // By the time the event has been handled the height is right, and the page was never shorter on the way.
      expect(el.style.height).toBe(`${lines * 26 + 8}px`);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.height).toBe("auto");
      expect(parseFloat(seen[0]!.boxMinHeight)).toBe(lines === 3 ? 60 : (lines - 1) * 26 + 8);
    }
  });

  it("keeps the text, the caret and the focus when the saved value changes under it (a sync landing mid-typing)", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const { rerender } = render(<JournalText ariaLabel="Notes" value="Felt strong" onSave={onSave} />);
    const el = screen.getByRole("textbox", { name: "Notes" }) as HTMLTextAreaElement;
    await user.click(el);
    await user.type(el, " today", { initialSelectionStart: 11, initialSelectionEnd: 11 });
    el.setSelectionRange(4, 4);

    // Another device's text arrives while this one is being typed.
    rerender(<JournalText ariaLabel="Notes" value="Written elsewhere" onSave={onSave} />);
    expect(el.value).toBe("Felt strong today");
    expect(document.activeElement).toBe(el);
    expect(el.selectionStart).toBe(4);

    // Leaving the field saves what was typed; not focused, it follows what is saved.
    await user.tab();
    expect(onSave).toHaveBeenLastCalledWith("Felt strong today");
    rerender(<JournalText ariaLabel="Notes" value="Saved elsewhere" onSave={onSave} />);
    expect(el.value).toBe("Saved elsewhere");
  });
});
