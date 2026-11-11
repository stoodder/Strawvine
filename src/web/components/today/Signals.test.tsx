/**
 * Signals, on their own: one line per insight with the icon and colour of its tone, the rest
 * behind "+N more" only when there is a rest, and negative numbers with a real minus sign.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Insight } from "../../../shared/insights";
import { Signals, trueMinus } from "./Signals";

const insight = (key: string, tone: Insight["tone"], text = `${key} text`): Insight => ({ key, tone, text });
const rows = () => screen.queryAllByRole("listitem");
const toggle = () => screen.queryByRole("button");

describe("Signals", () => {
  it("exactly one signal: its line, and no '+0 more' toggle", () => {
    render(<Signals insights={[insight("sleep-low", "warn")]} />);
    expect(rows().map((r) => r.textContent)).toEqual(["sleep-low text"]);
    expect(toggle()).toBeNull();
    expect(screen.queryByText(/more/)).toBeNull();
    // Still a named section for screen readers.
    expect(screen.getByRole("heading", { level: 2, name: "Signals" }).className).toContain("sr-only");
  });

  it("two: '+1 more signal' (singular); three: '+2 more signals'", () => {
    const two = render(<Signals insights={[insight("a", "warn"), insight("b", "info")]} />);
    expect(rows()).toHaveLength(1);
    expect(toggle()!.textContent).toBe("+1 more signal");
    expect(within(toggle()!).getByText("signal").className).toContain("sr-only");
    two.unmount();
    render(<Signals insights={[insight("a", "warn"), insight("b", "info"), insight("c", "good")]} />);
    expect(toggle()!.textContent).toBe("+2 more signals");
  });

  it("opens the rest in place, in the order given, and closes again", () => {
    render(<Signals insights={[insight("a", "warn"), insight("b", "info"), insight("c", "good")]} />);
    const button = toggle()!;
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(button.getAttribute("aria-controls")!)).toBe(screen.getByRole("list"));
    fireEvent.click(button);
    expect(rows().map((r) => r.textContent)).toEqual(["a text", "b text", "c text"]);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.textContent).toBe("Show less");
    fireEvent.click(button);
    expect(rows().map((r) => r.textContent)).toEqual(["a text"]);
    expect(button.textContent).toBe("+2 more signals");
  });

  it("each tone has its own icon and colour: a warning is the triangle in the warn colour, never the sparkle", () => {
    render(<Signals insights={[insight("w", "warn"), insight("i", "info"), insight("g", "good")]} />);
    fireEvent.click(toggle()!);
    const want = {
      warn: ["lucide-triangle-alert", "text-warn"],
      info: ["lucide-info", "text-mute"],
      good: ["lucide-sparkles", "text-accent"],
    } as const;
    const all = Object.values(want).flat();
    for (const row of rows()) {
      const tone = row.dataset.tone as keyof typeof want;
      const icons = row.querySelectorAll("svg");
      expect(icons).toHaveLength(1);
      const [icon, colour] = want[tone];
      expect(icons[0]!.classList.contains(icon)).toBe(true);
      expect(icons[0]!.parentElement!.classList.contains(colour)).toBe(true);
      for (const other of all)
        if (other !== icon && other !== colour) {
          expect(icons[0]!.classList.contains(other)).toBe(false);
          expect(icons[0]!.parentElement!.classList.contains(other)).toBe(false);
        }
    }
    expect(rows().map((r) => r.dataset.tone)).toEqual(["warn", "info", "good"]);
  });

  it("shows negative numbers with a real minus sign", () => {
    render(<Signals insights={[insight("on-rate", "good", "Trend moved -0.8 lb this week — right on plan.")]} />);
    expect(rows()[0]!.textContent).toBe("Trend moved −0.8 lb this week — right on plan.");
  });

  it("renders nothing without signals", () => {
    const { container } = render(<Signals insights={[]} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("trueMinus", () => {
  it("turns a hyphen before a number into a minus: at the start, after a space, after a bracket", () => {
    expect(trueMinus("-0.8 lb")).toBe("−0.8 lb");
    expect(trueMinus("Trend moved -1.3 lb")).toBe("Trend moved −1.3 lb");
    expect(trueMinus("change (-2 lb) and -3")).toBe("change (−2 lb) and −3");
  });

  it("leaves hyphens that aren't signs alone", () => {
    expect(trueMinus("your 4-week baseline")).toBe("your 4-week baseline");
    expect(trueMinus("7-day average, 5-3 split")).toBe("7-day average, 5-3 split");
    expect(trueMinus("right on plan - nice")).toBe("right on plan - nice");
    expect(trueMinus("well-rested")).toBe("well-rested");
    expect(trueMinus("already −0.8")).toBe("already −0.8");
  });
});
