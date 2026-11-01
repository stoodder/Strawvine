import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
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
