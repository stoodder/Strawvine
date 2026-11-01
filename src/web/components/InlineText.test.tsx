import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { InlineText } from "./InlineText";

describe("InlineText", () => {
  it("commits the trimmed text on Enter", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<InlineText ariaLabel="Week 1 name" value="Week 1" onCommit={onCommit} />);
    const input = screen.getByRole("textbox", { name: "Week 1 name" });
    await user.clear(input);
    await user.type(input, "  Heavy  {Enter}");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("Heavy");
    expect((input as HTMLInputElement).value).toBe("Heavy");
    expect(document.activeElement).not.toBe(input);
  });

  it("commits on blur, and not at all when unchanged", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <>
        <InlineText ariaLabel="Name" value="Bench" onCommit={onCommit} />
        <button type="button">elsewhere</button>
      </>,
    );
    const input = screen.getByRole("textbox", { name: "Name" });
    await user.click(input);
    await user.click(screen.getByRole("button", { name: "elsewhere" }));
    expect(onCommit).not.toHaveBeenCalled();
    await user.type(input, " press");
    await user.click(screen.getByRole("button", { name: "elsewhere" }));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("Bench press");
  });

  it("Escape reverts without committing", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<InlineText ariaLabel="Name" value="Bench" onCommit={onCommit} />);
    const input = screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "Squat{Escape}");
    expect(input.value).toBe("Bench");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("required: an empty value shows the message and isn't saved", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <InlineText ariaLabel="Program name" value="Strength" required requiredMessage="Give the program a name." onCommit={onCommit} />,
    );
    const input = screen.getByRole("textbox", { name: "Program name" });
    await user.clear(input);
    await user.keyboard("{Enter}");
    expect(screen.getByRole("alert").textContent).toBe("Give the program a name.");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(input); // stays open to fix
    expect(onCommit).not.toHaveBeenCalled();
    await user.type(input, "Base{Enter}");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("Base");
  });

  it("caps the length at maxLength", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<InlineText ariaLabel="Name" value="" maxLength={5} onCommit={onCommit} />);
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Deadlift{Enter}");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("Deadl");
  });

  it("follows outside changes while not editing", () => {
    const { rerender } = render(<InlineText ariaLabel="Name" value="A" onCommit={() => {}} />);
    rerender(<InlineText ariaLabel="Name" value="B" onCommit={() => {}} />);
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("B");
  });
});
