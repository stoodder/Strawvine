/**
 * The day's rail: one link per section, named with its state in words; the line lit between
 * settled neighbours; one sweep of light on demand, none with reduced motion.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DayRail, litSegments, railNodeName, type RailNode } from "./DayRail";
import { DaySection } from "./DaySection";

let reduce = false;
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => reduce,
}));
afterEach(() => {
  reduce = false;
});

const midDay: RailNode[] = [
  { id: "metcon", name: "Metcon", state: "done" },
  { id: "strength", name: "Strength", state: "active", count: { done: 5, total: 16 }, current: true },
  { id: "rehab", name: "Rehab", state: "todo" },
  { id: "zone2", name: "Zone 2", state: "todo" },
];

describe("DayRail", () => {
  it("names every state in words", () => {
    const cases: Array<[RailNode, string]> = [
      [{ id: "m", name: "Metcon", state: "done" }, "Metcon, done"],
      [{ id: "z", name: "Zone 2", state: "done", status: "35 min" }, "Zone 2, done, 35 min"],
      [{ id: "s", name: "Strength", state: "active", count: { done: 5, total: 16 } }, "Strength, in progress, 5 of 16 sets"],
      [{ id: "r", name: "Rehab", state: "todo" }, "Rehab, to do"],
      [{ id: "r", name: "Rehab", state: "todo", count: { done: 0, total: 11 } }, "Rehab, to do, 0 of 11 sets"],
      [{ id: "r", name: "Rehab", state: "skipped" }, "Rehab, not today"],
      [{ id: "z", name: "Zone 2", state: "missed" }, "Zone 2, not done"],
      [{ id: "m", name: "Metcon", state: "planned" }, "Metcon, planned"],
      [{ id: "s", name: "Strength", state: "planned", status: "14 sets" }, "Strength, planned, 14 sets"],
      [{ id: "z", name: "Zone 2", state: "planned", status: "30 min", spoken: "30 minutes" }, "Zone 2, planned, 30 minutes"],
    ];
    for (const [node, name] of cases) expect(railNodeName(node)).toBe(name);

    // And as rendered: every node a link with that name, in a named nav, in the day's order.
    const nodes = cases.slice(0, 4).map(([n], i) => ({ ...n, id: `n${i}` }));
    render(<DayRail nodes={nodes} label="Today's sections" />);
    const nav = screen.getByRole("navigation", { name: "Today's sections" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("aria-label"))).toEqual(cases.slice(0, 4).map(([, name]) => name));
  });

  it("makes each node a link to its section's anchor, marking the current one", () => {
    render(<DayRail nodes={midDay} />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(4);
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["#metcon", "#strength", "#rehab", "#zone2"]);
    expect(screen.getByRole("link", { name: "Strength, in progress, 5 of 16 sets" }).getAttribute("aria-current")).toBe("step");
    expect(links.filter((a) => a.hasAttribute("aria-current"))).toHaveLength(1);
    expect(screen.getByRole("list").tagName).toBe("OL");
  });

  it("shows the name and a short status under each dot", () => {
    render(
      <DayRail
        nodes={[
          ...midDay.slice(0, 2),
          { id: "z", name: "Zone 2", state: "done", status: "35 min" },
          { id: "r", name: "Rehab", state: "skipped" },
        ]}
      />,
    );
    const texts = screen.getAllByRole("link").map((a) => a.textContent);
    expect(texts).toEqual(["MetconDone", "Strength5/16", "Zone 235 min", "RehabNot today"]);
  });

  it("fills an in-progress ring with its share of sets", () => {
    render(<DayRail nodes={midDay} />);
    const ring = screen.getByRole("link", { name: /in progress/ }).querySelector<HTMLElement>("[data-ring]")!;
    expect(ring.style.getPropertyValue("--progress")).toBe(String(5 / 16));
    expect(ring.className).toContain("progress-ring");
  });

  it("is left out with fewer than two sections", () => {
    const { container, rerender } = render(<DayRail nodes={[]} />);
    expect(container.innerHTML).toBe("");
    rerender(<DayRail nodes={midDay.slice(0, 1)} />);
    expect(container.innerHTML).toBe("");
    rerender(<DayRail nodes={midDay.slice(0, 2)} />);
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });

  it("lights the line between a settled node and one that has begun, in any order", () => {
    expect(litSegments(["done", "active", "todo", "todo"])).toEqual([true, false, false]);
    expect(litSegments(["done", "done", "skipped", "done"])).toEqual([true, true, true]);
    expect(litSegments(["todo", "done"])).toEqual([false]);
    expect(litSegments(["done", "todo", "done", "done"])).toEqual([false, false, true]);
    expect(litSegments(["done", "missed", "missed"])).toEqual([false, false]);
    expect(litSegments(["planned", "planned"])).toEqual([false]);

    const { container } = render(<DayRail nodes={midDay} />);
    const segs = [...container.querySelectorAll<HTMLElement>("[data-segment]")];
    expect(segs.map((s) => s.dataset.segment)).toEqual(["lit", "off", "off"]);
    expect(segs.map((s) => s.style.getPropertyValue("--progress"))).toEqual(["1", "0", "0"]);
  });

  it("sweeps once when asked, and never with reduced motion", () => {
    const { container, rerender } = render(<DayRail nodes={midDay} />);
    expect(container.querySelector("[data-sweep]")).toBeNull();
    rerender(<DayRail nodes={midDay} sweep />);
    expect(container.querySelector("[data-sweep]")!.className).toContain("sweep");

    reduce = true;
    rerender(<DayRail nodes={midDay} sweep />);
    expect(container.querySelector("[data-sweep]")).toBeNull();
    expect(container.querySelector(".sweep, [class*='animate-']")).toBeNull();
  });

  it("jumps to the section and moves focus to its heading, keeping the hash", () => {
    render(
      <>
        <DayRail nodes={midDay} />
        <DaySection id="strength" index={2} title="Strength" state="active" />
      </>,
    );
    const link = screen.getByRole("link", { name: /^Strength/ });
    const notPrevented = fireEvent.click(link);
    expect(notPrevented).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Strength" }));
    expect(location.hash).toBe("#strength");
    // A node whose section isn't on the page is left to the browser.
    expect(fireEvent.click(screen.getByRole("link", { name: /^Rehab/ }))).toBe(true);
  });

  it("keeps every node at least 44px wide and tall (classes), truncating rather than overflowing", () => {
    render(<DayRail nodes={midDay} />);
    for (const a of screen.getAllByRole("link")) {
      expect(a.className).toMatch(/\bmin-h-11\b/);
      expect(a.className).toMatch(/\bmin-w-11\b/);
      for (const span of a.querySelectorAll(":scope > span[aria-hidden]:not(:first-child)")) expect(span.className).toContain("truncate");
    }
  });
});

describe("motion tokens in styles.css", () => {
  const css = readFileSync(path.resolve(__dirname, "../../styles.css"), "utf8");
  const utility = (name: string) => {
    const start = css.indexOf(`@utility ${name} {`);
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = css.indexOf("{", start); i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
    }
    throw new Error(name);
  };

  it("turn every fill transition and the sweep off with reduced motion", () => {
    for (const name of ["progress-fill", "progress-ring"]) {
      const body = utility(name);
      expect(body).toMatch(/transition: --progress var\(--fill-ms\)/);
      expect(body).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*transition: none;/);
    }
    expect(utility("sweep")).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*&::after \{\s*animation: none;\s*display: none;/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*:root \{\s*--fill-ms: 0ms;\s*--sweep-ms: 0ms;/);
  });

  it("register --progress so fills can ease, and declare the tokens", () => {
    expect(css).toMatch(/@property --progress \{\s*syntax: "<number>";\s*inherits: true;\s*initial-value: 0;/);
    for (const token of [
      "--glow-accent:",
      "--glow-accent-line:",
      "--glow-accent-text:",
      "--hatch:",
      "--section-gap: 3.5rem",
      "--sweep-ms: 700ms",
      "--fill-ms: 400ms",
    ])
      expect(css).toContain(token);
    for (const name of ["rail-label", "hatch", "glow-line", "glow-text"]) utility(name);
  });
});
