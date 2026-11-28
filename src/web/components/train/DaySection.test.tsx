/**
 * A day section's head: mono index, title, a one-line meta that is the section's description,
 * and at the right the state (count, lit check, NOT TODAY / NOT DONE) or the caller's check, with
 * "Not today" while untouched; the hairline; Not today's muted line and Bring back; folding.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaySection } from "./DaySection";

let reduce = false;
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => reduce,
}));
afterEach(() => {
  reduce = false;
});

const region = (name: string) => screen.getByRole("region", { name });

describe("DaySection", () => {
  it("is a jump target: a region named by its h2, which takes focus; the index is decoration", () => {
    render(
      <DaySection id="strength" index={2} title="Strength" state="active" meta="Push · 3,630 lb moved">
        <p>body</p>
      </DaySection>,
    );
    const section = region("Strength");
    expect(section.id).toBe("strength");
    expect(section.className).toContain("scroll-mt-");
    expect(section.className).toContain("mt-(--section-gap)");
    const h2 = within(section).getByRole("heading", { level: 2, name: "Strength" });
    expect(h2.tabIndex).toBe(-1);
    expect(h2.hasAttribute("data-section-heading")).toBe(true);
    const index = section.querySelector<HTMLElement>("[data-index]")!;
    expect(index.textContent).toBe("02");
    expect(index.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("body")).toBeTruthy();
  });

  it("keeps the meta on one line and makes it the section's description", () => {
    render(<DaySection id="rehab" index={3} title="Rehab" state="todo" meta="Knee rehab · Week 2 of 6" />);
    const section = region("Rehab");
    const meta = document.getElementById(section.getAttribute("aria-describedby")!)!;
    expect(meta.textContent).toBe("Knee rehab · Week 2 of 6");
    expect(meta.className).toContain("truncate");
  });

  it("lights the current section's index", () => {
    const { rerender } = render(<DaySection id="s" index={1} title="Strength" state="active" />);
    const index = () => region("Strength").querySelector<HTMLElement>("[data-index]")!.className;
    expect(index()).toContain("text-mute");
    expect(index()).not.toContain("text-accent");
    rerender(<DaySection id="s" index={1} title="Strength" state="active" current />);
    expect(index()).toContain("text-accent");
    expect(index()).toContain("glow-text");
  });

  it("shows an in-progress count as 5/16 and says it in words", () => {
    render(<DaySection id="s" index={2} title="Strength" state="active" count={{ done: 5, total: 16 }} />);
    const section = region("Strength");
    expect(within(section).getByText("5/16").getAttribute("aria-hidden")).toBe("true");
    expect(within(section).getByText("5 of 16 sets").className).toContain("sr-only");
  });

  it("shows a lit check once done, unless the caller places its own", () => {
    const { rerender } = render(<DaySection id="s" index={2} title="Strength" state="done" count={{ done: 16, total: 16 }} />);
    expect(within(region("Strength")).getByText("Done").className).toContain("sr-only");
    expect(within(region("Strength")).queryByText("16/16")).toBeNull();

    rerender(<DaySection id="m" index={1} title="Metcon" state="done" check={<button aria-pressed="true">Metcon done</button>} />);
    const metcon = region("Metcon");
    expect(within(metcon).getByRole("button", { name: "Metcon done" })).toBeTruthy();
    expect(within(metcon).queryByText("Done")).toBeNull();
  });

  it("offers Not today while untouched, in place of the count, before the check", () => {
    const onSkip = vi.fn();
    render(
      <DaySection
        id="m"
        index={1}
        title="Metcon"
        state="todo"
        count={{ done: 0, total: 3 }}
        action={<button>Remove</button>}
        onSkip={onSkip}
        check={<button aria-pressed="false">Metcon done</button>}
      />,
    );
    const buttons = within(region("Metcon")).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Remove", "Not today", "Metcon done"]);
    expect(within(region("Metcon")).queryByText("0/3")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Not today: Metcon" }));
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it("reads NOT TODAY with one muted line and Bring back, in place of its body", () => {
    const onBringBack = vi.fn();
    render(
      <DaySection
        id="core"
        index={3}
        title="Core"
        state="skipped"
        skippedLine="Hanging knee raise · Weighted plank"
        onBringBack={onBringBack}
      >
        <p>body</p>
      </DaySection>,
    );
    const section = region("Core");
    expect(within(section).getByText("Not today")).toBeTruthy();
    expect(within(section).getByText("Hanging knee raise · Weighted plank").className).toContain("truncate");
    expect(screen.queryByText("body")).toBeNull();
    fireEvent.click(within(section).getByRole("button", { name: "Bring back Core" }));
    expect(onBringBack).toHaveBeenCalledOnce();
  });

  it("reads NOT DONE on a past day, and a preview shows no state at all", () => {
    const { rerender } = render(<DaySection id="z" index={4} title="Zone 2" state="missed" meta="30 min planned" />);
    expect(within(region("Zone 2")).getByText("Not done")).toBeTruthy();
    rerender(<DaySection id="z" index={4} title="Zone 2" state="planned" meta="30 min · Row (last used)" />);
    expect(within(region("Zone 2")).queryByRole("button")).toBeNull();
    expect(region("Zone 2").textContent).toBe("04Zone 230 min · Row (last used)");
  });

  it("folds to its head", () => {
    render(
      <DaySection id="m" index={1} title="Metcon" state="done" meta="Fran · 4:12" folded>
        <p>editor</p>
      </DaySection>,
    );
    expect(screen.queryByText("editor")).toBeNull();
    expect(screen.getByText("Fran · 4:12")).toBeTruthy();
  });

  it("draws the progress hairline only when given, filled to its share", () => {
    const { container, rerender } = render(<DaySection id="s" index={2} title="Strength" state="active" />);
    expect(container.querySelector("[data-hairline]")).toBeNull();
    rerender(<DaySection id="s" index={2} title="Strength" state="active" progress={0.3125} />);
    const fill = container.querySelector("[data-hairline] > span")!;
    expect((fill as HTMLElement).style.getPropertyValue("--progress")).toBe("0.3125");
    expect(fill.className).toContain("progress-fill");
    rerender(<DaySection id="s" index={2} title="Strength" state="active" progress={1.4} />);
    expect((container.querySelector("[data-hairline] > span") as HTMLElement).style.getPropertyValue("--progress")).toBe("1");
  });

  it("sweeps its hairline once when asked, and never with reduced motion", () => {
    const { container, rerender } = render(<DaySection id="s" index={2} title="Strength" state="done" progress={1} sweep />);
    expect(container.querySelector("[data-sweep]")!.className).toContain("sweep");
    reduce = true;
    rerender(<DaySection id="s" index={2} title="Strength" state="done" progress={1} sweep />);
    expect(container.querySelector("[data-sweep], .sweep, [class*='animate-']")).toBeNull();
  });
});
