import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChoiceChip, DotScale, NumberInput, Sheet, Stepper } from "./ui";

const root = () => document.getElementById("root")!;

function SheetHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Edit set">
        <input aria-label="Reps" />
        <button type="button">Save</button>
      </Sheet>
    </>
  );
}

describe("Sheet", () => {
  it("moves focus in, traps Tab, makes #root inert and restores focus on close", async () => {
    const user = userEvent.setup();
    render(<SheetHarness />, { container: root() });
    const trigger = screen.getByRole("button", { name: "Open" });
    trigger.focus();
    await user.keyboard("{Enter}");

    const dialog = await screen.findByRole("dialog", { name: "Edit set" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(root().inert).toBe(true);

    // Close (×) is the first control, Save the last: Tab wraps around inside the sheet.
    const close = screen.getByRole("button", { name: "Close" });
    const save = screen.getByRole("button", { name: "Save" });
    save.focus();
    fireEvent.keyDown(save, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(save);

    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(root().inert).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps #root inert until the last of two sheets closes", () => {
    const { rerender } = render(
      <>
        <Sheet open onClose={() => {}} ariaLabel="A">
          <button type="button">a</button>
        </Sheet>
        <Sheet open onClose={() => {}} ariaLabel="B">
          <button type="button">b</button>
        </Sheet>
      </>,
      { container: root() },
    );
    expect(root().inert).toBe(true);
    rerender(
      <>
        <Sheet open={false} onClose={() => {}} ariaLabel="A">
          <button type="button">a</button>
        </Sheet>
        <Sheet open onClose={() => {}} ariaLabel="B">
          <button type="button">b</button>
        </Sheet>
      </>,
    );
    expect(root().inert).toBe(true);
    rerender(
      <>
        <Sheet open={false} onClose={() => {}} ariaLabel="A">
          <button type="button">a</button>
        </Sheet>
        <Sheet open={false} onClose={() => {}} ariaLabel="B">
          <button type="button">b</button>
        </Sheet>
      </>,
    );
    expect(root().inert).toBe(false);
  });

  it("pins the page at its scroll position while open and restores body's own styles after", () => {
    const body = document.body;
    body.style.overflow = "auto"; // a value of its own, to be put back
    Object.defineProperty(window, "scrollY", { value: 640, configurable: true });
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const sheets = (a: boolean, b: boolean) => (
      <>
        <Sheet open={a} onClose={() => {}} ariaLabel="A">
          <button type="button">a</button>
        </Sheet>
        <Sheet open={b} onClose={() => {}} ariaLabel="B">
          <button type="button">b</button>
        </Sheet>
      </>
    );
    try {
      const { rerender } = render(sheets(true, false), { container: root() });
      expect(body.style.position).toBe("fixed");
      expect(body.style.top).toBe("-640px");
      expect(body.style.overflow).toBe("hidden");
      expect(document.documentElement.hasAttribute("data-scroll-locked")).toBe(true);
      // A second sheet over the first: still pinned at the same place; closing one keeps it.
      rerender(sheets(true, true));
      rerender(sheets(false, true));
      expect(body.style.top).toBe("-640px");
      // Pinned, the page reads scrollY 0; on unlock it goes back to 640.
      Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
      rerender(sheets(false, false));
      expect(body.style.position).toBe("");
      expect(body.style.top).toBe("");
      expect(body.style.overflow).toBe("auto");
      expect(document.documentElement.hasAttribute("data-scroll-locked")).toBe(false);
      expect(scrollTo).toHaveBeenCalledTimes(1);
      expect(scrollTo).toHaveBeenCalledWith(0, 640);
    } finally {
      scrollTo.mockRestore();
      Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
      body.style.overflow = "";
    }
  });
});

function SearchSheetHarness() {
  const [open, setOpen] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Add
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Add exercise" initialFocus={search}>
        <button type="button">Filter</button>
        <input aria-label="Search" ref={search} />
      </Sheet>
    </>
  );
}

describe("Sheet initialFocus", () => {
  it("focuses its control on open (a tap too), without scrolling, and gives focus back on close", async () => {
    const user = userEvent.setup();
    render(<SearchSheetHarness />, { container: root() });
    const trigger = screen.getByRole("button", { name: "Add" });
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    await user.click(trigger);
    const search = await screen.findByRole("textbox", { name: "Search" });
    // Not the panel (a tap's default) and not the first control (a keyboard's default).
    expect(document.activeElement).toBe(search);
    expect(focus.mock.contexts).toContain(search);
    const call = focus.mock.calls[focus.mock.contexts.indexOf(search)];
    expect(call?.[0]).toEqual({ preventScroll: true });
    focus.mockRestore();
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(document.activeElement).toBe(trigger);
  });
});

describe("Sheet initialFocus, synchronously", () => {
  it("has the field focused by the end of the opening tap, and enters in place (24 px), not from below", () => {
    render(<SearchSheetHarness />, { container: root() });
    const trigger = screen.getByRole("button", { name: "Add" });
    trigger.focus();
    act(() => {
      fireEvent.click(trigger);
    });
    // No await: iOS raises the keyboard only for a focus within the tap.
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Search" }));
    const transform = screen.getByRole("dialog").style.transform;
    expect(transform).toContain("24px");
    expect(transform).not.toContain("100%");
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
  });

  it("a sheet without one slides up from below", () => {
    render(<SheetHarness />, { container: root() });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Open" }));
    });
    expect(screen.getByRole("dialog").style.transform).toContain("100%");
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
  });
});

describe("Sheet: swipe down to close, content scrolls by touch", () => {
  // A slow, steady finger: 50 ms between events (a flick is a separate case).
  let now = 0;
  beforeEach(() => {
    vi.spyOn(performance, "now").mockImplementation(() => (now += 50));
  });
  afterEach(() => vi.restoreAllMocks());

  function open(onClose = vi.fn()) {
    render(
      <Sheet open onClose={onClose} title="Options">
        <p>Long content</p>
        <input type="range" aria-label="Pace" />
      </Sheet>,
      { container: root() },
    );
    const panel = screen.getByRole("dialog");
    return { panel, onClose, grab: panel.querySelector<HTMLElement>("[data-sheet-grab]")! };
  }
  /** A one-finger swipe on `el` from y to y + dy; whether its moves were prevented (taken from the browser). */
  function swipe(el: Element, dy: number, from = 300) {
    fireEvent.touchStart(el, { touches: [{ clientX: 100, clientY: from }] });
    const prevented: boolean[] = [];
    for (let i = 1; i <= 5; i++) prevented.push(!fireEvent.touchMove(el, { touches: [{ clientX: 100, clientY: from + (dy * i) / 5 }] }));
    fireEvent.touchEnd(el, { touches: [] });
    return prevented;
  }

  it("leaves the panel's touch scrolling to the browser (no touch-action on it); only the grab area is touch-action none", () => {
    const { panel, grab } = open();
    expect(panel.style.touchAction).toBe("");
    expect(panel.style.userSelect).toBe("");
    expect(grab.className).toContain("touch-none");
    expect(grab.contains(screen.getByRole("heading", { name: "Options" }))).toBe(true);
  });

  it("content at its top: a swipe down is the sheet's and closes it; a swipe up is a scroll", () => {
    const { panel, onClose } = open();
    const content = screen.getByText("Long content");
    expect(swipe(content, -200).some(Boolean)).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    expect(swipe(content, 200).every(Boolean)).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    // A short, slow one springs back; a short flick closes.
    expect(swipe(content, 40).every(Boolean)).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    vi.spyOn(performance, "now").mockImplementation(() => (now += 8));
    swipe(content, 60);
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(panel).toBeTruthy();
  });

  it("content scrolled down: a swipe down scrolls (not prevented) and never closes", () => {
    const { panel, onClose } = open();
    panel.scrollTop = 120;
    Object.defineProperty(panel, "scrollTop", { configurable: true, value: 120 });
    expect(swipe(screen.getByText("Long content"), 300).some(Boolean)).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a slider and two fingers are left alone", () => {
    const { onClose } = open();
    expect(swipe(screen.getByRole("slider", { name: "Pace" }), 300).some(Boolean)).toBe(false);
    const content = screen.getByText("Long content");
    fireEvent.touchStart(content, {
      touches: [
        { clientX: 100, clientY: 300 },
        { clientX: 200, clientY: 300 },
      ],
    });
    expect(fireEvent.touchMove(content, { touches: [{ clientX: 100, clientY: 600 }] })).toBe(true);
    fireEvent.touchEnd(content, { touches: [] });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("the grab area drags by pointer (mouse too); its Close button stays a press", () => {
    const { grab, onClose } = open();
    fireEvent.pointerDown(grab, { button: 0, pointerId: 1, clientY: 20 });
    for (const clientY of [30, 40, 50, 60]) fireEvent.pointerMove(grab, { pointerId: 1, clientY });
    fireEvent.pointerUp(grab, { pointerId: 1, clientY: 60 });
    expect(onClose).not.toHaveBeenCalled(); // 40 px: springs back
    fireEvent.pointerDown(grab, { button: 0, pointerId: 2, clientY: 20 });
    fireEvent.pointerMove(grab, { pointerId: 2, clientY: 100 });
    fireEvent.pointerMove(grab, { pointerId: 2, clientY: 200 });
    fireEvent.pointerUp(grab, { pointerId: 2, clientY: 200 });
    expect(onClose).toHaveBeenCalledTimes(1);
    const close = screen.getByRole("button", { name: "Close" });
    fireEvent.pointerDown(close, { button: 0, pointerId: 3, clientY: 20 });
    fireEvent.pointerMove(close, { pointerId: 3, clientY: 300 });
    fireEvent.pointerUp(close, { pointerId: 3, clientY: 300 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("Sheet and the on-screen keyboard", () => {
  /** A stand-in visualViewport (jsdom has none): `height` tall, panned down by `offsetTop`. */
  function fakeViewport(height = 844, offsetTop = 0) {
    const vv = Object.assign(new EventTarget(), { height, offsetTop, scale: 1 });
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    return vv;
  }
  const resize = (vv: ReturnType<typeof fakeViewport>, o: Partial<{ height: number; offsetTop: number; scale: number }>) =>
    act(() => {
      Object.assign(vv, o);
      vv.dispatchEvent(new Event("resize"));
    });
  const vars = (overlay: HTMLElement) => ["--sheet-bottom", "--sheet-room", "--sheet-safe"].map((v) => overlay.style.getPropertyValue(v));
  /** The overlay is the window: 844 tall at the top (every element measures so, unless overridden). */
  const windowRect = () => vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 390, 844));
  const cleanup = (rect: { mockRestore: () => void }) => {
    rect.mockRestore();
    Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true });
  };

  it("lifts the panel above the keyboard for a field in the sheet and caps it to the visible room, then lets go", () => {
    const vv = fakeViewport();
    const rect = windowRect();
    try {
      const { rerender } = render(
        <Sheet open onClose={() => {}} ariaLabel="A">
          <input aria-label="Name" />
        </Sheet>,
        { container: root() },
      );
      const overlay = screen.getByRole("dialog").parentElement!;
      act(() => screen.getByRole("textbox", { name: "Name" }).focus());
      // No keyboard: nothing set, the panel sits on the bottom.
      expect(vars(overlay)).toEqual(["", "", ""]);

      // A keyboard: 508 px visible above it.
      resize(vv, { height: 508 });
      expect(vars(overlay)).toEqual(["336px", "492px", "0px"]);

      // The view panned down by 200 to show a field: the panel follows the visible area.
      act(() => {
        vv.offsetTop = 200;
        vv.dispatchEvent(new Event("scroll"));
      });
      expect(overlay.style.getPropertyValue("--sheet-bottom")).toBe("136px");

      // Panned all the way (iOS shows the bottom of the window): nothing to lift, but the room
      // is still the visible height and the home-indicator inset is under the keyboard.
      resize(vv, { offsetTop: 336 });
      expect(vars(overlay)).toEqual(["0px", "492px", "0px"]);

      // Pinch zoom is left alone.
      resize(vv, { scale: 2 });
      expect(overlay.style.getPropertyValue("--sheet-bottom")).toBe("");

      // Keyboard down.
      resize(vv, { scale: 1, height: 844, offsetTop: 0 });
      expect(vars(overlay)).toEqual(["", "", ""]);

      // Closed: it stops listening.
      resize(vv, { height: 508 });
      expect(overlay.style.getPropertyValue("--sheet-bottom")).toBe("336px");
      rerender(
        <Sheet open={false} onClose={() => {}} ariaLabel="A">
          <input aria-label="Name" />
        </Sheet>,
      );
      const removed = vi.spyOn(overlay.style, "setProperty");
      resize(vv, { height: 400 });
      expect(removed).not.toHaveBeenCalled();
    } finally {
      cleanup(rect);
    }
  });

  it("a pan left over after the keyboard went down (the full height visible) sets nothing", () => {
    const vv = fakeViewport();
    const rect = windowRect();
    try {
      render(
        <Sheet open onClose={() => {}} ariaLabel="A">
          <input aria-label="Name" />
        </Sheet>,
        { container: root() },
      );
      const overlay = screen.getByRole("dialog").parentElement!;
      act(() => screen.getByRole("textbox", { name: "Name" }).focus());
      resize(vv, { height: 844, offsetTop: 200 });
      expect(vars(overlay)).toEqual(["", "", ""]);
      resize(vv, { height: 844, offsetTop: 0.5 });
      expect(vars(overlay)).toEqual(["", "", ""]);
    } finally {
      cleanup(rect);
    }
  });

  it("opened while a keyboard is up: lifts at once for its initialFocus field, not at all without a field in focus", () => {
    const vv = fakeViewport(508);
    const rect = windowRect();
    try {
      render(<SearchSheetHarness />, { container: root() });
      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Add" }));
      });
      const overlay = screen.getByRole("dialog").parentElement!;
      expect(vars(overlay)).toEqual(["336px", "492px", "0px"]);
      act(() => {
        fireEvent.keyDown(window, { key: "Escape" });
      });

      // A sheet with no field in focus (another sheet's keyboard still going down) stays on the bottom…
      const { unmount } = render(<SheetHarness />, { container: root() });
      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Open" }));
      });
      const other = screen.getByRole("dialog", { name: "Edit set" }).parentElement!;
      expect(vars(other)).toEqual(["", "", ""]);
      resize(vv, { height: 600 });
      expect(vars(other)).toEqual(["", "", ""]);
      // …until one of its fields takes focus. Focus moving to a button keeps it (a press must not move
      // the panel under the finger); the keyboard going down lets go.
      act(() => screen.getByRole("textbox", { name: "Reps" }).focus());
      expect(vars(other)).toEqual(["244px", "584px", "0px"]);
      act(() => screen.getByRole("button", { name: "Save" }).focus());
      expect(vars(other)).toEqual(["244px", "584px", "0px"]);
      resize(vv, { height: 844 });
      expect(vars(other)).toEqual(["", "", ""]);
      // A keyboard up while no field has focus (a resize, not a focus): nothing.
      resize(vv, { height: 508 });
      expect(vars(other)).toEqual(["", "", ""]);
      unmount();
    } finally {
      cleanup(rect);
    }
  });

  it("keeps a field that was in view inside the panel as it gets shorter, and leaves the person's own scrolling alone", () => {
    const vv = fakeViewport();
    let fieldTop = 700;
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute("aria-label") === "Name") return new DOMRect(0, fieldTop, 390, 50);
      if (this.getAttribute("role") === "dialog") {
        // The panel: from 100 to the window's bottom, or to the keyboard's top once lifted.
        const lifted = this.parentElement!.style.getPropertyValue("--sheet-bottom");
        return lifted ? new DOMRect(0, 16, 390, 508 - 16) : new DOMRect(0, 100, 390, 744);
      }
      return new DOMRect(0, 0, 390, 844);
    });
    try {
      render(
        <Sheet open onClose={() => {}} ariaLabel="A">
          <input aria-label="Name" />
        </Sheet>,
        { container: root() },
      );
      const panel = screen.getByRole("dialog");
      let scrollTop = 0;
      Object.defineProperty(panel, "scrollTop", { configurable: true, get: () => scrollTop, set: (v: number) => (scrollTop = v) });
      act(() => screen.getByRole("textbox", { name: "Name" }).focus());

      // In view (700–750 of 100–844) before the keyboard; under it after: scrolled up into the panel.
      resize(vv, { height: 508 });
      expect(scrollTop).toBe(750 - 508 + 16);

      // The person scrolls; a pan (same height) doesn't pull the field back.
      scrollTop = 0;
      act(() => {
        vv.offsetTop = 10;
        vv.dispatchEvent(new Event("scroll"));
      });
      expect(scrollTop).toBe(0);

      // Keyboard down, the field scrolled out of view (below the panel): the next keyboard leaves it.
      resize(vv, { height: 844, offsetTop: 0 });
      fieldTop = 900;
      resize(vv, { height: 508 });
      expect(scrollTop).toBe(0);
    } finally {
      cleanup(rect);
    }
  });
});

function StepperHarness({ onChange, initial = 100 }: { onChange: (v: number) => void; initial?: number }) {
  const [v, setV] = useState(initial);
  return (
    <Stepper
      editable
      label="Weight"
      value={v}
      step={5}
      min={0}
      max={200}
      onChange={(n) => {
        onChange(n);
        setV(n);
      }}
    />
  );
}

describe("Stepper (editable)", () => {
  it("takes a typed value on Enter", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<StepperHarness onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Weight 100, edit" }));
    const input = screen.getByRole("textbox", { name: "Weight" });
    await user.clear(input);
    await user.type(input, "135{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(135);
    expect(screen.getByRole("button", { name: "Weight 135, edit" })).toBeTruthy();
  });

  it("clamps to min/max", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<StepperHarness onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Weight 100, edit" }));
    const input = screen.getByRole("textbox", { name: "Weight" });
    await user.clear(input);
    await user.type(input, "999{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(200);
  });

  it("Escape cancels the edit", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<StepperHarness onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Weight 100, edit" }));
    const input = screen.getByRole("textbox", { name: "Weight" });
    await user.clear(input);
    await user.type(input, "150{Escape}");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Weight 100, edit" })).toBeTruthy();
  });

  it("buttons step and respect the bounds", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<StepperHarness onChange={onChange} initial={198} />);
    await user.click(screen.getByRole("button", { name: "Increase Weight" }));
    expect(onChange).toHaveBeenLastCalledWith(200);
    await user.click(screen.getByRole("button", { name: "Decrease Weight" }));
    expect(onChange).toHaveBeenLastCalledWith(195);
  });
});

function DotHarness({ onChange, initial = null }: { onChange: (v: number | null) => void; initial?: number | null }) {
  const [v, setV] = useState<number | null>(initial);
  return (
    <DotScale
      label="Energy"
      value={v}
      onChange={(n) => {
        onChange(n);
        setV(n);
      }}
    />
  );
}

describe("DotScale", () => {
  it("moves with arrow keys (roving focus) and clamps at the ends", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DotHarness onChange={onChange} initial={3} />);
    const three = screen.getByRole("radio", { name: "Energy 3 of 5" });
    expect(three.tabIndex).toBe(0);
    three.focus();
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith(4);
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Energy 4 of 5" }));
    await user.keyboard("{End}{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith(5);
    await user.keyboard("{Home}{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith(1);
  });

  it("clears with Escape / Delete, the clear button and by tapping the selected dot", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DotHarness onChange={onChange} initial={2} />);
    screen.getByRole("radio", { name: "Energy 2 of 5" }).focus();
    await user.keyboard("{Escape}");
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(screen.getByText("Energy cleared")).toBeTruthy();

    await user.click(screen.getByRole("radio", { name: "Energy 4 of 5" }));
    expect(onChange).toHaveBeenLastCalledWith(4);
    await user.click(screen.getByRole("radio", { name: "Energy 4 of 5" }));
    expect(onChange).toHaveBeenLastCalledWith(null);

    await user.click(screen.getByRole("radio", { name: "Energy 5 of 5" }));
    await user.click(screen.getByRole("button", { name: "Clear Energy" }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});

describe("NumberInput", () => {
  function Harness(props: Partial<Parameters<typeof NumberInput>[0]> & { initial?: number | null; onSave?: (v: number | null) => void }) {
    const { initial = null, onSave, ...rest } = props;
    const [v, setV] = useState<number | null>(initial);
    return (
      <NumberInput
        ariaLabel="Reading"
        {...rest}
        value={v}
        onCommit={(n) => {
          onSave?.(n);
          setV(n);
        }}
      />
    );
  }

  it("saves what it shows: rounded to `decimals` on commit", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<Harness decimals={1} onSave={onSave} />);
    const input = screen.getByRole("textbox", { name: "Reading" });
    await user.type(input, "51.54{Enter}");
    expect(onSave).toHaveBeenLastCalledWith(51.5);
    expect(input).toHaveProperty("value", "51.5");
    await user.clear(input);
    await user.type(input, "51.56{Enter}");
    expect(onSave).toHaveBeenLastCalledWith(51.6);
    await user.clear(input);
    await user.type(input, "0.125{Enter}");
    expect(onSave).toHaveBeenLastCalledWith(0.1);
  });

  it("clamps out-of-range values by default", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<Harness min={20} max={220} onSave={onSave} />);
    const input = screen.getByRole("textbox", { name: "Reading" });
    await user.type(input, "5{Enter}");
    expect(onSave).toHaveBeenLastCalledWith(20);
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });

  it('with outOfRange="reject", keeps the previous value and says the range until an accepted entry', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<Harness initial={48} min={20} max={220} unit="bpm" outOfRange="reject" onSave={onSave} />);
    const input = screen.getByRole("textbox", { name: "Reading" });
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(input.getAttribute("aria-describedby")).toBeNull();

    await user.clear(input);
    await user.type(input, "5{Enter}");
    expect(onSave).not.toHaveBeenCalled();
    expect(input).toHaveProperty("value", "48");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const hint = document.getElementById(input.getAttribute("aria-describedby")!)!;
    expect(hint.getAttribute("aria-live")).toBe("polite");
    expect(hint.textContent).toBe("Reading not saved: use 20–220 bpm");
    expect(hint.querySelector(".sr-only")!.textContent).toBe("Reading not saved: use ");

    // Above the range too — judged after rounding (220.4 is 220, accepted).
    await user.clear(input);
    await user.type(input, "520{Enter}");
    expect(onSave).not.toHaveBeenCalled();
    await user.clear(input);
    await user.type(input, "220.4{Enter}");
    expect(onSave).toHaveBeenLastCalledWith(220);
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(input.getAttribute("aria-describedby")).toBeNull();
    expect(hint.textContent).toBe("");

    // Clearing is never out of range.
    await user.clear(input);
    await user.type(input, "{Enter}");
    expect(onSave).toHaveBeenLastCalledWith(null);
  });

  it("names the range from `rangeHint` when given", async () => {
    const user = userEvent.setup();
    render(<Harness min={10} max={100} decimals={1} outOfRange="reject" rangeHint="10–100 mL/kg/min" />);
    const input = screen.getByRole("textbox", { name: "Reading" });
    await user.type(input, "9.94{Enter}");
    expect(document.getElementById(input.getAttribute("aria-describedby")!)!.textContent).toContain("10–100 mL/kg/min");
    // 9.96 rounds to 10.0: in range.
    await user.clear(input);
    await user.type(input, "9.96{Enter}");
    expect(input).toHaveProperty("value", "10");
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });
});

describe("NumberInput: a number typed and not yet committed", () => {
  /** `saved`: every onCommit. `follow: false` leaves the saved value where it was (a save that hasn't come back yet). */
  function Harness({
    initial = null,
    saved,
    follow = true,
    show = true,
    ...rest
  }: Partial<Parameters<typeof NumberInput>[0]> & {
    initial?: number | null;
    saved: Array<number | null>;
    follow?: boolean;
    show?: boolean;
  }) {
    const [v, setV] = useState<number | null>(initial);
    return show ? (
      <NumberInput
        ariaLabel="Reading"
        {...rest}
        value={v}
        onCommit={(n) => {
          saved.push(n);
          if (follow) setV(n);
        }}
      />
    ) : null;
  }
  const hide = (state: "hidden" | "visible") => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
  };
  afterEach(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });
  const input = () => screen.getByRole("textbox", { name: "Reading" }) as HTMLInputElement;

  it("is committed when the app is hidden — once, however often that is said, and not again by the blur that follows", async () => {
    const user = userEvent.setup();
    const saved: Array<number | null> = [];
    // The saved value doesn't come back before the blur (the worst case for a duplicate).
    render(<Harness saved={saved} follow={false} min={0} max={200000} />);
    await user.click(input());
    await user.keyboard("9000");
    expect(saved).toEqual([]);
    hide("hidden");
    expect(saved).toEqual([9000]);
    act(() => void window.dispatchEvent(new Event("pagehide")));
    hide("hidden");
    expect(saved).toEqual([9000]);
    // Back in the app, the field is as it was; leaving it saves nothing a second time.
    hide("visible");
    expect(input().value).toBe("9000");
    expect(document.activeElement).toBe(input());
    await user.keyboard("{Enter}");
    expect(saved).toEqual([9000]);
  });

  it("after such a commit, what is typed next is committed as usual — the old value included", async () => {
    const user = userEvent.setup();
    const saved: Array<number | null> = [];
    render(<Harness saved={saved} initial={8000} />);
    await user.click(input());
    await user.keyboard("9000");
    hide("hidden");
    expect(saved).toEqual([9000]);
    hide("visible");
    await user.clear(input());
    await user.keyboard("8000{Enter}");
    expect(saved).toEqual([9000, 8000]);
    // And a second hide with nothing new typed commits nothing.
    await user.click(input());
    hide("hidden");
    expect(saved).toEqual([9000, 8000]);
    hide("visible");
    // The number committed while hidden is an ordinary number again once it was saved: typed later, it is saved.
    await user.keyboard("9000{Enter}");
    expect(saved).toEqual([9000, 8000, 9000]);
  });

  it("is committed when the field goes away while it has focus (no blur is fired for a removed element), through its last onCommit", async () => {
    const user = userEvent.setup();
    const saved: Array<number | null> = [];
    const { rerender, unmount } = render(<Harness saved={saved} decimals={1} />);
    await user.click(input());
    await user.keyboard("199.44");
    rerender(<Harness saved={saved} decimals={1} show={false} />);
    expect(saved).toEqual([199.4]);
    unmount();
    expect(saved).toEqual([199.4]);
  });

  it("is not committed twice when the field is left and then goes away, nor when nothing was typed", async () => {
    const user = userEvent.setup();
    const saved: Array<number | null> = [];
    const { rerender } = render(<Harness saved={saved} initial={50} />);
    await user.click(input());
    hide("hidden"); // focused, select-all, nothing typed
    expect(saved).toEqual([]);
    hide("visible");
    await user.keyboard("60{Enter}");
    expect(saved).toEqual([60]);
    rerender(<Harness saved={saved} initial={50} show={false} />);
    expect(saved).toEqual([60]);
  });

  it("never commits, for the app being hidden or the field going away, what leaving the field wouldn't plainly save", async () => {
    const user = userEvent.setup();
    const cases: Array<[props: Partial<Parameters<typeof NumberInput>[0]> & { initial?: number | null }, typed: string, why: string]> = [
      [{ initial: 48 }, "48", "the value it already has"],
      [{ initial: 48 }, "{Backspace}", "an emptied field: clearing a value takes leaving the field"],
      [{ initial: 48 }, "4x", "something that isn't a number"],
      [{ initial: 48, min: 20, max: 220, outOfRange: "reject" }, "5", "a reading out of range (refused on blur)"],
      [{ initial: 48, min: 20, max: 220, outOfRange: "reject" }, "900", "a reading out of range (refused on blur)"],
      [{ initial: 199, min: 50, max: 1000 }, "1", "a number that leaving the field would clamp: half-typed, as likely as not"],
      [{ initial: 199, min: 50, max: 1000 }, "20000", "a number that leaving the field would clamp"],
    ];
    for (const [props, typed, why] of cases) {
      const saved: Array<number | null> = [];
      const view = render(<Harness saved={saved} {...props} />);
      await user.click(input());
      await user.keyboard(typed);
      hide("hidden");
      act(() => void window.dispatchEvent(new Event("pagehide")));
      hide("visible");
      expect(saved, `hidden: ${why}`).toEqual([]);
      view.rerender(<Harness saved={saved} {...props} show={false} />);
      expect(saved, `removed: ${why}`).toEqual([]);
      view.unmount();
    }
  });

  it("leaves a field that isn't focused alone: hiding the app or removing it commits nothing", async () => {
    const user = userEvent.setup();
    const saved: Array<number | null> = [];
    const { rerender } = render(
      <>
        <Harness saved={saved} initial={48} />
        <button type="button">elsewhere</button>
      </>,
    );
    await user.click(input());
    await user.keyboard("52");
    await user.click(screen.getByRole("button", { name: "elsewhere" }));
    expect(saved).toEqual([52]);
    hide("hidden");
    hide("visible");
    rerender(<button type="button">elsewhere</button>);
    expect(saved).toEqual([52]);
  });

  it("…also while it still shows a number its owner didn't take (a setting refused with a message): not offered again behind the person's back", async () => {
    const user = userEvent.setup();
    const saved: Array<number | null> = [];
    const { rerender } = render(
      <>
        <Harness saved={saved} initial={48} follow={false} />
        <button type="button">elsewhere</button>
      </>,
    );
    await user.click(input());
    await user.keyboard("999");
    await user.click(screen.getByRole("button", { name: "elsewhere" }));
    expect(saved).toEqual([999]);
    expect(input().value).toBe("999");
    hide("hidden");
    act(() => void window.dispatchEvent(new Event("pagehide")));
    hide("visible");
    rerender(<button type="button">elsewhere</button>);
    expect(saved).toEqual([999]);
  });
});

describe("Stepper: a number being typed when its sheet goes away", () => {
  it("is not applied: the sheet's own buttons save, and closing it abandons the draft", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    function SetEditor({ open }: { open: boolean }) {
      return open ? <Stepper value={160} onChange={onChange} step={5} max={2000} editable label="load" /> : null;
    }
    const { rerender } = render(<SetEditor open />);
    await user.click(screen.getByRole("button", { name: "load 160, edit" }));
    await user.keyboard("172.5");
    // Hidden with the draft typed: nothing is applied behind the person's back…
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(onChange).not.toHaveBeenCalled();
    // …and the sheet closed with the keyboard up drops it.
    rerender(<SetEditor open={false} />);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("ChoiceChip", () => {
  it("presses lime with a check, and unpressed without one", () => {
    const { rerender } = render(
      <ChoiceChip on onClick={() => {}}>
        Barbell
      </ChoiceChip>,
    );
    const chip = () => screen.getByRole("button");
    expect(chip().getAttribute("aria-pressed")).toBe("true");
    expect(chip().className).toContain("bg-accent");
    expect(chip().querySelector("svg")).not.toBeNull();

    rerender(
      <ChoiceChip on={false} onClick={() => {}}>
        Barbell
      </ChoiceChip>,
    );
    expect(chip().getAttribute("aria-pressed")).toBe("false");
    expect(chip().className).not.toContain("bg-accent");
    expect(chip().querySelector("svg")).toBeNull();
  });
});
