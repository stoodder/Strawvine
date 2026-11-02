import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { addDays, formatShortDate } from "../../shared/dates";
import { computeStepsSeries } from "../../shared/steps";
import { LineChart, weeklyMeans, type Series } from "./charts";

/** Ten years of daily points: a weigh-in on most days, a smooth trend line on every day. */
function decade(): Series[] {
  const start = "2016-11-02";
  const n = 3650;
  const raw = Array.from({ length: n }, (_, i) => ({ x: addDays(start, i), y: i % 5 === 3 ? null : 200 + Math.sin(i / 40) * 8 }));
  const avg = Array.from({ length: n }, (_, i) => ({ x: addDays(start, i), y: 200 + Math.sin(i / 40) * 7 }));
  return [
    { key: "raw", label: "Scale", kind: "dots", color: "gray", points: raw, format: (v) => v.toFixed(1) },
    { key: "avg", label: "Trend", kind: "line", color: "lime", points: avg, format: (v) => v.toFixed(1) },
  ];
}

describe("LineChart", () => {
  it("draws a decade of days quickly, with the dots as one path", () => {
    const series = decade();
    const t0 = performance.now();
    const { container } = render(<LineChart series={series} title="Bodyweight" refLine={{ y: 190, label: "goal 190" }} />);
    const firstRender = performance.now() - t0;

    // One element per series, however many days: no per-point <circle>s.
    expect(container.querySelectorAll("svg circle")).toHaveLength(0);
    const dots = [...container.querySelectorAll("svg path")].filter((p) => p.getAttribute("stroke") === "gray");
    expect(dots).toHaveLength(1);
    expect(dots[0]!.getAttribute("d")!.match(/M/g)!.length).toBe(series[0]!.points.filter((p) => p.y !== null).length);

    // Scrubbing re-renders with the hover state only: no rescans of the 7,300 points.
    const chart = screen.getByRole("img");
    const t1 = performance.now();
    for (let i = 0; i < 20; i++) fireEvent.keyDown(chart, { key: "ArrowLeft" });
    const scrub = performance.now() - t1;

    // Generous budgets for a slow CI box; the old O(dates × points) table scan alone took seconds here.
    expect(firstRender).toBeLessThan(1500);
    expect(scrub).toBeLessThan(1000);
    expect(screen.queryByText("Latest")).toBeNull(); // the readout follows the scrubbed day
  });

  it("builds the table (14 most recent days with data, newest first) only while it is open", () => {
    const series = decade();
    render(<LineChart series={series} title="Bodyweight" />);
    const toggle = screen.getByRole("button", { name: /Table/ });
    expect(screen.queryByRole("table")).toBeNull();
    act(() => toggle.click());
    const rows = screen.getAllByRole("row").slice(1); // minus the header
    expect(rows).toHaveLength(14);
    const last = series[1]!.points.at(-1)!.x;
    expect(rows[0]!.querySelector("th")!.textContent).toBe(formatShortDate(last)); // newest first
    expect(rows[13]!.querySelector("th")!.textContent).toBe(formatShortDate(addDays(last, -13)));
  });

  it("says when there isn't enough to draw", () => {
    render(
      <LineChart
        series={[{ key: "a", label: "A", kind: "line", color: "x", points: [{ x: "2026-01-01", y: 1 }] }]}
        emptyText="Nothing yet"
      />,
    );
    expect(screen.getByText("Nothing yet")).toBeTruthy();
  });

  it("draws the dots as weekly means past `weeklyOver` days, keeping the line and the readout daily", () => {
    const series = decade();
    series[0] = { ...series[0]!, weeklyOver: 400 };
    const { container } = render(<LineChart series={series} title="Bodyweight" />);
    const path = (stroke: string) => [...container.querySelectorAll("svg path")].find((p) => p.getAttribute("stroke") === stroke)!;
    const dotCount = path("gray").getAttribute("d")!.match(/M/g)!.length;
    // 3,650 days ≈ 522 Monday-start weeks (the first and last partial).
    expect(dotCount).toBeGreaterThanOrEqual(521);
    expect(dotCount).toBeLessThanOrEqual(523);
    // The trend line still has every day.
    const line = [...container.querySelectorAll("svg path")].filter((p) => p.getAttribute("stroke") === "lime").at(-1)!;
    expect(line.getAttribute("d")!.match(/L/g)!.length).toBe(3649);
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("Scale drawn as weekly averages.");
    // Scrubbing reads the day's own value.
    const chart = screen.getByRole("img");
    fireEvent.keyDown(chart, { key: "End" });
    const lastRaw = series[0]!.points.findLast((p) => p.y !== null)!;
    if (lastRaw.x === series[0]!.points.at(-1)!.x) expect(container.textContent).toContain(lastRaw.y!.toFixed(1));
  });

  it("keeps one dot per day for short ranges even with weeklyOver set", () => {
    const series = decade().map((s) => ({ ...s, points: s.points.slice(-90) }));
    series[0] = { ...series[0]!, weeklyOver: 400 };
    const { container } = render(<LineChart series={series} title="Bodyweight" />);
    const dots = [...container.querySelectorAll("svg path")].find((p) => p.getAttribute("stroke") === "gray")!;
    expect(dots.getAttribute("d")!.match(/M/g)!.length).toBe(series[0]!.points.filter((p) => p.y !== null).length);
  });
});

describe("LineChart: steps with their trend and a target", () => {
  const today = "2026-10-21";
  const days = Array.from({ length: 21 }, (_, i) => ({
    date: addDays("2026-10-01", i),
    steps: i === 4 ? null : 8000 + ((i * 1733) % 7000),
  }));
  const s = computeStepsSeries(days, "2026-10-01", today, today);
  const series: Series[] = [
    { key: "steps", label: "Steps", kind: "dots", color: "gray", points: s.map((d) => ({ x: d.date, y: d.steps })) },
    { key: "avg", label: "Trend", kind: "line", color: "lime", points: s.map((d) => ({ x: d.date, y: d.avgSteps })) },
  ];

  it("draws the daily dots, the trend line and a neutral (not gold) target line", () => {
    const { container } = render(
      <LineChart series={series} title="Steps" refLine={{ y: 15000, label: "target 15,000", tone: "target" }} />,
    );
    const paths = [...container.querySelectorAll("svg path")];
    const dots = paths.filter((p) => p.getAttribute("stroke") === "gray");
    expect(dots[0]!.getAttribute("d")!.match(/M/g)).toHaveLength(20); // 21 days, one missed
    const line = paths.filter((p) => p.getAttribute("stroke") === "lime").at(-1)!;
    expect(line.getAttribute("d")!.match(/[ML]/g)).toHaveLength(20); // ends yesterday: today is in progress
    const ref = container.querySelector("svg line[stroke-dasharray]")!;
    expect(ref.getAttribute("stroke")).toBe("var(--color-mute)");
    const label = screen.getByText("target 15,000");
    expect(label.className).toContain("text-mute");
    expect(label.className).not.toContain("text-gold");
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(/^Steps, .*Steps \d+ to \d+\. Trend \d+ to \d+\. target 15,000\./);
  });

  it("keeps the goal line gold by default", () => {
    const { container } = render(<LineChart series={series} title="Steps" refLine={{ y: 12000, label: "goal" }} />);
    expect(container.querySelector("svg line[stroke-dasharray]")!.getAttribute("stroke")).toBe("var(--color-gold)");
  });
});

describe("weeklyMeans", () => {
  it("averages each Monday-start week at the mean index of its points, skipping gaps", () => {
    // 2026-11-02 is a Monday.
    const pts = [
      { x: "2026-11-01", y: 10 }, // Sun: previous week
      { x: "2026-11-02", y: 1 },
      { x: "2026-11-03", y: null },
      { x: "2026-11-04", y: 3 },
      { x: "2026-11-09", y: 5 },
    ];
    const index = (d: string) => pts.findIndex((p) => p.x === d);
    expect(weeklyMeans(pts, index)).toEqual([
      { i: 0, y: 10 },
      { i: 2, y: 2 },
      { i: 4, y: 5 },
    ]);
  });
});
