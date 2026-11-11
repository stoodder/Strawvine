import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { addDays, formatShortDate } from "../../shared/dates";
import { computeEnergySeries, energyBalanceSeries } from "../../shared/energy";
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
    steps: i === 4 ? null : i === 20 ? 1234 : 8000 + ((i * 1733) % 7000),
  }));
  const s = computeStepsSeries(days, "2026-10-01", today, today);
  const fmtN = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  const series: Series[] = [
    {
      key: "steps",
      label: "Steps",
      kind: "dots",
      color: "gray",
      points: s.map((d) => ({ x: d.date, y: d.steps })),
      format: fmtN,
      partialAt: s.find((d) => d.partial)?.date,
    },
    { key: "avg", label: "Trend", kind: "line", color: "lime", points: s.map((d) => ({ x: d.date, y: d.avgSteps })), format: fmtN },
  ];
  const complete = days.filter((d) => d.steps !== null && d.date !== today).map((d) => d.steps!);

  it("draws the daily dots, the trend line and a neutral (not gold) target named in the legend", () => {
    const { container } = render(<LineChart series={series} title="Steps" refLine={{ y: 15000, label: "Target", tone: "target" }} />);
    const paths = [...container.querySelectorAll("svg path")];
    const dots = paths.filter((p) => p.getAttribute("stroke") === "gray");
    expect(dots[0]!.getAttribute("d")!.match(/M/g)).toHaveLength(19); // 21 days, one missed, today apart
    const line = paths.filter((p) => p.getAttribute("stroke") === "lime").at(-1)!;
    expect(line.getAttribute("d")!.match(/[ML]/g)).toHaveLength(20); // ends yesterday: today is in progress
    const ref = container.querySelector("svg line[stroke-dasharray]")!;
    expect(ref.getAttribute("stroke")).toBe("var(--color-mute)");
    // Named in the legend row, not on the line (where it sat on the data).
    const label = screen.getByText("Target");
    expect(label.className).toContain("text-mute");
    expect(label.nextElementSibling!.textContent).toBe("15,000");
    expect(container.querySelector(".text-gold\\/90")).toBeNull();
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(
      /^Steps, .*Steps [\d,]+ to [\d,]+\. .*Trend [\d,]+ to [\d,]+\. Target 15,000\./,
    );
  });

  it("draws today's partial count hollow, off the scale, and reads it as 'so far'", () => {
    const { container } = render(<LineChart series={series} title="Steps" />);
    const partial = container.querySelector("svg circle[data-partial]")!;
    expect(partial.getAttribute("fill")).toBe("var(--color-ink-950)");
    expect(partial.getAttribute("stroke")).toBe("gray");
    // The axis labels are the complete days' high and low, not today's 1,234.
    const axis = [...container.querySelectorAll("span.font-mono")].map((e) => e.textContent);
    expect(axis).toContain(fmtN(Math.min(...complete)));
    expect(axis).toContain(fmtN(Math.max(...complete)));
    expect(axis).not.toContain("1,234");
    // Inside the plot even though it's below the scale.
    expect(Number(partial.getAttribute("cy"))).toBeLessThanOrEqual(180);
    // Legend: today's count, so far.
    const steps = screen.getByText("Steps", { selector: "span" });
    expect(steps.parentElement!.textContent).toBe("Steps1,234so far");
    const label = screen.getByRole("img").getAttribute("aria-label")!;
    expect(label).toContain(`Steps so far on ${formatShortDate(today)}: 1,234.`);
    expect(label).not.toMatch(/to 1,234\./);
    // Table: today's row says so too.
    act(() => screen.getByRole("button", { name: /Table/ }).click());
    const row = screen.getByRole("row", { name: new RegExp(`^${formatShortDate(today)}`) });
    expect(row.textContent).toContain("1,234 so far");
    const yesterday = screen.getByRole("row", { name: new RegExp(`^${formatShortDate(addDays(today, -1))}`) });
    expect(yesterday.textContent).not.toContain("so far");
  });

  it("keeps the partial day out of the weekly means", () => {
    // 500 days ending today, so the dots are weekly means; today's tiny count would drag its week down.
    const long = Array.from({ length: 500 }, (_, i) => ({ date: addDays(today, i - 499), steps: i === 499 ? 10 : 10000 }));
    const ls = computeStepsSeries(long, long[0]!.date, today, today);
    const lseries: Series[] = [
      {
        key: "steps",
        label: "Steps",
        kind: "dots",
        color: "gray",
        weeklyOver: 400,
        points: ls.map((d) => ({ x: d.date, y: d.steps })),
        partialAt: today,
      },
      { key: "avg", label: "Trend", kind: "line", color: "lime", points: ls.map((d) => ({ x: d.date, y: d.avgSteps })) },
    ];
    const { container } = render(<LineChart series={lseries} title="Steps" />);
    const d = [...container.querySelectorAll("svg path")].find((p) => p.getAttribute("stroke") === "gray")!.getAttribute("d")!;
    // Every weekly mean is 10,000: all on one level.
    const ys = new Set([...d.matchAll(/M[\d.]+,([\d.]+)h0/g)].map((m) => m[1]));
    expect(ys.size).toBe(1);
    expect(container.querySelector("svg circle[data-partial]")).not.toBeNull();
  });

  it("keeps the goal line gold, labelled on the line, by default", () => {
    const { container } = render(<LineChart series={series} title="Steps" refLine={{ y: 12000, label: "goal 12000" }} />);
    expect(container.querySelector("svg line[stroke-dasharray]")!.getAttribute("stroke")).toBe("var(--color-gold)");
    expect(screen.getByText("goal 12000").className).toContain("text-gold");
  });
});

describe("LineChart: energy balance ends at the last complete day", () => {
  const today = "2026-10-21";
  const fmtN = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  /** Twenty steady days, then today with a weigh-in and `eaten` kcal so far (null: nothing logged). */
  const chart = (eaten: number | null) => {
    const days = [
      ...Array.from({ length: 20 }, (_, i) => ({ date: addDays("2026-10-01", i), weightLb: 200, calories: 2600 + (i % 2) * 200 })),
      ...(eaten === null ? [] : [{ date: today, weightLb: 200, calories: eaten }]),
    ];
    const balance = energyBalanceSeries(computeEnergySeries(days, "2026-10-01", today), today);
    const series: Series[] = [
      {
        key: "intake",
        label: "Intake",
        kind: "line",
        color: "gray",
        points: balance.map((d) => ({ x: d.date, y: d.intake })),
        format: fmtN,
      },
      { key: "tdee", label: "TDEE", kind: "line", color: "lime", points: balance.map((d) => ({ x: d.date, y: d.tdee })), format: fmtN },
    ];
    const view = render(<LineChart series={series} title="Energy balance" />);
    const out = {
      label: screen.getByRole("img").getAttribute("aria-label"),
      readout: view.container.querySelector("[aria-live=polite]")!.textContent,
      lines: [...view.container.querySelectorAll("svg path")].map((p) => p.getAttribute("d")),
    };
    view.unmount();
    return out;
  };

  it("reads the same before today's first meal, after breakfast and after a full day", () => {
    const before = chart(null);
    // Through Oct 20 (yesterday), not today; the readout is yesterday's averages.
    expect(before.label).toMatch(/^Energy balance, Oct 1 to Oct 20\. Intake 2,600 to 2,7\d\d\. TDEE /);
    expect(before.readout).toMatch(/^Intake2,7\d\dTDEE2,7\d\dLatest$/);
    expect(chart(350)).toEqual(before);
    expect(chart(2700)).toEqual(before);
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
