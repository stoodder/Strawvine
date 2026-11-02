import { describe, expect, it } from "vitest";
import { formatRest, parseRest } from "./restTime";

describe("rest time", () => {
  it("formats seconds as m:ss", () => {
    expect(formatRest(180)).toBe("3:00");
    expect(formatRest(75)).toBe("1:15");
    expect(formatRest(10)).toBe("0:10");
    expect(formatRest(900)).toBe("15:00");
    expect(formatRest(89.6)).toBe("1:30");
  });

  it("parses m:ss, plain seconds and unit forms", () => {
    expect(parseRest("3:00")).toBe(180);
    expect(parseRest(" 1:30 ")).toBe(90);
    expect(parseRest("180")).toBe(180);
    expect(parseRest("90s")).toBe(90);
    expect(parseRest("3m")).toBe(180);
    expect(parseRest("2m30s")).toBe(150);
    expect(parseRest("2 min 30")).toBe(150);
    expect(parseRest("0:45")).toBe(45);
  });

  it("rejects what isn't a time", () => {
    expect(parseRest("")).toBeNull();
    expect(parseRest("3:75")).toBeNull();
    expect(parseRest("3:5")).toBeNull();
    expect(parseRest("abc")).toBeNull();
    expect(parseRest("-30")).toBeNull();
    expect(parseRest("1.5")).toBeNull();
    expect(parseRest("2m75s")).toBeNull();
  });

  it("round-trips", () => {
    for (const s of [10, 59, 60, 61, 125, 180, 900]) expect(parseRest(formatRest(s))).toBe(s);
  });
});
