import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { emptyDayLog } from "../../../shared/empty";
import type { DayLog } from "../../../shared/schemas";
import { BenchmarkHistorySheet, benchmarkRows } from "./BenchmarkHistory";

const day = (date: string, name: string, score: string): DayLog => ({
  ...emptyDayLog(date),
  metconDone: true,
  metconBenchmark: name,
  metconScore: score,
});

const days = [
  day("2026-09-01", "Fran", "5:10"),
  day("2026-09-15", "fran ", "4:40"), // PR (beats 5:10)
  day("2026-10-01", "Murph", "45:00"),
  day("2026-10-10", "Fran", "4:55"),
  day("2026-10-20", "FRAN", "4:21"), // PR (beats 4:40), current best
  day("2026-11-02", "Fran", "felt slow"), // unparseable
];

describe("benchmarkRows", () => {
  it("lists one benchmark's results newest first, with PRs (and what they beat) and the current best", () => {
    const rows = benchmarkRows(days, "Fran");
    expect(rows.map((r) => r.entry.date)).toEqual(["2026-11-02", "2026-10-20", "2026-10-10", "2026-09-15", "2026-09-01"]);
    expect(rows.map((r) => r.beat)).toEqual([null, "4:40", null, "5:10", null]);
    expect(rows.map((r) => r.best)).toEqual([false, true, false, false, false]);
  });

  it("is empty for a benchmark never logged", () => {
    expect(benchmarkRows(days, "Grace")).toEqual([]);
  });
});

describe("BenchmarkHistorySheet", () => {
  it("shows every result with PR markers, the day being edited marked", () => {
    render(<BenchmarkHistorySheet open onClose={() => {}} name="Fran" days={days} date="2026-11-02" />);
    const dialog = screen.getByRole("dialog", { name: "Fran" });
    const items = within(dialog).getAllByRole("listitem");
    expect(items).toHaveLength(5);
    expect(items[0]!.textContent).toContain("this day");
    expect(items[1]!.textContent).toContain("PR");
    expect(items[1]!.textContent).toContain("beat 4:40");
    expect(items[3]!.textContent).toContain("beat 5:10");
    expect(within(dialog).getByText(/results/).textContent).toMatch(/5 results · 2 PRs · newest first/);
  });
});
