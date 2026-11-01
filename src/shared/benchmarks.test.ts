import { describe, expect, it } from "vitest";
import { benchmarkBest, benchmarkHistory, benchmarkNames, benchmarkPrs, isBetterScore, normalizeBenchmark, parseScore } from "./benchmarks";
import { emptyDayLog, type DayLog } from "./schemas";

const metcon = (date: string, name: string | null, score: string | null): DayLog => ({
  ...emptyDayLog(date),
  metconDone: true,
  metconBenchmark: name,
  metconScore: score,
});

describe("normalizeBenchmark", () => {
  it("trims, case-folds and collapses spaces", () => {
    expect(normalizeBenchmark("  Fran ")).toBe("fran");
    expect(normalizeBenchmark("Fight   Gone\tBad")).toBe("fight gone bad");
  });
});

describe("parseScore", () => {
  it("reads times (lower is better)", () => {
    expect(parseScore("3:45")).toEqual({ kind: "time", value: 225 });
    expect(parseScore(" 1:02:03 ")).toEqual({ kind: "time", value: 3723 });
    expect(parseScore("45:00")).toEqual({ kind: "time", value: 2700 });
    expect(parseScore("3:75")).toBeNull();
    expect(parseScore("0:00")).toBeNull();
  });

  it("reads rounds + reps, loads and reps", () => {
    expect(parseScore("12+4")).toEqual({ kind: "rounds", value: 12004 });
    expect(parseScore("12 + 4")).toEqual({ kind: "rounds", value: 12004 });
    expect(parseScore("20 rounds")).toEqual({ kind: "rounds", value: 20000 });
    expect(parseScore("225 lb")).toEqual({ kind: "load", value: 225 });
    expect(parseScore("225lbs")).toEqual({ kind: "load", value: 225 });
    expect(parseScore("100 kg")).toEqual({ kind: "load", value: 220.5 });
    expect(parseScore("150")).toEqual({ kind: "reps", value: 150 });
    expect(parseScore("150 reps")).toEqual({ kind: "reps", value: 150 });
  });

  it("returns null for anything else", () => {
    for (const s of ["", "0", "0.5", "Rx", "DNF", "3:45 Rx", "12+", "-5", "lb"]) expect(parseScore(s), s).toBeNull();
  });

  it("compares like with like, and a finish beats a capped score", () => {
    const t = (v: number) => ({ kind: "time" as const, value: v });
    expect(isBetterScore(t(200), t(225))).toBe(true);
    expect(isBetterScore(t(225), t(200))).toBe(false);
    expect(isBetterScore({ kind: "rounds", value: 12005 }, { kind: "rounds", value: 12004 })).toBe(true);
    expect(isBetterScore(t(900), { kind: "rounds", value: 30000 })).toBe(true);
    expect(isBetterScore({ kind: "rounds", value: 30000 }, t(900))).toBe(false);
    expect(isBetterScore({ kind: "load", value: 300 }, { kind: "reps", value: 10 })).toBe(false);
  });
});

describe("benchmark history", () => {
  const days = [
    metcon("2026-11-20", "fran", "3:40"),
    metcon("2026-11-02", "Fran", "4:02"),
    metcon("2026-11-09", " FRAN ", "Rx, felt slow"),
    metcon("2026-11-12", "Murph", "45:10"),
    metcon("2026-11-13", "Cindy", null), // no score: not history, but still a name
    metcon("2026-11-14", null, "3:00"),
  ];

  it("groups by normalized name, oldest first, keeping unparseable scores", () => {
    const h = benchmarkHistory(days);
    expect([...h.keys()].sort()).toEqual(["fran", "murph"]);
    expect(h.get("fran")!.map((e) => [e.date, e.name, e.score, e.parsed?.value ?? null])).toEqual([
      ["2026-11-02", "Fran", "4:02", 242],
      ["2026-11-09", "FRAN", "Rx, felt slow", null],
      ["2026-11-20", "fran", "3:40", 220],
    ]);
  });

  it("finds the best result, optionally before a date", () => {
    expect(benchmarkBest(days, "FRAN")?.score).toBe("3:40");
    expect(benchmarkBest(days, "fran", "2026-11-20")?.score).toBe("4:02");
    expect(benchmarkBest(days, "fran", "2026-11-02")).toBeNull();
    expect(benchmarkBest(days, "Grace")).toBeNull();
  });

  it("lists names for autocomplete, most recent first, one per benchmark", () => {
    expect(benchmarkNames(days)).toEqual(["fran", "Cindy", "Murph"]);
  });

  it("reports PRs against the previous best only", () => {
    const prs = benchmarkPrs([...days, metcon("2026-11-27", "Fran", "3:50"), metcon("2026-12-04", "Fran", "3:30")]);
    expect(prs.map((p) => [p.key, p.entry.score, p.previous.score])).toEqual([
      ["bench-fran-2026-11-20", "3:40", "4:02"],
      ["bench-fran-2026-12-04", "3:30", "3:40"],
    ]);
  });

  it("keeps achievement keys within the 120-character limit", () => {
    const long = "x".repeat(120);
    const [pr] = benchmarkPrs([metcon("2026-11-02", long, "10"), metcon("2026-11-09", long, "11")]);
    expect(pr!.key.length).toBeLessThanOrEqual(120);
  });
});
