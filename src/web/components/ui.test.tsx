import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DotScale, Sheet, Stepper } from "./ui";

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

describe("Sheet and the on-screen keyboard", () => {
  /** A stand-in visualViewport (jsdom has none): `height` tall, panned down by `offsetTop`. */
  function fakeViewport() {
    const vv = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    return vv;
  }

  it("lifts the panel above the keyboard and caps it to the visible room, then lets go", () => {
    const vv = fakeViewport();
    // The overlay is the window: 844 tall at the top.
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 390, 844));
    try {
      const { rerender } = render(
        <Sheet open onClose={() => {}} ariaLabel="A">
          <input aria-label="Name" />
        </Sheet>,
        { container: root() },
      );
      const overlay = screen.getByRole("dialog").parentElement!;
      // No keyboard: nothing set, the panel sits on the bottom.
      expect(overlay.style.getPropertyValue("--sheet-bottom")).toBe("");

      // A keyboard: 508 px visible above it.
      act(() => {
        vv.height = 508;
        vv.dispatchEvent(new Event("resize"));
      });
      expect(overlay.style.getPropertyValue("--sheet-bottom")).toBe("336px");
      expect(overlay.style.getPropertyValue("--sheet-room")).toBe("492px");
      expect(overlay.style.getPropertyValue("--sheet-safe")).toBe("0px");

      // The view panned down by 200 to show a field: the panel follows the visible area.
      act(() => {
        vv.offsetTop = 200;
        vv.dispatchEvent(new Event("scroll"));
      });
      expect(overlay.style.getPropertyValue("--sheet-bottom")).toBe("136px");

      // Pinch zoom is left alone.
      act(() => {
        vv.scale = 2;
        vv.dispatchEvent(new Event("resize"));
      });
      expect(overlay.style.getPropertyValue("--sheet-bottom")).toBe("");

      // Keyboard down.
      act(() => {
        Object.assign(vv, { scale: 1, height: 844, offsetTop: 0 });
        vv.dispatchEvent(new Event("resize"));
      });
      expect(overlay.style.getPropertyValue("--sheet-room")).toBe("");

      // Closed: it stops listening.
      act(() => {
        vv.height = 508;
        vv.dispatchEvent(new Event("resize"));
      });
      expect(overlay.style.getPropertyValue("--sheet-bottom")).toBe("336px");
      rerender(
        <Sheet open={false} onClose={() => {}} ariaLabel="A">
          <input aria-label="Name" />
        </Sheet>,
      );
      const removed = vi.spyOn(overlay.style, "setProperty");
      act(() => {
        vv.height = 400;
        vv.dispatchEvent(new Event("resize"));
      });
      expect(removed).not.toHaveBeenCalled();
    } finally {
      rect.mockRestore();
      Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true });
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
