import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DayRing } from "./DayRing";

const ring = (c: HTMLElement) => c.querySelector<HTMLElement>("[data-day-ring]");
const sweeping = (c: HTMLElement) => ring(c) !== null;

describe("DayRing sweep", () => {
  afterEach(() => {
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("plays when the day closes while watching", () => {
    const { container, rerender } = render(<DayRing date="2026-11-02" closed={false} value={0.5} />);
    expect(sweeping(container)).toBe(false);
    rerender(<DayRing date="2026-11-02" closed value={1} />);
    expect(sweeping(container)).toBe(true);
  });

  it("plays once on return when the day closed elsewhere, not again after that", () => {
    const first = render(<DayRing date="2026-11-02" closed={false} value={0.5} />);
    first.unmount(); // off to Train…
    const back = render(<DayRing date="2026-11-02" closed value={1} />);
    expect(sweeping(back.container)).toBe(true);
    back.unmount();
    const again = render(<DayRing date="2026-11-02" closed value={1} />);
    expect(sweeping(again.container)).toBe(false);
  });

  it("doesn't play for a day that was already closed when first seen", () => {
    const { container } = render(<DayRing date="2026-11-01" closed value={1} />);
    expect(sweeping(container)).toBe(false);
  });

  it("plays on switching back to a day that closed while another day was shown", () => {
    const { container, rerender } = render(<DayRing date="2026-11-02" closed={false} value={0.5} />);
    rerender(<DayRing date="2026-11-01" closed value={1} />); // already closed before: no sweep
    expect(sweeping(container)).toBe(false);
    rerender(<DayRing date="2026-11-02" closed value={1} />);
    expect(sweeping(container)).toBe(true);
  });

  it("works without storage (private mode): plays in place, never on return", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const { container, rerender, unmount } = render(<DayRing date="2026-11-02" closed={false} value={0.5} />);
    rerender(<DayRing date="2026-11-02" closed value={1} />);
    expect(sweeping(container)).toBe(true);
    unmount();
    const back = render(<DayRing date="2026-11-02" closed value={1} />);
    expect(sweeping(back.container)).toBe(false);
  });
});
