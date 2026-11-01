import { describe, expect, it } from "vitest";
import { formatSleep, parseSleep } from "./sleep";

describe("parseSleep", () => {
  it.each([
    ["7:30", 450],
    ["7h30", 450],
    ["7h30m", 450],
    ["7.30", 450],
    ["7,30", 450],
    ["7.05", 425],
    ["730", 450],
    ["1015", 615],
    ["7", 420],
    ["7h", 420],
    ["7.5", 450],
    ["7,5", 450],
    ["7.75", 465],
    ["450m", 450],
    ["450 min", 450],
    [" 8:00 ", 480],
  ])("%s → %d min", (input, minutes) => {
    expect(parseSleep(input)).toBe(minutes);
  });

  it("treats an empty entry as cleared", () => {
    expect(parseSleep("")).toBeNull();
    expect(parseSleep("   ")).toBeNull();
  });

  it.each(["abc", "7:75", "775", "25", "25:00", "2000m", "7.3.0"])("rejects %s", (input) => {
    expect(parseSleep(input)).toBeUndefined();
  });
});

describe("formatSleep", () => {
  it("renders h:mm", () => {
    expect(formatSleep(450)).toBe("7:30");
    expect(formatSleep(425)).toBe("7:05");
    expect(formatSleep(null)).toBe("");
  });
});
