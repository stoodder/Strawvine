import { describe, expect, it } from "vitest";
import { addDays, dateRange, daysBetween, fromDayNumber, isISODate, startOfWeek, toDayNumber, weekdayOf } from "./dates";

// The original Date-based implementation the integer fast path must match exactly.
const DAY_MS = 86_400_000;
const refToUTC = (d: string) => Date.parse(`${d}T00:00:00Z`);
const refAddDays = (d: string, n: number) => new Date(refToUTC(d) + n * DAY_MS).toISOString().slice(0, 10);

describe("day-number fast path", () => {
  it("matches Date for every day from 1600 to 3200", () => {
    const mismatches: string[] = [];
    let date = "1600-01-01";
    for (let n = toDayNumber(date); date < "3200-01-01"; n++) {
      const ok =
        toDayNumber(date) === refToUTC(date) / DAY_MS &&
        fromDayNumber(n) === date &&
        weekdayOf(date) === new Date(refToUTC(date)).getUTCDay();
      if (!ok) mismatches.push(date);
      date = refAddDays(date, 1);
    }
    expect(mismatches).toEqual([]);
  });

  it("keeps Date.parse's behaviour for odd input", () => {
    for (const d of ["2026-02-30", "2026-02-31", "2026-04-31", "0000-01-01", "0099-03-01", "9999-12-31"]) {
      expect(addDays(d, 1), d).toBe(refAddDays(d, 1));
      expect(addDays(d, -400), d).toBe(refAddDays(d, -400));
      expect(addDays(d, 0.5), d).toBe(refAddDays(d, 0.5));
    }
    expect(addDays("9999-12-31", 1)).toBe(refAddDays("9999-12-31", 1));
    for (const bad of ["2026-02-32", "2026-13-01", "2026-1-01", "x", ""]) {
      expect(toDayNumber(bad)).toBeNaN();
      expect(() => addDays(bad, 1)).toThrow(RangeError);
      expect(weekdayOf(bad)).toBeNaN();
    }
  });

  it("does calendar arithmetic", () => {
    expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2);
    expect(daysBetween("2026-11-01", "2025-11-01")).toBe(-365);
    expect(startOfWeek("2026-11-01")).toBe("2026-10-26");
    expect(dateRange("2026-12-30", "2027-01-02")).toEqual(["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]);
    expect(dateRange("2027-01-02", "2026-12-30")).toEqual([]);
  });
});

describe("isISODate", () => {
  it("accepts real dates between 1900 and 2999 only", () => {
    expect(isISODate("2026-11-01")).toBe(true);
    expect(isISODate("1900-01-01")).toBe(true);
    expect(isISODate("2999-12-31")).toBe(true);
    expect(isISODate("1899-12-31")).toBe(false);
    expect(isISODate("3000-01-01")).toBe(false);
    expect(isISODate("0202-11-01")).toBe(false);
    expect(isISODate("2026-02-29")).toBe(false);
    expect(isISODate("2026-11-01\u0000")).toBe(false);
  });
});
