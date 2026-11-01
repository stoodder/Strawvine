import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { addDays, formatShortDate } from "../../shared/dates";
import { LineChart, type Series } from "./charts";

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
});
